"""Texts to players, sent through textbot's notify service on this Mac (~/projects/textbot).

jewels sends textbot only an account ID and the text. textbot's contacts.json maps account
IDs to phone numbers, so an account with no entry there gets no texts (textbot answers 404).
textbot also texts each person at most once every 5 minutes (it answers 429).

From the command line, in server/ (`accounts.py list` shows the IDs):

    .venv/bin/python texts.py "New puzzles are up!" all     # every account
    .venv/bin/python texts.py "Dinner's ready" 2            # one account
    .venv/bin/python texts.py "Hi, both of you" 1 2         # several
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

from db import DB_FILE, ROOT, Database

MAX_TEXT = 300  # textbot's limit


# Read when needed, not at import, so .env can be loaded first (and tests can change them).
def token() -> str:
    return os.environ.get("TEXTBOT_NOTIFY_TOKEN", "").strip()


def url() -> str:
    return os.environ.get("TEXTBOT_URL", "http://127.0.0.1:8765/notify")


def text_player(account_id: int, text: str) -> None:
    """Ask textbot to text one account. Sends only the account ID, never a phone number.
    Raises on any failure (textbot down, a 4xx/5xx answer, or no answer within 5 seconds)."""
    request = urllib.request.Request(
        url(), method="POST", data=json.dumps({"to": str(account_id), "text": text}).encode(),
        headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as reply:
        reply.read()


def why(error: Exception) -> str:
    """A failed text, in words."""
    if isinstance(error, urllib.error.HTTPError):
        return {400: "textbot refused the text",
                401: "textbot refused the token",
                404: "no phone number for this account in textbot's contacts",
                429: "textbot already texted this person in the last 5 minutes",
                502: "Messages couldn't send it"}.get(error.code, f"textbot answered {error.code}")
    if isinstance(error, urllib.error.URLError):
        return f"textbot isn't reachable ({error.reason})"
    return repr(error)


def send_text(db: Database, text: str, to) -> dict[int, str]:
    """Text any accounts the same message. `to` is "all" or a list of account IDs.

    Everything is checked before anything is sent (ValueError says what's wrong). Then each
    account is texted in turn; one failing doesn't stop the rest.
    Returns {account ID: "sent", or why it wasn't}."""
    text = str(text).strip()
    if not 0 < len(text) <= MAX_TEXT:
        raise ValueError(f"The text must be 1 to {MAX_TEXT} characters (this one is {len(text)}).")
    if not token():
        raise ValueError("There's no TEXTBOT_NOTIFY_TOKEN in server/.env, so texts are off.")
    known = [row["id"] for row in db.read("SELECT id FROM accounts ORDER BY id")]
    if to == "all":
        ids = known
    else:
        words = [str(i).strip() for i in to]
        if not words:
            raise ValueError("Say who to text: account IDs, or all.")
        if not all(w.isdigit() for w in words):
            raise ValueError(f"Account IDs are numbers (see accounts.py list), or all: not {', '.join(w for w in words if not w.isdigit())}.")
        ids = sorted({int(w) for w in words})
        unknown = [i for i in ids if i not in known]
        if unknown:
            raise ValueError(f"No account with ID {', '.join(map(str, unknown))} (see accounts.py list).")
    results = {}
    for account_id in ids:
        try:
            text_player(account_id, text)
            results[account_id] = "sent"
        except Exception as error:  # noqa: BLE001  (every failure is reported, none stops the rest)
            results[account_id] = why(error)
    return results


def main(argv: list[str]) -> int:
    """The command line: texts.py "<text>" <ID ...> | all. Exit status 1 if any text failed."""
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
    if len(argv) < 2:
        print(__doc__.split("\n\n", 2)[2].rstrip(), file=sys.stderr)
        return 2
    text, to = argv[0], argv[1:]
    db = Database(Path(os.environ.get("DB_FILE", DB_FILE)))
    names = {row["id"]: row["name"] for row in db.read("SELECT id, name FROM accounts")}
    try:
        results = send_text(db, text, "all" if [w.lower() for w in to] == ["all"] else to)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2
    for account_id, result in results.items():
        print(f"{account_id} {names[account_id]}: {result}")
    return 0 if all(r == "sent" for r in results.values()) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
