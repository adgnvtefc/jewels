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
    GET    /api/notifications                            -> {messages, puzzles, finished}: which kinds get texts
    PUT    /api/notifications {messages?, puzzles?, finished?}  -> all three (true or false)
    POST   /api/jobs      {prompt}                       -> 202 {id}
    GET    /api/jobs/<id>                                -> status, then images and which setup made each (variants)
    GET    /api/health                                   -> {model: "ready" | "loading" | "error"}

Texts about unread messages go out through textbot's notify service on this Mac
(~/projects/textbot/notify.py), by account ID; textbot holds the phone numbers.

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
import texts  # noqa: E402
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
# The Create puzzle test (CREATE_TEST=1): half the pictures are painted from the artist's
# subject as usual ("today"), half from the player's words exactly as typed ("typed"); the
# game converts the "typed" ones with its lighter, feature-keeping conversion. Each job's
# pictures are saved in data/create-test/ to compare later. Off: all four are "today".
CREATE_TEST = os.environ.get("CREATE_TEST", "0") == "1"
CREATE_TEST_DIR = ROOT / "data" / "create-test"

# Texts about unread chat messages (chat.due_notices has the rule; texts.py sends them).
NOTICE_CHECK_SECONDS = 60

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


def picture_png(image) -> bytes:
    # The converter works from a 128x128 grid, so 256px is plenty and keeps responses small.
    from PIL import Image

    image = image.convert("RGB").resize((256, 256), Image.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def data_url(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png).decode()


def paint_plan(idea: str, subject: str) -> list[tuple[str, str]]:
    """What to paint for one job: (variant, prompt) per picture, in the order they're shown."""
    today = ("today", f"{subject}, one subject centered, {STYLE}")
    if not CREATE_TEST:
        return [today] * CANDIDATES
    typed = ("typed", f"{idea}, one subject centered, {STYLE}")
    return [today] * (CANDIDATES // 2) + [typed] * (CANDIDATES - CANDIDATES // 2)


def save_test_job(job_id: str, job: dict, subject: str, plan: list[tuple[str, str]], pictures: list[bytes]) -> None:
    """Keep a test job's pictures and what made them, to look at side by side later."""
    folder = CREATE_TEST_DIR / job_id
    folder.mkdir(parents=True, exist_ok=True)
    for n, png in enumerate(pictures):
        (folder / f"{n}-{plan[n][0]}.png").write_bytes(png)
    (folder / "job.json").write_text(json.dumps({
        "idea": job["prompt"], "subject": subject, "account": job["account"], "at": int(time.time()),
        "pictures": [{"file": f"{n}-{variant}.png", "variant": variant, "prompt": prompt} for n, (variant, prompt) in enumerate(plan)],
    }, indent=1))


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
            plan = paint_plan(jobs[job_id]["prompt"], subject)
            update(job_id, status="painting", subject=subject, agent=from_agent)
            pictures = []
            for _, prompt in plan:
                result = model.generate_image(seed=random.randrange(2**31), prompt=prompt,
                                              num_inference_steps=8, width=512, height=512)
                pictures.append(picture_png(result.image))
                update(job_id, painted=len(pictures))
            if CREATE_TEST:
                try:
                    save_test_job(job_id, jobs[job_id], subject, plan, pictures)
                except OSError:
                    traceback.print_exc()  # keeping a copy must never cost the player their pictures
            update(job_id, status="done", images=[data_url(png) for png in pictures], variants=[v for v, _ in plan],
                   seconds=round(time.time() - started, 1))
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
        view["variants"] = job.get("variants")
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
        if path not in ("/api/me", "/api/saves", "/api/messages", "/api/notifications") and not match:
            return self.send(404, {"error": "Not found."})
        if not (me := self.account()):
            return
        if path == "/api/me":
            return self.send(200, {"name": me["name"], "friends": accounts.friends_of(db, me["id"]), "unread": chat.unread(db, me["id"])})
        if path == "/api/notifications":
            return self.send(200, chat.notify_settings(db, me["id"]))
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
        if path not in ("/api/saves", "/api/notifications"):
            return self.send(404, {"error": "Not found."})
        if not (me := self.account()):
            return
        if path == "/api/notifications":
            return self.send(*chat.set_notify_settings(db, me["id"], self.body()))
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


def send_notices(now: int | None = None) -> int:
    """One check: text everyone who is due, once each. Never raises; returns how many were sent."""
    if not texts.token():  # no token: texts are off
        return 0
    sent = 0
    for notice in chat.due_notices(db, now):
        who = notice["account_id"]
        # Marked before sending: one try per message, even if textbot is down or answers 404/429.
        chat.mark_noticed(db, who, notice["up_to"])
        try:
            texts.text_player(who, notice["text"])
            sent += 1
            print(f"texted account {who} about unread chat", flush=True)
        except Exception as error:  # textbot not running, timed out, 404, 429, anything
            print(f"text to account {who} not sent: {texts.why(error)}", flush=True)
    return sent


def notice_loop() -> None:
    """Runs in the background: checks for due texts once a minute."""
    while True:
        time.sleep(NOTICE_CHECK_SECONDS)
        try:
            send_notices()
        except Exception:  # e.g. the database was busy: try again next minute
            traceback.print_exc()


def main() -> None:
    global db
    db = Database()
    if not db.one("SELECT 1 FROM accounts"):
        print("No accounts yet: add them with accounts.py (see its docstring).", flush=True)
    print(f"backed up to {db.backup()}", flush=True)
    threading.Thread(target=db.back_up_daily, daemon=True).start()
    if USE_MODEL:
        threading.Thread(target=worker, daemon=True).start()
    if texts.token():
        threading.Thread(target=notice_loop, daemon=True).start()
    print(f"texts about unread messages: {'on' if texts.token() else 'off (no TEXTBOT_NOTIFY_TOKEN)'}", flush=True)
    print(f"Create puzzle test: {'on (2 today + 2 as typed)' if CREATE_TEST else 'off'}", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Pixel Game server on http://127.0.0.1:{PORT} (agent={'on' if USE_AGENT else 'off'}, data={db.path})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
