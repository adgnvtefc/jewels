"""Pixel Game's server on the Mac: accounts, saves, chat, and the picture generator.

Data lives in one SQLite file (db.py). Accounts are added on the Mac (accounts.py);
everything but signing in and the health check needs `Authorization: Bearer <token>`.

    POST   /api/login     {name, password}               -> {token, id, name, friends, expires_at}, 401 or 429
    POST   /api/logout    {everywhere?}                  -> {ok}
    GET    /api/me                                       -> {id, name, friends, unread, prefs}
    PUT    /api/prefs     {key: change}                  -> the account's settings (prefs.py), e.g. bonus_seen
    GET    /api/saves?since=<rev>                        -> saves and library rows changed since rev (saves.py)
    PUT    /api/saves     {saves: [{puzzle, state, based_on}]}  -> {rev, results, rejected}
    POST   /api/puzzles   {art}                          -> store a puzzle you made, or bring back one you have
    DELETE /api/puzzles/<id>                             -> remove it from your Free play
    GET    /api/messages?after=<id> | ?before=<id>       -> {messages, puzzles, unread, start} (chat.py)
    POST   /api/messages  {to, text | puzzle, client_id} -> {message}
    POST   /api/messages/read {friend, up_to}            -> {unread}
    GET    /api/notifications                            -> {messages, puzzles, finished}: which kinds get texts
    PUT    /api/notifications {messages?, puzzles?, finished?}  -> all three (true or false)
    POST   /api/jobs      {prompt, photo?}               -> 202 {id}
    POST   /api/gauntlet                                 -> 202 {id}: five word-soup puzzles (a ready one at once, if made ahead)
    GET    /api/jobs/<id>                                -> status, then candidates (create) or puzzles (gauntlet), as puzzle art
    GET    /api/health                                   -> {model: "ready" | "loading" | "error"}

Texts about unread messages go out through textbot's notify service on this Mac
(~/projects/textbot/notify.py), by account ID; textbot holds the phone numbers.

Making puzzles (generator.py): every puzzle comes from one pipeline of wording (the idea as
typed, the artist's rewrite, or a word soup), a Z-Image picture, and a converter (convert.js,
run here in Node, or painter v3). The server hands the game finished puzzle art.
"""

import base64
import json
import os
import queue
import re
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
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
import gauntlets  # noqa: E402
import generator  # noqa: E402
import prefs  # noqa: E402
import saves  # noqa: E402
import texts  # noqa: E402
from db import Database  # noqa: E402

PORT = int(os.environ.get("PORT", "8787"))
ORIGINS = {o.strip() for o in os.environ.get(
    "ALLOWED_ORIGINS", "https://momoswebsiteofthehour.com,http://localhost:4173,http://127.0.0.1:4173").split(",") if o.strip()}
MODEL_PATH = os.environ.get("MODEL_PATH", "filipstrand/Z-Image-Turbo-mflux-4bit")
USE_MODEL = os.environ.get("USE_MODEL", "1") != "0"  # 0: no picture model (for tests)

MAX_WAITING = 5
MAX_PROMPT = 200
MAX_BODY = 16 * 1024
MAX_JOB_BODY = 3 * 1024 * 1024  # a create job can carry a photo
MAX_SAVES_BODY = 2 * 1024 * 1024
KEEP_JOBS = 30
# The gauntlet: five puzzles from random "word soups" of familiar, drawable words
# (words.json), each blended into one subject by the artist (generator.py, "soup").
GAUNTLET_SIZE = generator.GAUNTLET_SIZE
# One gauntlet is kept ready for each account (gauntlets.py), made in the background one
# puzzle at a time while nobody is waiting on a picture. GAUNTLET_READY=0 turns that off.
GAUNTLET_READY = os.environ.get("GAUNTLET_READY", "1") != "0"
REFILL_AFTER_ERROR = 300  # seconds to wait before trying again after a failed puzzle
building: dict | None = None  # the gauntlet being made ahead (worker thread only)
refill_paused_until = 0.0
# The artist runs in the background (it doesn't use the picture model), so the picture worker
# only ever spends a couple of seconds painting between players' requests.
writer = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gauntlet-writer")

# Texts about unread chat messages (chat.due_notices has the rule; texts.py sends them).
NOTICE_CHECK_SECONDS = 60

db: Database | None = None
jobs: dict[str, dict] = {}
waiting: queue.Queue[str] = queue.Queue()
lock = threading.Lock()
model_state = {"status": "loading" if USE_MODEL else "off", "error": None}
failures: deque[float] = deque()


def update(job_id: str, **fields) -> None:
    with lock:
        jobs[job_id].update(fields)


def worker() -> None:
    # MLX runs on this one thread: load once, then paint jobs in order.
    try:
        from mflux.models.common.config import ModelConfig
        from mflux.models.z_image import ZImage

        model = ZImage(model_config=ModelConfig.z_image_turbo(), model_path=MODEL_PATH)
        maker = generator.Generator(model)
        model_state["status"] = "ready"
        print(f"model ready: {MODEL_PATH}", flush=True)
        generator.start_painter_test()
    except Exception as error:
        traceback.print_exc()
        model_state.update(status="error", error=str(error))
        return
    while True:
        try:  # a player's request first; otherwise, every few seconds, a step of the next ready gauntlet
            job_id = waiting.get(timeout=0.5 if building else 5)
        except queue.Empty:
            refill_step(maker)
            continue
        try:
            (run_gauntlet if jobs[job_id].get("kind") == "gauntlet" else run_create)(job_id, maker)
        except Exception as error:
            traceback.print_exc()
            update(job_id, status="error", error=str(error)[:200])


def run_create(job_id: str, maker) -> None:
    """Create puzzle: four candidates, from the pipelines create_plan picks (all "current", or
    in the painter test two of each, shuffled). Each pipeline's wording is done once."""
    started, job = time.time(), jobs[job_id]
    plan = generator.create_plan()
    update(job_id, status="writing")
    try:  # the photo is only needed for the artist, and isn't kept a moment longer
        wordings = {name: generator.wording(name, job["prompt"], job["account"], job_id, job.get("photo"))
                    for name in dict.fromkeys(plan)}
    finally:
        job.pop("photo", None)
    current = wordings.get("current") or next(iter(wordings.values()))
    update(job_id, status="painting", subject=current["subject"], agent=current["agent"])
    made = []
    for n, name in enumerate(plan):
        made.append(maker.make(name, wordings[name]))
        update(job_id, painted=n + 1)
    if generator.PAINTER_TEST:
        try:
            generator.save_test_job(job_id, job, current["subject"], made)
        except OSError:
            traceback.print_exc()  # keeping a copy must never cost the player their puzzles
    update(job_id, status="done", seconds=round(time.time() - started, 1), candidates=[generator.shown(m) for m in made])
    print(f"job {job_id} ({job['account']}): {current['subject']!r} in {time.time() - started:.1f}s "
          f"({','.join(m['variant'] for m in made)})", flush=True)


def gauntlet_puzzle(item: dict) -> dict:
    """What a gauntlet keeps of a candidate: its words, subject and puzzle."""
    return {"words": item["words"], "subject": item["subject"], "art": item["art"]}


def run_gauntlet(job_id: str, maker) -> None:
    """Five word-soup puzzles, made one after another while the player waits."""
    started, puzzles, account = time.time(), [], jobs[job_id]["account"]
    for n in range(GAUNTLET_SIZE):
        update(job_id, status="writing", painted=n)
        words = generator.wording("soup", "", account, job_id)
        update(job_id, status="painting", subject=words["subject"])
        puzzles.append(gauntlet_puzzle(maker.make("soup", words)))
        update(job_id, painted=n + 1)
    update(job_id, status="done", puzzles=puzzles, seconds=round(time.time() - started, 1))
    print(f"gauntlet {job_id} ({account}): {[p['subject'] for p in puzzles]} in {time.time() - started:.1f}s", flush=True)


def refill_step(maker) -> bool:
    """One step of the next account's ready gauntlet: start the artist on a soup in the
    background, or paint and convert a soup the artist has finished (a couple of seconds on
    this thread). Stores the gauntlet once all five are made. Returns whether there was
    anything to do."""
    global building, refill_paused_until
    if not GAUNTLET_READY or db is None or time.time() < refill_paused_until:
        return False
    try:
        if building is None:
            need = gauntlets.needing(db)
            if not need:
                return False
            building = {"account_id": need[0][0], "name": need[0][1], "puzzles": [], "started": time.time(), "writing": None}
        if building["writing"] is None:
            building["writing"] = writer.submit(generator.wording, "soup", "", building["name"], f"ready-{building['account_id']}")
        if not building["writing"].done():
            return True  # the artist is still writing; the worker stays free for players
        words = building["writing"].result()
        building["writing"] = None
        building["puzzles"].append(gauntlet_puzzle(maker.make("soup", words)))
        if len(building["puzzles"]) == GAUNTLET_SIZE:
            gauntlets.store(db, building["account_id"], building["puzzles"])
            print(f"gauntlet ready for {building['name']} in {time.time() - building['started']:.0f}s", flush=True)
            building = None
        else:
            building["writing"] = writer.submit(generator.wording, "soup", "", building["name"], f"ready-{building['account_id']}")
    except Exception:
        traceback.print_exc()
        building, refill_paused_until = None, time.time() + REFILL_AFTER_ERROR
    return True


def ready_puzzles(puzzles: list[dict]) -> list[dict]:
    """A ready gauntlet as the game gets it. Ones made before the server converted puzzles
    itself hold pictures; those are converted now."""
    return [p if "art" in p else {"words": p["words"], "subject": p["subject"], "art": generator.converter.convert(
                base64.b64decode(p["image"].split(",", 1)[1]), generator.title_for(", ".join(p["words"]), 80))}
            for p in puzzles]


def public_view(job: dict) -> dict:
    view = {k: job.get(k) for k in ("id", "status", "subject", "agent", "painted", "error", "seconds", "ready")}
    view["total"] = GAUNTLET_SIZE if job.get("kind") == "gauntlet" else generator.CANDIDATES
    if job["status"] == "queued":
        with lock:
            ahead = [j for j in jobs.values() if j["status"] in ("queued", "writing", "painting") and j["created"] < job["created"]]
        view["ahead"] = len(ahead)
    if job["status"] == "done":
        view["puzzles" if "puzzles" in job else "candidates"] = job.get("puzzles") or job.get("candidates")
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
            return self.send(200, {"model": model_state["status"], "agent": generator.USE_AGENT})
        match = re.fullmatch(r"/api/jobs/([0-9a-f]{32})", path)
        if path not in ("/api/me", "/api/saves", "/api/messages", "/api/notifications") and not match:
            return self.send(404, {"error": "Not found."})
        if not (me := self.account()):
            return
        if path == "/api/me":
            return self.send(200, {"id": me["id"], "name": me["name"], "friends": accounts.friends_of(db, me["id"]),
                                   "unread": chat.unread(db, me["id"]), "prefs": prefs.get(db, me["id"])})
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
        if path not in ("/api/login", "/api/logout", "/api/jobs", "/api/gauntlet", "/api/puzzles", "/api/messages", "/api/messages/read"):
            return self.send(404, {"error": "Not found."})
        data = self.body(MAX_JOB_BODY if path == "/api/jobs" else MAX_BODY)
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
        if path == "/api/gauntlet":
            ready = gauntlets.take(db, me["id"]) if GAUNTLET_READY else None
            if ready:  # made ahead: a request that is already done (the worker then makes the next)
                ready = ready_puzzles(ready)
                job_id = uuid.uuid4().hex
                with lock:
                    jobs[job_id] = {"id": job_id, "kind": "gauntlet", "prompt": "gauntlet", "account": me["name"], "status": "done",
                                    "painted": GAUNTLET_SIZE, "puzzles": ready, "seconds": 0, "ready": True, "created": time.time()}
                return self.send(202, {"id": job_id})
            return self.start_job({"prompt": "gauntlet"}, me, kind="gauntlet")
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

    def start_job(self, data: dict, me: dict, kind: str = "create") -> None:
        prompt = " ".join(str(data.get("prompt", "")).split())[:MAX_PROMPT]
        photo = None
        if kind == "create" and data.get("photo") is not None:
            if not (photo := generator.clean_photo(data["photo"])):
                return self.send(400, {"error": "That photo couldn't be read. Try another one."})
        if not prompt and not photo:
            return self.send(400, {"error": "Describe what you'd like to make, or add a photo."})
        if model_state["status"] in ("error", "off"):
            return self.send(503, {"error": "The picture model isn't available."})
        with lock:
            if sum(j["status"] in ("queued", "writing", "painting") for j in jobs.values()) >= MAX_WAITING:
                return self.send(429, {"error": "Busy right now. Try again in a minute."})
            job_id = uuid.uuid4().hex
            jobs[job_id] = {"id": job_id, "kind": kind, "prompt": prompt, "account": me["name"], "status": "queued", "painted": 0, "created": time.time(),
                            **({"photo": photo} if photo else {})}
            for old in sorted(jobs.values(), key=lambda j: j["created"])[:-KEEP_JOBS]:
                if old["status"] in ("done", "error"):
                    del jobs[old["id"]]
        waiting.put(job_id)
        self.send(202, {"id": job_id})

    def do_PUT(self) -> None:
        path, _ = self.route()
        if path not in ("/api/saves", "/api/notifications", "/api/prefs"):
            return self.send(404, {"error": "Not found."})
        if not (me := self.account()):
            return
        if path == "/api/notifications":
            return self.send(*chat.set_notify_settings(db, me["id"], self.body()))
        if path == "/api/prefs":
            return self.send(*prefs.update(db, me["id"], self.body()))
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
    if not generator.PAINTER_TEST:
        print("painter test: off", flush=True)
    print(f"ready gauntlets: {'on, one per account' if GAUNTLET_READY else 'off'}", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Pixel Game server on http://127.0.0.1:{PORT} (agent={'on' if generator.USE_AGENT else 'off'}, data={db.path})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
