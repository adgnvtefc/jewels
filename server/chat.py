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
#
# Each account chooses which kinds count (notify_settings, all on by default): new
# messages, new puzzles, and puzzles of yours that were finished. A kind that is off is
# ignored entirely: it neither starts the 10 minutes nor appears in a text.
SETTINGS = {"messages": "text", "puzzles": "puzzle", "finished": "finished"}  # setting -> message kind


def notify_settings(db: Database, account_id: int) -> dict[str, bool]:
    row = db.one("SELECT messages, puzzles, finished FROM notify_settings WHERE account_id = ?", (account_id,))
    return {name: row is None or row[name] is not None for name in SETTINGS}


def set_notify_settings(db: Database, account_id: int, data) -> tuple[int, dict]:
    """Change some of {messages, puzzles, finished} (true or false). -> (status, all three)"""
    if not isinstance(data, dict) or not data or any(name not in SETTINGS or type(on) is not bool for name, on in data.items()):
        return 400, {"error": "Bad request."}
    with db.transaction() as conn:
        conn.execute("INSERT OR IGNORE INTO notify_settings (account_id) VALUES (?)", (account_id,))
        row = conn.execute("SELECT * FROM notify_settings WHERE account_id = ?", (account_id,)).fetchone()
        newest = conn.execute("SELECT coalesce(max(id), 0) FROM messages").fetchone()[0]
        for name, on in data.items():
            if not on:
                conn.execute(f"UPDATE notify_settings SET {name} = NULL WHERE account_id = ?", (account_id,))
            elif row[name] is None:  # switched on now: only messages from here on count
                conn.execute(f"UPDATE notify_settings SET {name} = ? WHERE account_id = ?", (newest, account_id))
    return 200, notify_settings(db, account_id)


def notice_text(unread: list) -> str:
    """'Bob sent you a new message and a new puzzle in Pixel Game', from unread rows (sender, kind)."""
    clauses = []
    for sender in sorted({row["sender"] for row in unread}):
        count = lambda kind: sum(row["sender"] == sender and row["kind"] == kind for row in unread)
        some = lambda n, one, many: one if n == 1 else f"{n} {many}"
        sent = [some(n, "a new message", "new messages") for n in [count("text")] if n] + \
               [some(n, "a new puzzle", "new puzzles") for n in [count("puzzle")] if n]
        doing = [f"sent you {' and '.join(sent)}"] if sent else []
        if n := count("finished"):
            doing.append("finished your puzzle" if n == 1 else f"finished {n} of your puzzles")
        clauses.append(sender[:1].upper() + sender[1:] + " " + " and ".join(doing))
    return (", ".join(clauses[:-1]) + " and " if len(clauses) > 1 else "") + clauses[-1] + " in Pixel Game"


def due_notices(db: Database, now: int | None = None) -> list[dict]:
    """Who should get a text now: [{account_id, up_to, text}]. Reads only; sends nothing."""
    now = now_ms() if now is None else now
    # Messages not yet handled, of the kinds each recipient has on (and newer than when
    # that kind was switched on).
    rows = db.read(
        "SELECT * FROM (SELECT m.id, m.to_id, m.kind, m.created_at, a.name AS sender, "
        "  m.id > coalesce(r.last_read_id, 0) AS unread, "
        "  CASE WHEN s.account_id IS NULL THEN 0 WHEN m.kind = 'text' THEN s.messages "
        "       WHEN m.kind = 'puzzle' THEN s.puzzles ELSE s.finished END AS since "
        "  FROM messages m JOIN accounts a ON a.id = m.from_id "
        "  LEFT JOIN chat_notices n ON n.account_id = m.to_id "
        "  LEFT JOIN chat_reads r ON r.account_id = m.to_id AND r.friend_id = m.from_id "
        "  LEFT JOIN notify_settings s ON s.account_id = m.to_id "
        "  WHERE m.id > coalesce(n.up_to, 0)) "
        "WHERE since IS NOT NULL AND id > since ORDER BY id")
    by_account: dict[int, list] = defaultdict(list)
    for row in rows:
        by_account[row["to_id"]].append(row)
    due = []
    for account_id, mine in by_account.items():
        if mine[-1]["created_at"] > now - NOTICE_AFTER_MS:
            continue  # the newest counted message is under 10 minutes old
        unread = [row for row in mine if row["unread"]]
        if unread:  # everything was read in time: nothing to say
            due.append({"account_id": account_id, "up_to": mine[-1]["id"], "text": notice_text(unread)})
    return due


def mark_noticed(db: Database, account_id: int, up_to: int) -> None:
    """Remember that messages up to this id were handled, so they never cause another text."""
    with db.transaction() as conn:
        conn.execute("INSERT INTO chat_notices (account_id, up_to) VALUES (?, ?) "
                     "ON CONFLICT (account_id) DO UPDATE SET up_to = max(up_to, excluded.up_to)", (account_id, up_to))
