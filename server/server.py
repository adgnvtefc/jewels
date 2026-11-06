"""Pixel Game's server on the Mac: accounts, saves, chat, and the picture generator.

Data lives in one SQLite file (db.py). Accounts are added on the Mac (accounts.py);
everything but signing in and the health check needs `Authorization: Bearer <token>`.

    POST   /api/login     {name, password}               -> {token, name, friends, expires_at}, 401 or 429
    POST   /api/logout    {everywhere?}                  -> {ok}
    GET    /api/me                                       -> {name, friends, unread}
    GET    /api/saves?since=<rev>                        -> saves and library rows changed since rev (saves.py)
    PUT    /api/saves     {saves: [{puzzle, state, based_on}]}  -> {rev, results, rejected}
    POST   /api/puzzles   {art}                          -> store a puzzle you made, or bring back one you have
    DELETE /api/puzzles/<id>                             -> remove it from your Free play
    GET    /api/messages?after=<id> | ?before=<id>       -> {messages, puzzles, unread, start} (chat.py)
    POST   /api/messages  {to, text | puzzle, client_id} -> {message}
    POST   /api/messages/read {friend, up_to}            -> {unread}
    POST   /api/jobs      {prompt}                       -> 202 {id}
    GET    /api/jobs/<id>                                -> status, then images
    GET    /api/health                                   -> {model: "ready" | "loading" | "error"}

Making a picture: one model call through orchestra's chat() turns an idea into one
drawable subject (the prompt is agents/artist.md), Z-Image Turbo paints a few candidates,
and the game converts the chosen picture into a puzzle in the browser.
"""

import base64
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
from urllib.parse import parse_qs, urlsplit

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
# orchestra (the harness repo), used as a library, reads its model server key from the environment.
load_dotenv((ROOT / os.environ.get("HARNESS_ENV", "../../harness/.env")).resolve())

import accounts  # noqa: E402  (after .env, so DB_FILE can come from it)
import chat  # noqa: E402
import saves  # noqa: E402
from db import Database  # noqa: E402

PORT = int(os.environ.get("PORT", "8787"))
ORIGINS = {o.strip() for o in os.environ.get(
    "ALLOWED_ORIGINS", "https://momoswebsiteofthehour.com,http://localhost:4173,http://127.0.0.1:4173").split(",") if o.strip()}
MODEL_PATH = os.environ.get("MODEL_PATH", "filipstrand/Z-Image-Turbo-mflux-4bit")
USE_AGENT = os.environ.get("USE_AGENT", "1") != "0"
USE_MODEL = os.environ.get("USE_MODEL", "1") != "0"  # 0: no picture model (for tests)
ARTIST = ROOT / "agents" / "artist.md"
# The reply is one short line; the rest of the budget is for the model's thinking.
ARTIST_MAX_TOKENS = 2048

CANDIDATES = 4
MAX_WAITING = 5
MAX_PROMPT = 200
MAX_BODY = 16 * 1024
MAX_SAVES_BODY = 2 * 1024 * 1024
KEEP_JOBS = 30
# Bold, flat, outlined icons on a plain background survive the trip down to 32x32.
STYLE = ("flat vector icon style, bold simple shapes, thick dark outlines, at most 8 flat colors, "
         "no gradients, no text, plain solid light background")

db: Database | None = None
jobs: dict[str, dict] = {}
waiting: queue.Queue[str] = queue.Queue()
lock = threading.Lock()
model_state = {"status": "loading" if USE_MODEL else "off", "error": None}
failures: deque[float] = deque()


def read_artist() -> tuple[dict, str]:
    """agents/artist.md: `key: value` settings between '---' lines, then the system prompt."""
    _, settings, prompt = ARTIST.read_text().split("---\n", 2)
    pairs = (line.split(":", 1) for line in settings.splitlines() if ":" in line)
    return {key.strip(): value.strip() for key, value in pairs}, prompt.strip()


def subject_for(idea: str, job_id: str, account: str) -> tuple[str, bool]:
    """Ask the artist for one drawable subject; fall back to the idea itself."""
    if not USE_AGENT:
        return idea, False
    try:
        from orchestra import chat as model_chat

        settings, prompt = read_artist()
        reply = model_chat(app="jewels", model=settings["model"],
                           temperature=float(settings["temperature"]) if "temperature" in settings else None,
                           max_tokens=ARTIST_MAX_TOKENS, metadata={"job": job_id, "account": account},
                           messages=[{"role": "system", "content": prompt}, {"role": "user", "content": idea}])
        if reply.finish_reason == "length":  # cut off: whatever came back isn't a finished subject
            print(f"job {job_id}: the artist ran out of tokens; using the idea as written", flush=True)
            return idea, False
        answer = re.sub(r"<think>.*?</think>", "", reply.content or "", flags=re.S).strip()
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
            subject, from_agent = subject_for(jobs[job_id]["prompt"], job_id, jobs[job_id]["account"])
            prompt = f"{subject}, one subject centered, {STYLE}"
            update(job_id, status="painting", subject=subject, agent=from_agent)
            images = []
            for _ in range(CANDIDATES):
                result = model.generate_image(seed=random.randrange(2**31), prompt=prompt,
                                              num_inference_steps=8, width=512, height=512)
                images.append(picture_data_url(result.image))
                update(job_id, painted=len(images))
            update(job_id, status="done", images=images, seconds=round(time.time() - started, 1))
            print(f"job {job_id} ({jobs[job_id]['account']}): {subject!r} in {time.time() - started:.1f}s (agent={from_agent})", flush=True)
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


def locked_out() -> bool:
    # Throttle guessing: after 20 wrong passwords in 10 minutes, refuse all sign-ins for a while.
    now = time.time()
    while failures and failures[0] < now - 600:
        failures.popleft()
    return len(failures) >= 20


class Handler(BaseHTTPRequestHandler):
    server_version = "LittleJewel/2"

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
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def body(self, limit: int = MAX_BODY) -> dict | None:
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= limit:
            return None
        try:
            data = json.loads(self.rfile.read(length))
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def token(self) -> str:
        header = self.headers.get("Authorization", "")
        return header[7:] if header.startswith("Bearer ") else ""

    def account(self) -> dict | None:
        """The signed-in account, or None after answering 401."""
        found = accounts.session_account(db, self.token())
        if not found:
            self.send(401, {"error": "Please sign in again."})
        return found

    def route(self) -> tuple[str, dict]:
        parts = urlsplit(self.path)
        return parts.path, {k: v[-1] for k, v in parse_qs(parts.query).items()}

    def do_GET(self) -> None:
        path, query = self.route()
        if path == "/api/health":
            return self.send(200, {"model": model_state["status"], "agent": USE_AGENT})
        match = re.fullmatch(r"/api/jobs/([0-9a-f]{32})", path)
        if path not in ("/api/me", "/api/saves", "/api/messages") and not match:
            return self.send(404, {"error": "Not found."})
        if not (me := self.account()):
            return
        if path == "/api/me":
            return self.send(200, {"name": me["name"], "friends": accounts.friends_of(db, me["id"]), "unread": chat.unread(db, me["id"])})
        try:
            numbers = {k: int(v) for k, v in query.items() if k in ("since", "after", "before")}
        except ValueError:
            return self.send(400, {"error": "Bad request."})
        if path == "/api/saves":
            return self.send(200, saves.changes(db, me["id"], numbers.get("since", 0)))
        if path == "/api/messages":
            return self.send(200, chat.messages(db, me["id"], after=numbers.get("after"), before=numbers.get("before")))
        with lock:
            job = jobs.get(match[1])
        if not job or job["account"] != me["name"]:
            return self.send(404, {"error": "That request has expired. Please try again."})
        self.send(200, public_view(job))

    def do_POST(self) -> None:
        path, _ = self.route()
        if path not in ("/api/login", "/api/logout", "/api/jobs", "/api/puzzles", "/api/messages", "/api/messages/read"):
            return self.send(404, {"error": "Not found."})
        data = self.body()
        if data is None:
            return self.send(400, {"error": "Bad request."})
        if path == "/api/login":
            return self.login(data)
        if not (me := self.account()):
            return
        if path == "/api/logout":
            accounts.logout(db, self.token(), everywhere=data.get("everywhere") is True)
            return self.send(200, {"ok": True})
        if path == "/api/puzzles":
            return self.send(*saves.add_puzzle(db, me["id"], data.get("art")))
        if path == "/api/messages":
            return self.send(*chat.send(db, me["id"], data))
        if path == "/api/messages/read":
            return self.send(*chat.mark_read(db, me["id"], data))
        self.start_job(data, me)

    def login(self, data: dict) -> None:
        if locked_out():
            return self.send(429, {"error": "Too many attempts. Try again later."})
        session = accounts.login(db, data.get("name"), data.get("password"), self.headers.get("User-Agent", ""))
        if not session:
            failures.append(time.time())
            time.sleep(0.5)
            return self.send(401, {"error": "That name and password don't match."})
        self.send(200, session)

    def start_job(self, data: dict, me: dict) -> None:
        prompt = " ".join(str(data.get("prompt", "")).split())[:MAX_PROMPT]
        if not prompt:
            return self.send(400, {"error": "Describe what you'd like to make."})
        if model_state["status"] in ("error", "off"):
            return self.send(503, {"error": "The picture model isn't available."})
        with lock:
            if sum(j["status"] in ("queued", "writing", "painting") for j in jobs.values()) >= MAX_WAITING:
                return self.send(429, {"error": "Busy right now. Try again in a minute."})
            job_id = uuid.uuid4().hex
            jobs[job_id] = {"id": job_id, "prompt": prompt, "account": me["name"], "status": "queued", "painted": 0, "created": time.time()}
            for old in sorted(jobs.values(), key=lambda j: j["created"])[:-KEEP_JOBS]:
                if old["status"] in ("done", "error"):
                    del jobs[old["id"]]
        waiting.put(job_id)
        self.send(202, {"id": job_id})

    def do_PUT(self) -> None:
        path, _ = self.route()
        if path != "/api/saves":
            return self.send(404, {"error": "Not found."})
        if not (me := self.account()):
            return
        body = self.body(MAX_SAVES_BODY)
        if body is None:
            return self.send(400, {"error": "Bad request."})
        self.send(*saves.put_saves(db, me["id"], body.get("saves")))

    def do_DELETE(self) -> None:
        path, _ = self.route()
        match = re.fullmatch(r"/api/puzzles/([A-Za-z0-9-]{1,64})", path)
        if not match:
            return self.send(404, {"error": "Not found."})
        if not (me := self.account()):
            return
        if not saves.remove_puzzle(db, me["id"], match[1]):
            return self.send(404, {"error": "Not found."})
        self.send(200, {"ok": True})

    def log_message(self, format: str, *args) -> None:
        print(f"{self.address_string()} {format % args}", flush=True)


def main() -> None:
    global db
    db = Database()
    if not db.one("SELECT 1 FROM accounts"):
        print("No accounts yet: add them with accounts.py (see its docstring).", flush=True)
    print(f"backed up to {db.backup()}", flush=True)
    threading.Thread(target=db.back_up_daily, daemon=True).start()
    if USE_MODEL:
        threading.Thread(target=worker, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Pixel Game server on http://127.0.0.1:{PORT} (agent={'on' if USE_AGENT else 'off'}, data={db.path})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
