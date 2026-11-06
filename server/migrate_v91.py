"""One-time move of the old shared saves (data/saves.json) into one account.

    .venv/bin/python migrate_v91.py anushka [data/saves.json]

Run it after adding the accounts (accounts.py). It copies saves.json to saves-v91.json
first and never changes or deletes the original. It refuses to run twice.
"""

import json
import os
import shutil
import sys
from pathlib import Path

from dotenv import load_dotenv

from db import DB_FILE, ROOT, Database, now_ms
import saves


def migrate(db: Database, name: str, source: Path) -> dict:
    account = db.one("SELECT id FROM accounts WHERE name = ?", (name,))
    if not account:
        raise SystemExit(f"No account named {name!r}; add it with accounts.py first.")
    account_id = account["id"]
    if db.one("SELECT 1 FROM saves WHERE account_id = ? UNION SELECT 1 FROM library WHERE account_id = ?", (account_id, account_id)):
        raise SystemExit(f"{name} already has saves or puzzles; not migrating twice.")
    record = json.loads(source.read_text())
    data = record["data"]
    removed = set(data.get("removed", []))
    report = {"version": record["version"], "puzzles": 0, "saves": 0, "skipped": []}
    now = now_ms()
    with db.transaction() as conn:
        for art in data.get("custom", []):
            clean = saves.valid_art(art)
            if not clean or clean["id"] in removed:
                report["skipped"].append(f"puzzle {art.get('id')}")
                continue
            conn.execute("INSERT INTO puzzles (id, creator_id, title, art, created_at) VALUES (?, ?, ?, ?, ?)",
                         (clean["id"], account_id, clean["title"], json.dumps(clean, separators=(",", ":")), now))
            conn.execute("INSERT INTO library (account_id, puzzle_id, from_id, added_at, rev) VALUES (?, ?, NULL, ?, ?)",
                         (account_id, clean["id"], now, db.bump(conn, account_id)))
            report["puzzles"] += 1
        for puzzle_id, state in data.get("saves", {}).items():
            art = saves.art_for(db, puzzle_id)
            home = saves.jewels_home(art, state) if art else None
            if home is None:
                report["skipped"].append(f"save {puzzle_id}")
                continue
            total = sum(1 for c in art["pixels"] if c >= 0)
            saved_at = state.get("savedAt") if type(state.get("savedAt")) is int else now
            # Finished before the move: marked finished, with no notices (nothing was sent yet).
            conn.execute("INSERT INTO saves (account_id, puzzle_id, state, home, total, rev, saved_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                         (account_id, puzzle_id, json.dumps(state, separators=(",", ":")), home, total,
                          db.bump(conn, account_id), saved_at, now if home == total else None))
            report["saves"] += 1
    return report


def main(argv: list[str]) -> None:
    if not 1 <= len(argv) <= 2:
        raise SystemExit(__doc__)
    load_dotenv(ROOT / ".env")
    source = Path(argv[1]) if len(argv) > 1 else ROOT / "data" / "saves.json"
    keep = source.with_name("saves-v91.json")
    if not keep.exists():
        shutil.copy2(source, keep)
        print(f"Kept a copy at {keep}")
    db = Database(Path(os.environ.get("DB_FILE", DB_FILE)))
    if not (db.backups / "jewels-before-migration.db").exists():  # a second run must not replace it
        print(f"Backed up the database to {db.backup('jewels-before-migration.db')}")
    report = migrate(db, argv[0].strip().lower(), keep)
    print(f"Moved version {report['version']} into {argv[0]}: {report['puzzles']} puzzles, {report['saves']} saves.")
    if report["skipped"]:
        print("Skipped (didn't fit): " + ", ".join(report["skipped"]))


if __name__ == "__main__":
    main(sys.argv[1:])
