"""Each account's progress and puzzles.

Saves are one row per account and puzzle, each with a revision number. A browser sends a
save with `based_on`, the revision it last saw. If nothing else saved that puzzle since,
the save is taken as it is. If another device did, the copy with more jewels home wins
(then the newer one), and the browser gets the winner back.

The server counts jewels itself: shipped puzzles come from ../assets in this checkout
(where deploys come from), made ones from the puzzles table.
"""

import json
import re
import time
from pathlib import Path

import chat
from db import Database, now_ms

ASSETS = Path(__file__).resolve().parent.parent / "assets"
SHELF_SIZE, SHELF_ROW, MAX_SHELF_SIZE = 24, 8, 1024  # as in game.js
PUZZLE_ID = re.compile(r"custom-[a-z0-9]{1,25}")
HEX = re.compile(r"#[0-9a-fA-F]{6}")
MAX_TITLE = 200
MAX_SAVES_PER_PUT = 300
CONTROL = re.compile(r"[\x00-\x1f\x7f]")

_shipped: dict[str, dict] = {}
_loaded_at = 0.0


def shipped() -> dict[str, dict]:
    """Levels and bonus puzzles by id, reread at most once a minute."""
    global _shipped, _loaded_at
    if time.time() - _loaded_at > 60:
        found = {}
        for listing in ("puzzles.json", "bonus.json"):
            try:
                for file in json.loads((ASSETS / listing).read_text()):
                    art = json.loads((ASSETS / file).read_text())
                    found[art["id"]] = art
            except (OSError, ValueError, KeyError):
                pass
        _shipped, _loaded_at = found, time.time()
    return _shipped


def made_art(db: Database, puzzle_id: str) -> dict | None:
    row = db.one("SELECT art FROM puzzles WHERE id = ?", (puzzle_id,))
    return json.loads(row["art"]) if row else None


def art_for(db: Database, puzzle_id: str) -> dict | None:
    return shipped().get(puzzle_id) or made_art(db, puzzle_id)


def jewels_home(art: dict, state) -> int | None:
    """Jewels in their right place, or None when the save doesn't fit the puzzle (game.js restore)."""
    if not isinstance(state, dict):
        return None
    board, shelf, pixels, colors = state.get("board"), state.get("shelf"), art["pixels"], len(art["colors"])
    if not isinstance(board, list) or not isinstance(shelf, list) or len(board) != len(pixels):
        return None
    if not SHELF_SIZE <= len(shelf) <= MAX_SHELF_SIZE or len(shelf) % SHELF_ROW:
        return None
    count, expected = [0] * colors, [0] * colors
    for c in pixels:
        if c >= 0:
            expected[c] += 1
    for c in board + shelf:
        if type(c) is not int or not -1 <= c < colors:
            return None
        if c >= 0:
            count[c] += 1
    if count != expected or any(c < 0 and b != -1 for c, b in zip(pixels, board)):
        return None
    return sum(1 for c, b in zip(pixels, board) if c >= 0 and b == c)


def clean_title(title) -> str:
    return " ".join(CONTROL.sub(" ", str(title)).split())[:MAX_TITLE]


def valid_art(art) -> dict | None:
    """A made puzzle that is safe to store and draw in someone else's browser, cleaned up, or None."""
    if not isinstance(art, dict):
        return None
    pid, title, colors, pixels = art.get("id"), art.get("title"), art.get("colors"), art.get("pixels")
    if not isinstance(pid, str) or not PUZZLE_ID.fullmatch(pid) or not isinstance(title, str) or not clean_title(title):
        return None
    if art.get("width") != 32 or art.get("height") != 32:
        return None
    if not isinstance(colors, list) or not 2 <= len(colors) <= 16 or not all(isinstance(c, str) and HEX.fullmatch(c) for c in colors):
        return None
    if not isinstance(pixels, list) or len(pixels) != 1024 or not all(type(c) is int and -1 <= c < len(colors) for c in pixels):
        return None
    if set(range(len(colors))) - set(pixels):
        return None
    return {"id": pid, "title": clean_title(title), "width": 32, "height": 32, "colors": colors, "pixels": pixels}


def add_puzzle(db: Database, account_id: int, art) -> tuple[int, dict]:
    """Store a puzzle this account made, or bring back one it has (made or was sent). -> (status, body)"""
    pid = art.get("id") if isinstance(art, dict) else None
    with db.transaction() as conn:
        existing = conn.execute("SELECT creator_id FROM puzzles WHERE id = ?", (pid,)).fetchone() if isinstance(pid, str) else None
        if existing:
            mine = conn.execute("SELECT 1 FROM library WHERE account_id = ? AND puzzle_id = ?", (account_id, pid)).fetchone()
            if not mine:
                return 409, {"error": "That puzzle id is taken."}
            conn.execute("UPDATE library SET removed_at = NULL, rev = ? WHERE account_id = ? AND puzzle_id = ?",
                         (db.bump(conn, account_id), account_id, pid))
            return 200, {"id": pid}
        clean = valid_art(art)
        if not clean:
            return 400, {"error": "That puzzle can't be used."}
        now = now_ms()
        conn.execute("INSERT INTO puzzles (id, creator_id, title, art, created_at) VALUES (?, ?, ?, ?, ?)",
                     (clean["id"], account_id, clean["title"], json.dumps(clean, separators=(",", ":")), now))
        conn.execute("INSERT INTO library (account_id, puzzle_id, from_id, added_at, rev) VALUES (?, ?, NULL, ?, ?)",
                     (account_id, clean["id"], now, db.bump(conn, account_id)))
    return 201, {"id": clean["id"]}


def remove_puzzle(db: Database, account_id: int, puzzle_id: str) -> bool:
    """Hide a puzzle from this account's Free play and drop its progress. The puzzle itself stays."""
    with db.transaction() as conn:
        found = conn.execute("UPDATE library SET removed_at = ?, rev = ? WHERE account_id = ? AND puzzle_id = ? AND removed_at IS NULL",
                             (now_ms(), db.bump(conn, account_id), account_id, puzzle_id)).rowcount
        conn.execute("DELETE FROM saves WHERE account_id = ? AND puzzle_id = ?", (account_id, puzzle_id))
    return bool(found)


def changes(db: Database, account_id: int, since: int) -> dict:
    """Saves and library rows changed after revision `since`."""
    with db.lock:
        rev = db.one("SELECT rev FROM accounts WHERE id = ?", (account_id,))["rev"]
        saves = db.read("SELECT puzzle_id, state, rev FROM saves WHERE account_id = ? AND rev > ? ORDER BY rev", (account_id, since))
        library = db.read("SELECT l.puzzle_id, l.removed_at, l.rev, p.art, a.name AS sender FROM library l "
                          "JOIN puzzles p ON p.id = l.puzzle_id LEFT JOIN accounts a ON a.id = l.from_id "
                          "WHERE l.account_id = ? AND l.rev > ? ORDER BY l.rev", (account_id, since))
    return {
        "rev": rev,
        "saves": [{"puzzle": r["puzzle_id"], "state": json.loads(r["state"]), "rev": r["rev"]} for r in saves],
        "library": [{"puzzle": r["puzzle_id"], "removed": r["removed_at"] is not None, "rev": r["rev"], "from": r["sender"],
                     **({} if r["removed_at"] else {"art": json.loads(r["art"])})} for r in library],
    }


def put_saves(db: Database, account_id: int, items) -> tuple[int, dict]:
    """Apply saves sent by a browser. -> (status, {rev, results: {puzzle: {rev, state?}}, rejected: [...]})"""
    if not isinstance(items, list) or len(items) > MAX_SAVES_PER_PUT:
        return 400, {"error": "Bad request."}
    results, rejected = {}, []
    with db.transaction() as conn:
        for item in items:
            pid = item.get("puzzle") if isinstance(item, dict) else None
            art = art_for(db, pid) if isinstance(pid, str) else None
            state, based_on = item.get("state") if art else None, item.get("based_on") if art else None
            home = jewels_home(art, state) if art else None
            if home is None or type(based_on) is not int:
                rejected.append(pid if isinstance(pid, str) else None)
                continue
            total = sum(1 for c in art["pixels"] if c >= 0)
            saved_at = state.get("savedAt") if type(state.get("savedAt")) is int else now_ms()
            row = conn.execute("SELECT * FROM saves WHERE account_id = ? AND puzzle_id = ?", (account_id, pid)).fetchone()
            if row and row["rev"] != based_on and (row["home"], row["saved_at"]) >= (home, saved_at):
                # Another device saved in between and its copy is at least as far along: it stays.
                results[pid] = {"rev": row["rev"], "state": json.loads(row["state"])}
                continue
            rev, finished = db.bump(conn, account_id), row["finished_at"] if row else None
            newly_finished = home == total and not finished
            conn.execute("INSERT OR REPLACE INTO saves (account_id, puzzle_id, state, home, total, rev, saved_at, finished_at) "
                         "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                         (account_id, pid, json.dumps(state, separators=(",", ":")), home, total, rev, saved_at,
                          now_ms() if newly_finished else finished))
            if newly_finished:
                chat.notify_finished(conn, account_id, pid, state.get("moves") if type(state.get("moves")) is int else None)
            results[pid] = {"rev": rev}
        rev = conn.execute("SELECT rev FROM accounts WHERE id = ?", (account_id,)).fetchone()[0]
    return 200, {"rev": rev, "results": results, "rejected": rejected}
