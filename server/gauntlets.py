"""Gauntlets made ahead: one ready for each account, so tapping Gauntlet starts at once.

The picture worker (server.py) makes them in the background, one puzzle at a time and only
while nobody is waiting on a picture; POST /api/gauntlet takes the ready one, and the worker
then makes the next. A taken gauntlet is deleted. They live in the database, so a restart
keeps them.
"""

import json

from db import Database, now_ms


def needing(db: Database) -> list[tuple[int, str]]:
    """(id, name) of each account with no gauntlet ready, oldest account first."""
    rows = db.read("SELECT a.id, a.name FROM accounts a WHERE NOT EXISTS "
                   "(SELECT 1 FROM gauntlets g WHERE g.account_id = a.id) ORDER BY a.id")
    return [(row["id"], row["name"]) for row in rows]


def store(db: Database, account_id: int, puzzles: list[dict]) -> None:
    with db.transaction() as conn:
        conn.execute("INSERT INTO gauntlets (account_id, puzzles, made_at) VALUES (?, ?, ?)",
                     (account_id, json.dumps(puzzles), now_ms()))


def take(db: Database, account_id: int) -> list[dict] | None:
    """The account's ready gauntlet (its puzzles), removed so it is only handed out once."""
    with db.transaction() as conn:
        row = conn.execute("SELECT id, puzzles FROM gauntlets WHERE account_id = ? ORDER BY id LIMIT 1",
                           (account_id,)).fetchone()
        if row is None:
            return None
        conn.execute("DELETE FROM gauntlets WHERE id = ?", (row["id"],))
    return json.loads(row["puzzles"])
