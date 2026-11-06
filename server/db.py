"""The game's database: one SQLite file, server/data/jewels.db (not in git).

Every read and write goes through one connection behind a lock. Traffic is two people,
so this is plenty, and it means a write never sees half of another one.
Backups are full copies made with SQLite's own backup, safe while the server runs.
"""

import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB_FILE = Path(os.environ.get("DB_FILE", ROOT / "data" / "jewels.db"))
KEEP_BACKUPS = 30

SCHEMA = """
CREATE TABLE accounts (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  rev           INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device       TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE TABLE friends (
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  friend_id  INTEGER NOT NULL REFERENCES accounts(id),
  since      INTEGER NOT NULL,
  PRIMARY KEY (account_id, friend_id)
);
CREATE TABLE puzzles (
  id         TEXT PRIMARY KEY,
  creator_id INTEGER NOT NULL REFERENCES accounts(id),
  title      TEXT NOT NULL,
  art        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE library (
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  puzzle_id  TEXT NOT NULL REFERENCES puzzles(id),
  from_id    INTEGER REFERENCES accounts(id),
  added_at   INTEGER NOT NULL,
  removed_at INTEGER,
  rev        INTEGER NOT NULL,
  PRIMARY KEY (account_id, puzzle_id)
);
CREATE INDEX library_rev ON library(account_id, rev);
CREATE TABLE saves (
  account_id  INTEGER NOT NULL REFERENCES accounts(id),
  puzzle_id   TEXT NOT NULL,
  state       TEXT NOT NULL,
  home        INTEGER NOT NULL,
  total       INTEGER NOT NULL,
  rev         INTEGER NOT NULL,
  saved_at    INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (account_id, puzzle_id)
);
CREATE INDEX saves_rev ON saves(account_id, rev);
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id    INTEGER NOT NULL REFERENCES accounts(id),
  to_id      INTEGER NOT NULL REFERENCES accounts(id),
  kind       TEXT NOT NULL CHECK (kind IN ('text', 'puzzle', 'finished')),
  body       TEXT,
  puzzle_id  TEXT,
  moves      INTEGER,
  client_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (from_id, client_id)
);
CREATE INDEX messages_pair ON messages(to_id, id);
CREATE TABLE chat_reads (
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  friend_id    INTEGER NOT NULL REFERENCES accounts(id),
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, friend_id)
);
"""
# Each entry upgrades the schema by one version; SCHEMA above is version 1.
UPGRADES: list[str] = []
VERSION = 1 + len(UPGRADES)


def now_ms() -> int:
    return int(time.time() * 1000)


class Database:
    def __init__(self, path: Path = DB_FILE, backups: Path | None = None):
        self.path = Path(path)
        self.backups = Path(backups) if backups else self.path.parent / "backups"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(self.path, timeout=5, isolation_level=None, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("PRAGMA busy_timeout=5000")
        self.upgrade()

    def upgrade(self) -> None:
        with self.lock:
            version = self.conn.execute("PRAGMA user_version").fetchone()[0]
            if version == VERSION:
                return
            if version > VERSION:
                raise SystemExit(f"{self.path} is schema {version}; this server knows up to {VERSION}.")
            if version:  # an existing database: keep a copy from before the upgrade
                self.backup(f"jewels-before-v{VERSION}.db")
            steps = [SCHEMA] + UPGRADES
            with self.transaction() as conn:
                for step in steps[version:]:
                    for statement in filter(str.strip, step.split(";")):
                        conn.execute(statement)
                conn.execute(f"PRAGMA user_version = {VERSION}")

    @contextmanager
    def transaction(self):
        """All the statements inside commit together, or not at all."""
        with self.lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield self.conn
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
            self.conn.execute("COMMIT")

    def read(self, sql: str, params=()) -> list[sqlite3.Row]:
        with self.lock:
            return self.conn.execute(sql, params).fetchall()

    def one(self, sql: str, params=()) -> sqlite3.Row | None:
        with self.lock:
            return self.conn.execute(sql, params).fetchone()

    def backup(self, name: str | None = None) -> Path:
        """A full copy in backups/, then only the newest KEEP_BACKUPS daily copies are kept."""
        self.backups.mkdir(parents=True, exist_ok=True)
        target = self.backups / (name or f"jewels-{date.today().isoformat()}.db")
        temporary = target.with_suffix(".tmp")
        with self.lock:
            copy = sqlite3.connect(temporary)
            try:
                self.conn.backup(copy)
            finally:
                copy.close()
        os.replace(temporary, target)
        daily = sorted(self.backups.glob("jewels-????-??-??.db"))
        for old in daily[:-KEEP_BACKUPS]:
            old.unlink()
        return target

    def back_up_daily(self) -> None:
        """Runs forever: a copy at start, then one each day."""
        while True:
            try:
                if not (self.backups / f"jewels-{date.today().isoformat()}.db").exists():
                    print(f"backed up to {self.backup()}", flush=True)
            except Exception as error:
                print(f"backup failed: {error}", flush=True)
            time.sleep(3600)

    def bump(self, conn: sqlite3.Connection, account_id: int) -> int:
        """The account's next revision number, for anything that changes its saves or library."""
        conn.execute("UPDATE accounts SET rev = rev + 1 WHERE id = ?", (account_id,))
        return conn.execute("SELECT rev FROM accounts WHERE id = ?", (account_id,)).fetchone()[0]
