"""Picture generator for Little Jewel's "Create your own" puzzles.

Runs on the Mac. A small HTTP API, usable only with the password in server/.env:
the harness agent turns an idea into one drawable subject, Z-Image Turbo paints a
few candidates, and the game converts the chosen picture into a puzzle in the browser.

    POST /api/unlock     {"password": "..."}            -> 200 {"ok": true} or 401
    POST /api/jobs       {"prompt": "..."}  + Bearer    -> 202 {"id": "..."}
    GET  /api/jobs/<id>                     + Bearer    -> status, then images
    GET  /api/health                                    -> {"model": "ready" | "loading" | "error"}
"""

import base64
import hmac
import io
import json
import os
import queue
import random
import re
import threading
import time
import traceback
import uuid
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
# The harness, used as a library, reads its model server key from the environment.
load_dotenv((ROOT / os.environ.get("HARNESS_ENV", "../../harness/.env")).resolve())

PASSWORD = os.environ.get("JEWELS_PASSWORD", "")
PORT = int(os.environ.get("PORT", "8787"))
ORIGINS = {o.strip() for o in os.environ.get(
    "ALLOWED_ORIGINS", "https://momoswebsiteofthehour.com,http://localhost:4173,http://127.0.0.1:4173").split(",") if o.strip()}
MODEL_PATH = os.environ.get("MODEL_PATH", "filipstrand/Z-Image-Turbo-mflux-4bit")
USE_AGENT = os.environ.get("USE_AGENT", "1") != "0"

CANDIDATES = 4
MAX_WAITING = 5
MAX_PROMPT = 200
MAX_BODY = 4096
KEEP_JOBS = 30
# Bold, flat, outlined icons on a plain background survive the trip down to 32x32.
STYLE = ("flat vector icon style, bold simple shapes, thick dark outlines, at most 8 flat colors, "
         "no gradients, no text, plain solid light background")

jobs: dict[str, dict] = {}
waiting: queue.Queue[str] = queue.Queue()
lock = threading.Lock()
model_state = {"status": "loading", "error": None}
failures: deque[float] = deque()


def subject_for(idea: str) -> tuple[str, bool]:
    """Ask the harness agent for one drawable subject; fall back to the idea itself."""
    if not USE_AGENT:
        return idea, False
    try:
        from harness.config import Project
        from harness.orchestrator import new_conversation

        answer = new_conversation("artist", project=Project.at(ROOT)).turn(idea).answer
        answer = re.sub(r"<think>.*?</think>", "", answer or "", flags=re.S).strip()
        line = next((l.strip(" \"'`*") for l in answer.splitlines() if l.strip()), "").rstrip(".")
        if line:
            return line[:160], True
    except Exception:
        traceback.print_exc()
    return idea, False


def picture_data_url(image) -> str:
    # The converter works from a 128x128 grid, so 256px is plenty and keeps responses small.
    from PIL import Image

    image = image.convert("RGB").resize((256, 256), Image.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


def update(job_id: str, **fields) -> None:
    with lock:
        jobs[job_id].update(fields)


def worker() -> None:
    # MLX runs on this one thread: load once, then paint jobs in order.
    try:
        from mflux.models.common.config import ModelConfig
        from mflux.models.z_image import ZImage

        model = ZImage(model_config=ModelConfig.z_image_turbo(), model_path=MODEL_PATH)
        model_state["status"] = "ready"
        print(f"model ready: {MODEL_PATH}", flush=True)
    except Exception as error:
        traceback.print_exc()
        model_state.update(status="error", error=str(error))
        return
    while True:
        job_id = waiting.get()
        try:
            started = time.time()
            update(job_id, status="writing")
            subject, from_agent = subject_for(jobs[job_id]["prompt"])
            prompt = f"{subject}, one subject centered, {STYLE}"
            update(job_id, status="painting", subject=subject, agent=from_agent)
            images = []
            for _ in range(CANDIDATES):
                result = model.generate_image(seed=random.randrange(2**31), prompt=prompt,
                                              num_inference_steps=8, width=512, height=512)
                images.append(picture_data_url(result.image))
                update(job_id, painted=len(images))
            update(job_id, status="done", images=images, seconds=round(time.time() - started, 1))
            print(f"job {job_id}: {subject!r} in {time.time() - started:.1f}s (agent={from_agent})", flush=True)
        except Exception as error:
            traceback.print_exc()
            update(job_id, status="error", error=str(error)[:200])


def public_view(job: dict) -> dict:
    view = {k: job.get(k) for k in ("id", "status", "subject", "agent", "painted", "error", "seconds")}
    view["total"] = CANDIDATES
    if job["status"] == "queued":
        with lock:
            ahead = [j for j in jobs.values() if j["status"] in ("queued", "writing", "painting") and j["created"] < job["created"]]
        view["ahead"] = len(ahead)
    if job["status"] == "done":
        view["images"] = job["images"]
    return view


class Handler(BaseHTTPRequestHandler):
    server_version = "LittleJewel/1"

    def send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        origin = self.headers.get("Origin")
        if origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        origin = self.headers.get("Origin")
        if origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def body(self) -> dict | None:
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_BODY:
            return None
        try:
            data = json.loads(self.rfile.read(length))
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def locked_out(self) -> bool:
        # Throttle guessing: after 20 wrong passwords in 10 minutes, refuse everyone for a while.
        now = time.time()
        while failures and failures[0] < now - 600:
            failures.popleft()
        return len(failures) >= 20

    def check(self, password: str) -> bool:
        if self.locked_out():
            self.send(429, {"error": "Too many attempts. Try again later."})
            return False
        if PASSWORD and hmac.compare_digest(password.encode(), PASSWORD.encode()):
            return True
        failures.append(time.time())
        time.sleep(0.5)
        self.send(401, {"error": "That password didn't work."})
        return False

    def bearer(self) -> bool:
        header = self.headers.get("Authorization", "")
        return self.check(header[7:] if header.startswith("Bearer ") else "")

    def do_GET(self) -> None:
        if self.path == "/api/health":
            return self.send(200, {"model": model_state["status"], "agent": USE_AGENT})
        match = re.fullmatch(r"/api/jobs/([0-9a-f]{32})", self.path)
        if not match:
            return self.send(404, {"error": "Not found."})
        if not self.bearer():
            return
        with lock:
            job = jobs.get(match[1])
        if not job:
            return self.send(404, {"error": "That request has expired. Please try again."})
        self.send(200, public_view(job))

    def do_POST(self) -> None:
        if self.path not in ("/api/unlock", "/api/jobs"):
            return self.send(404, {"error": "Not found."})
        data = self.body()
        if data is None:
            return self.send(400, {"error": "Bad request."})
        if self.path == "/api/unlock":
            if self.check(str(data.get("password", ""))):
                self.send(200, {"ok": True})
            return
        if not self.bearer():
            return
        prompt = " ".join(str(data.get("prompt", "")).split())[:MAX_PROMPT]
        if not prompt:
            return self.send(400, {"error": "Describe what you'd like to make."})
        if model_state["status"] == "error":
            return self.send(503, {"error": "The picture model failed to load."})
        with lock:
            if sum(j["status"] in ("queued", "writing", "painting") for j in jobs.values()) >= MAX_WAITING:
                return self.send(429, {"error": "Busy right now. Try again in a minute."})
            job_id = uuid.uuid4().hex
            jobs[job_id] = {"id": job_id, "prompt": prompt, "status": "queued", "painted": 0, "created": time.time()}
            for old in sorted(jobs.values(), key=lambda j: j["created"])[:-KEEP_JOBS]:
                if old["status"] in ("done", "error"):
                    del jobs[old["id"]]
        waiting.put(job_id)
        self.send(202, {"id": job_id})

    def log_message(self, format: str, *args) -> None:
        print(f"{self.address_string()} {format % args}", flush=True)


def main() -> None:
    if not PASSWORD:
        raise SystemExit("Set JEWELS_PASSWORD in server/.env (see .env.example).")
    threading.Thread(target=worker, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Little Jewel generator on http://127.0.0.1:{PORT} (agent={'on' if USE_AGENT else 'off'})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
