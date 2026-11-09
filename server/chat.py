"""Chat between friends: text, sent puzzles, and "finished" notices. Kept forever.

Each message carries a `client_id` the browser made, unique per sender, so a retry after
a dropped connection returns the first copy instead of sending twice.
"""

import json
import re
import time
from collections import defaultdict, deque

from db import Database, now_ms

MAX_TEXT = 1000
PAGE = 50
MAX_NEW = 200
NOTICE_AFTER_MS = 10 * 60 * 1000  # a text goes out this long after the last message, if still unread
PER_MINUTE = 30
CLIENT_ID = re.compile(r"[A-Za-z0-9_-]{8,64}")
# Control characters other than line breaks (and tabs) are dropped.
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")

recent: dict[int, deque] = defaultdict(deque)


def clean_text(text) -> str:
    return CONTROL.sub("", str(text).replace("\r\n", "\n").replace("\r", "\n")).strip()


def too_fast(account_id: int) -> bool:
    now, sent = time.time(), recent[account_id]
    while sent and sent[0] < now - 60:
        sent.popleft()
    if len(sent) >= PER_MINUTE:
        return True
    sent.append(now)
    return False


def view(row, names: dict[int, str]) -> dict:
    message = {"id": row["id"], "from": names.get(row["from_id"]), "to": names.get(row["to_id"]), "kind": row["kind"],
               "client_id": row["client_id"], "at": row["created_at"]}
    if row["kind"] == "text":
        message["text"] = row["body"]
    else:
        message["puzzle"] = row["puzzle_id"]
    if row["kind"] == "finished":
        message["moves"] = row["moves"]
    return message


def _names(db: Database) -> dict[int, str]:
    return {row["id"]: row["name"] for row in db.read("SELECT id, name FROM accounts")}


def friend_id(db: Database, account_id: int, name) -> int | None:
    row = db.one("SELECT f.friend_id FROM friends f JOIN accounts a ON a.id = f.friend_id WHERE f.account_id = ? AND a.name = ?",
                 (account_id, str(name or "").strip().lower()))
    return row["friend_id"] if row else None


def send(db: Database, account_id: int, data: dict) -> tuple[int, dict]:
    """Send `{to, text, client_id}` or `{to, puzzle, client_id}`. -> (status, body)"""
    to = friend_id(db, account_id, data.get("to"))
    client_id = data.get("client_id")
    if to is None:
        return 403, {"error": "You can only message friends."}
    if not isinstance(client_id, str) or not CLIENT_ID.fullmatch(client_id):
        return 400, {"error": "Bad request."}
    existing = db.one("SELECT * FROM messages WHERE from_id = ? AND client_id = ?", (account_id, client_id))
    if existing:
        return 200, {"message": view(existing, _names(db))}
    if "puzzle" in data:
        return _send_puzzle(db, account_id, to, data.get("puzzle"), client_id)
    text = clean_text(data.get("text", ""))
    if not text or len(text) > MAX_TEXT:
        return 400, {"error": f"Messages are 1 to {MAX_TEXT} characters."}
    if too_fast(account_id):
        return 429, {"error": "Slow down a little."}
    with db.transaction() as conn:
        row_id = conn.execute("INSERT INTO messages (from_id, to_id, kind, body, client_id, created_at) VALUES (?, ?, 'text', ?, ?, ?)",
                              (account_id, to, text, client_id, now_ms())).lastrowid
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (row_id,)).fetchone()
    return 201, {"message": view(row, _names(db))}


def _send_puzzle(db: Database, account_id: int, to: int, puzzle_id, client_id: str) -> tuple[int, dict]:
    """Only puzzles you made (and still have) can be sent. The friend gets it in their Free play."""
    if not isinstance(puzzle_id, str):
        return 400, {"error": "Bad request."}
    mine = db.one("SELECT 1 FROM puzzles p JOIN library l ON l.puzzle_id = p.id AND l.account_id = p.creator_id "
                  "WHERE p.id = ? AND p.creator_id = ? AND l.removed_at IS NULL", (puzzle_id, account_id))
    if not mine:
        return 403, {"error": "You can only send puzzles you made."}
    if too_fast(account_id):
        return 429, {"error": "Slow down a little."}
    now = now_ms()
    with db.transaction() as conn:
        row_id = conn.execute("INSERT INTO messages (from_id, to_id, kind, puzzle_id, client_id, created_at) VALUES (?, ?, 'puzzle', ?, ?, ?)",
                              (account_id, to, puzzle_id, client_id, now)).lastrowid
        rev = db.bump(conn, to)
        conn.execute("INSERT INTO library (account_id, puzzle_id, from_id, added_at, rev) VALUES (?, ?, ?, ?, ?) "
                     "ON CONFLICT (account_id, puzzle_id) DO UPDATE SET removed_at = NULL, rev = excluded.rev",
                     (to, puzzle_id, account_id, now, rev))
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (row_id,)).fetchone()
    return 201, {"message": view(row, _names(db)), "art": _arts(db, [puzzle_id]).get(puzzle_id)}


def notify_finished(conn, account_id: int, puzzle_id: str, moves: int | None) -> None:
    """Called inside the save's transaction when a puzzle is first finished: tell whoever sent it, once."""
    sent = conn.execute("SELECT from_id FROM messages WHERE to_id = ? AND kind = 'puzzle' AND puzzle_id = ? ORDER BY id DESC LIMIT 1",
                        (account_id, puzzle_id)).fetchone()
    if not sent:
        return
    conn.execute("INSERT OR IGNORE INTO messages (from_id, to_id, kind, puzzle_id, moves, client_id, created_at) "
                 "VALUES (?, ?, 'finished', ?, ?, ?, ?)",
                 (account_id, sent["from_id"], puzzle_id, moves, f"finished-{puzzle_id}"[:64], now_ms()))


def _arts(db: Database, ids) -> dict[str, dict]:
    ids = sorted({i for i in ids if i})
    if not ids:
        return {}
    rows = db.read(f"SELECT id, art FROM puzzles WHERE id IN ({','.join('?' * len(ids))})", ids)
    return {row["id"]: json.loads(row["art"]) for row in rows}


def unread(db: Database, account_id: int) -> int:
    row = db.one("SELECT count(*) FROM messages m LEFT JOIN chat_reads r ON r.account_id = m.to_id AND r.friend_id = m.from_id "
                 "WHERE m.to_id = ? AND m.id > coalesce(r.last_read_id, 0)", (account_id,))
    return row[0]


def messages(db: Database, account_id: int, after: int | None = None, before: int | None = None) -> dict:
    """Newer messages (after an id, up to 200) or one page of older ones (before an id), oldest first."""
    mine = "(from_id = ? OR to_id = ?)"
    if before is not None:
        rows = db.read(f"SELECT * FROM messages WHERE {mine} AND id < ? ORDER BY id DESC LIMIT ?", (account_id, account_id, before, PAGE))[::-1]
        start = len(rows) < PAGE
    else:
        rows = db.read(f"SELECT * FROM messages WHERE {mine} AND id > ? ORDER BY id DESC LIMIT ?",
                       (account_id, account_id, after or 0, MAX_NEW))[::-1]
        start = not after and len(rows) < MAX_NEW
    names = _names(db)
    return {"messages": [view(row, names) for row in rows], "puzzles": _arts(db, [row["puzzle_id"] for row in rows]),
            "unread": unread(db, account_id), "start": start}


def mark_read(db: Database, account_id: int, data: dict) -> tuple[int, dict]:
    friend, up_to = friend_id(db, account_id, data.get("friend")), data.get("up_to")
    if friend is None or type(up_to) is not int:
        return 400, {"error": "Bad request."}
    with db.transaction() as conn:
        conn.execute("INSERT INTO chat_reads (account_id, friend_id, last_read_id) VALUES (?, ?, ?) "
                     "ON CONFLICT (account_id, friend_id) DO UPDATE SET last_read_id = max(last_read_id, excluded.last_read_id)",
                     (account_id, friend, up_to))
    return 200, {"unread": unread(db, account_id)}


# Texts about unread messages (sent by server.py through textbot). The rule: 10 minutes
# after the newest message to you, if you still have unread messages, one text. Then no
# more until a newer message arrives. chat_notices.up_to remembers the newest message id
# already handled; message ids are AUTOINCREMENT, so they are never reused.
def due_notices(db: Database, now: int | None = None) -> list[dict]:
    """Who should get a text now: [{account_id, up_to, text}]. Reads only; sends nothing."""
    now = now_ms() if now is None else now
    rows = db.read(
        "SELECT m.to_id AS account_id, max(m.id) AS newest, max(m.created_at) AS last_at "
        "FROM messages m LEFT JOIN chat_notices n ON n.account_id = m.to_id "
        "GROUP BY m.to_id HAVING newest > coalesce(max(n.up_to), 0) AND last_at <= ?",
        (now - NOTICE_AFTER_MS,))
    due = []
    for row in rows:
        senders = db.read(
            "SELECT DISTINCT a.name FROM messages m JOIN accounts a ON a.id = m.from_id "
            "LEFT JOIN chat_reads r ON r.account_id = m.to_id AND r.friend_id = m.from_id "
            "WHERE m.to_id = ? AND m.id > coalesce(r.last_read_id, 0) ORDER BY a.name", (row["account_id"],))
        if senders:  # everything was read in time: nothing to say
            names = " and ".join(r["name"][:1].upper() + r["name"][1:] for r in senders)
            due.append({"account_id": row["account_id"], "up_to": row["newest"],
                        "text": f"You have unread messages from {names} in Pixel Game"})
    return due


def mark_noticed(db: Database, account_id: int, up_to: int) -> None:
    """Remember that messages up to this id were handled, so they never cause another text."""
    with db.transaction() as conn:
        conn.execute("INSERT INTO chat_notices (account_id, up_to) VALUES (?, ?) "
                     "ON CONFLICT (account_id) DO UPDATE SET up_to = max(up_to, excluded.up_to)", (account_id, up_to))
