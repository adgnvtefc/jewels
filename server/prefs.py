"""Per-account settings the game keeps on the server, so they follow the account to every
browser instead of living in one. Only the keys below exist; each says how a change merges.

  bonus_seen   the bonus puzzles this account has seen in Free play (a list of puzzle ids).
               It only grows: a change adds ids, so two browsers can never undo each other.

Text-notification settings are separate (chat.py, notify_settings).
"""

import json
import re

from db import Database

PUZZLE_ID = re.compile(r"[A-Za-z0-9-]{1,64}")
MAX_SEEN = 500


def _seen(old, new):
    if not isinstance(new, list) or not all(isinstance(i, str) and PUZZLE_ID.fullmatch(i) for i in new):
        return None
    merged = list(dict.fromkeys([*(old or []), *new]))
    return merged[-MAX_SEEN:]


KEYS = {"bonus_seen": _seen}  # key -> merge(old value, change) -> new value, or None if the change is bad


def get(db: Database, account_id: int) -> dict:
    rows = db.read("SELECT key, value FROM account_prefs WHERE account_id = ?", (account_id,))
    return {row["key"]: json.loads(row["value"]) for row in rows if row["key"] in KEYS}


def update(db: Database, account_id: int, data) -> tuple[int, dict]:
    """Change some settings: {key: change}. -> (status, all the account's settings)"""
    if not isinstance(data, dict) or not data or any(key not in KEYS for key in data):
        return 400, {"error": "Bad request."}
    current = get(db, account_id)
    merged = {key: KEYS[key](current.get(key), change) for key, change in data.items()}
    if any(value is None for value in merged.values()):
        return 400, {"error": "Bad request."}
    with db.transaction() as conn:
        for key, value in merged.items():
            conn.execute("INSERT INTO account_prefs (account_id, key, value) VALUES (?, ?, ?) "
                         "ON CONFLICT (account_id, key) DO UPDATE SET value = excluded.value", (account_id, key, json.dumps(value)))
    return 200, get(db, account_id)
