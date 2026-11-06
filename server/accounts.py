"""Accounts, passwords and sign-in sessions.

Passwords are kept only as scrypt hashes. Signing in gives the browser a random token;
the database keeps only the token's SHA-256, so a copy of the database can't sign anyone in.

Accounts are added on the Mac, never through the web (passwords are typed at a hidden prompt):

    .venv/bin/python accounts.py add anushka
    .venv/bin/python accounts.py set-password anushka     # also signs her out everywhere
    .venv/bin/python accounts.py befriend anushka hanmo
    .venv/bin/python accounts.py list
"""

import base64
import getpass
import hashlib
import hmac
import os
import re
import secrets
import sys
from pathlib import Path

from db import DB_FILE, ROOT, Database, now_ms

DAY = 24 * 3600 * 1000
SESSION_DAYS = 90
MAX_SESSIONS = 10
NAME = re.compile(r"[a-z0-9]{1,20}")
SCRYPT = {"n": 2**15, "r": 8, "p": 1}


def clean_name(name) -> str:
    return str(name or "").strip().lower()


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def hash_password(password: str, salt: bytes | None = None, n=SCRYPT["n"], r=SCRYPT["r"], p=SCRYPT["p"]) -> str:
    salt = salt or secrets.token_bytes(16)
    key = hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, dklen=32, maxmem=64 * 1024 * 1024)
    return f"scrypt${n.bit_length() - 1}${r}${p}${_b64(salt)}${_b64(key)}"


def check_password(password: str, stored: str) -> bool:
    try:
        _, log_n, r, p, salt, key = stored.split("$")
        expected = base64.b64decode(key)
        actual = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), n=2 ** int(log_n), r=int(r), p=int(p),
                                dklen=len(expected), maxmem=64 * 1024 * 1024)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


# A wrong name is checked against this, so it takes as long as a wrong password.
_DUMMY = hash_password(secrets.token_hex(8))


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def friends_of(db: Database, account_id: int) -> list[str]:
    rows = db.read("SELECT a.name FROM friends f JOIN accounts a ON a.id = f.friend_id WHERE f.account_id = ? ORDER BY a.name",
                   (account_id,))
    return [row["name"] for row in rows]


def login(db: Database, name, password, device: str = "") -> dict | None:
    """A new session for the right name and password, else None."""
    row = db.one("SELECT id, name, password_hash FROM accounts WHERE name = ?", (clean_name(name),))
    if not check_password(str(password or ""), row["password_hash"] if row else _DUMMY) or not row:
        return None
    token, now = secrets.token_urlsafe(32), now_ms()
    with db.transaction() as conn:
        conn.execute("INSERT INTO sessions (token_hash, account_id, device, created_at, last_seen_at, expires_at) "
                     "VALUES (?, ?, ?, ?, ?, ?)", (token_hash(token), row["id"], device[:80], now, now, now + SESSION_DAYS * DAY))
        conn.execute("DELETE FROM sessions WHERE account_id = ? AND token_hash NOT IN "
                     "(SELECT token_hash FROM sessions WHERE account_id = ? ORDER BY last_seen_at DESC LIMIT ?)",
                     (row["id"], row["id"], MAX_SESSIONS))
    return {"token": token, "name": row["name"], "friends": friends_of(db, row["id"]),
            "expires_at": now + SESSION_DAYS * DAY}


def session_account(db: Database, token: str) -> dict | None:
    """The account a token belongs to, or None. Use keeps the session alive."""
    if not token:
        return None
    hashed, now = token_hash(token), now_ms()
    row = db.one("SELECT s.last_seen_at, s.expires_at, a.id, a.name FROM sessions s "
                 "JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?", (hashed,))
    if not row:
        return None
    if row["expires_at"] < now:
        with db.transaction() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (hashed,))
        return None
    if now - row["last_seen_at"] > 3600 * 1000:  # at most one write an hour
        with db.transaction() as conn:
            conn.execute("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?",
                         (now, now + SESSION_DAYS * DAY, hashed))
    return {"id": row["id"], "name": row["name"]}


def logout(db: Database, token: str, everywhere: bool = False) -> None:
    with db.transaction() as conn:
        if everywhere:
            conn.execute("DELETE FROM sessions WHERE account_id = (SELECT account_id FROM sessions WHERE token_hash = ?)",
                         (token_hash(token),))
        else:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))


def account_id(db: Database, name) -> int | None:
    row = db.one("SELECT id FROM accounts WHERE name = ?", (clean_name(name),))
    return row["id"] if row else None


def add_account(db: Database, name, password: str) -> int:
    name = clean_name(name)
    if not NAME.fullmatch(name):
        raise ValueError("Names are 1-20 lowercase letters or digits.")
    with db.transaction() as conn:
        return conn.execute("INSERT INTO accounts (name, password_hash, created_at) VALUES (?, ?, ?)",
                            (name, hash_password(password), now_ms())).lastrowid


def set_password(db: Database, name, password: str) -> None:
    with db.transaction() as conn:
        changed = conn.execute("UPDATE accounts SET password_hash = ? WHERE name = ?", (hash_password(password), clean_name(name)))
        if not changed.rowcount:
            raise ValueError(f"No account named {name!r}.")
        conn.execute("DELETE FROM sessions WHERE account_id = (SELECT id FROM accounts WHERE name = ?)", (clean_name(name),))


def befriend(db: Database, a, b) -> None:
    ids = [account_id(db, a), account_id(db, b)]
    if None in ids or ids[0] == ids[1]:
        raise ValueError("Both accounts must exist and differ.")
    with db.transaction() as conn:
        for x, y in (ids, ids[::-1]):
            conn.execute("INSERT OR IGNORE INTO friends (account_id, friend_id, since) VALUES (?, ?, ?)", (x, y, now_ms()))


def _ask_password() -> str:
    first = getpass.getpass("Password: ")
    if len(first) < 8:
        raise SystemExit("Use at least 8 characters.")
    if getpass.getpass("Again: ") != first:
        raise SystemExit("Those didn't match.")
    return first


def main(argv: list[str]) -> None:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
    db = Database(Path(os.environ.get("DB_FILE", DB_FILE)))
    match argv:
        case ["add", name]:
            add_account(db, name, _ask_password())
            print(f"Added {clean_name(name)}.")
        case ["set-password", name]:
            set_password(db, name, _ask_password())
            print(f"Changed the password for {clean_name(name)} and signed it out everywhere.")
        case ["befriend", a, b]:
            befriend(db, a, b)
            print(f"{clean_name(a)} and {clean_name(b)} are friends.")
        case ["list"]:
            for row in db.read("SELECT id, name FROM accounts ORDER BY id"):
                sessions = db.one("SELECT count(*) FROM sessions WHERE account_id = ?", (row["id"],))[0]
                print(f"{row['name']}: friends {', '.join(friends_of(db, row['id'])) or '-'}; {sessions} signed-in devices")
        case _:
            raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
