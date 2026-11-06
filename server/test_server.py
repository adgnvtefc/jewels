"""Tests for the server, run against a throwaway database:

    cd server && .venv/bin/python -m unittest test_server
"""

import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

TEMP = tempfile.TemporaryDirectory()
os.environ.update(DB_FILE=str(Path(TEMP.name) / "test.db"), USE_MODEL="0", USE_AGENT="0")

import accounts  # noqa: E402
import chat  # noqa: E402
import saves  # noqa: E402
import server  # noqa: E402
from db import Database  # noqa: E402

LEVEL = next(iter(saves.shipped().values()))  # the first level


def made(pid="custom-abc", colors=("#112233", "#445566")):
    return {"id": pid, "title": "  A\x00 cat  ", "width": 32, "height": 32, "colors": list(colors),
            "pixels": [i % len(colors) for i in range(1024)]}


def state_for(art, home=None, moves=0, saved_at=1):
    """A save with the first `home` jewels in place (all of them by default)."""
    pixels = art["pixels"]
    board, shelf = list(pixels), [-1] * 24
    wrong = [i for i, c in enumerate(pixels) if c >= 0][home if home is not None else len(pixels):]
    if wrong:  # move them to the shelf: a legal, unfinished position
        size = -(-max(24, len(wrong)) // 8) * 8
        shelf = [-1] * size
        for n, i in enumerate(wrong):
            shelf[n], board[i] = pixels[i], -1
    return {"board": board, "shelf": shelf, "moves": moves, "selectedColor": None, "savedAt": saved_at}


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.db = Database(Path(TEMP.name) / "test.db")
        cls.db = server.db
        accounts.add_account(cls.db, "anushka", "first-password")
        accounts.add_account(cls.db, "hanmo", "second-password")
        accounts.add_account(cls.db, "stranger", "third-password")
        accounts.befriend(cls.db, "anushka", "hanmo")
        server.Handler.log_message = lambda *args: None  # keep test output quiet
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def call(self, method, path, body=None, token=None):
        request = urllib.request.Request(self.base + path, method=method,
                                         data=None if body is None else json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json",
                                                  **({"Authorization": f"Bearer {token}"} if token else {})})
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def sign_in(self, name, password):
        status, body = self.call("POST", "/api/login", {"name": name, "password": password})
        self.assertEqual(status, 200, body)
        return body["token"]

    def setUp(self):
        server.failures.clear()
        chat.recent.clear()
        self.anu = self.sign_in(" Anushka ", "first-password")
        self.hanmo = self.sign_in("hanmo", "second-password")

    # Sign-in and sessions

    def test_wrong_name_and_wrong_password_get_the_same_answer(self):
        a = self.call("POST", "/api/login", {"name": "anushka", "password": "nope"})
        b = self.call("POST", "/api/login", {"name": "nobody", "password": "nope"})
        self.assertEqual(a, b)
        self.assertEqual(a[0], 401)

    def test_twenty_wrong_tries_refuse_all_sign_ins_for_a_while(self):
        server.failures.extend([__import__("time").time()] * 20)
        status, _ = self.call("POST", "/api/login", {"name": "anushka", "password": "first-password"})
        self.assertEqual(status, 429)

    def test_only_a_hash_of_the_token_is_stored_and_logout_ends_it(self):
        self.assertIsNone(self.db.one("SELECT 1 FROM sessions WHERE token_hash = ?", (self.anu,)))
        self.assertEqual(self.call("GET", "/api/me", token=self.anu)[1]["friends"], ["hanmo"])
        self.assertEqual(self.call("POST", "/api/logout", {}, token=self.anu)[0], 200)
        self.assertEqual(self.call("GET", "/api/me", token=self.anu)[0], 401)

    def test_logout_everywhere_and_new_password_end_every_session(self):
        other = self.sign_in("hanmo", "second-password")
        self.call("POST", "/api/logout", {"everywhere": True}, token=self.hanmo)
        self.assertEqual(self.call("GET", "/api/me", token=other)[0], 401)
        other = self.sign_in("hanmo", "second-password")
        accounts.set_password(self.db, "hanmo", "second-password")
        self.assertEqual(self.call("GET", "/api/me", token=other)[0], 401)

    def test_everything_but_sign_in_needs_a_token(self):
        for method, path in (("GET", "/api/saves"), ("GET", "/api/messages"), ("POST", "/api/jobs"), ("PUT", "/api/saves")):
            self.assertEqual(self.call(method, path, {} if method != "GET" else None, token="made-up")[0], 401, path)

    def test_passwords_are_scrypt_hashes(self):
        stored = self.db.one("SELECT password_hash FROM accounts WHERE name = 'anushka'")[0]
        self.assertTrue(stored.startswith("scrypt$15$8$1$"))
        self.assertNotIn("first-password", stored)

    # Saves

    def test_saves_are_separate_per_account(self):
        self.call("PUT", "/api/saves", {"saves": [{"puzzle": LEVEL["id"], "state": state_for(LEVEL, 3), "based_on": 0}]}, token=self.anu)
        theirs = self.call("GET", "/api/saves?since=0", token=self.hanmo)[1]
        self.assertNotIn(LEVEL["id"], [s["puzzle"] for s in theirs["saves"]])

    def test_a_stale_device_cannot_roll_back_progress(self):
        account = accounts.add_account(self.db, f"roll{id(self) % 9999}", "password-123")
        token = self.sign_in(f"roll{id(self) % 9999}", "password-123")
        put = lambda state, based_on: self.call("PUT", "/api/saves", {"saves": [{"puzzle": LEVEL["id"], "state": state, "based_on": based_on}]}, token=token)[1]
        first = put(state_for(LEVEL, 10, saved_at=1), 0)["results"][LEVEL["id"]]["rev"]
        laptop = put(state_for(LEVEL, 50, saved_at=2), first)["results"][LEVEL["id"]]
        self.assertNotIn("state", laptop, "nothing in between: taken as is")
        phone = put(state_for(LEVEL, 20, saved_at=3), first)["results"][LEVEL["id"]]  # still based on the first copy
        self.assertEqual(phone["rev"], laptop["rev"], "the laptop's further copy stays")
        self.assertEqual(saves.jewels_home(LEVEL, phone["state"]), 50)
        back = put(state_for(LEVEL, 40, saved_at=4), laptop["rev"])["results"][LEVEL["id"]]
        self.assertNotIn("state", back, "a device may go backwards on its own copy")
        self.assertEqual(self.db.one("SELECT home FROM saves WHERE account_id = ?", (account,))[0], 40)

    def test_saves_that_do_not_fit_the_puzzle_are_rejected(self):
        broken = state_for(LEVEL)
        broken["board"][0] = 99
        body = self.call("PUT", "/api/saves", {"saves": [{"puzzle": LEVEL["id"], "state": broken, "based_on": 0},
                                                          {"puzzle": "custom-unknown", "state": broken, "based_on": 0}]}, token=self.anu)[1]
        self.assertEqual(body["rejected"], [LEVEL["id"], "custom-unknown"])

    def test_changes_since_a_revision(self):
        rev = self.call("GET", "/api/saves?since=0", token=self.anu)[1]["rev"]
        self.call("PUT", "/api/saves", {"saves": [{"puzzle": LEVEL["id"], "state": state_for(LEVEL, 7), "based_on": 0}]}, token=self.anu)
        later = self.call("GET", f"/api/saves?since={rev}", token=self.anu)[1]
        self.assertEqual([s["puzzle"] for s in later["saves"]], [LEVEL["id"]])
        self.assertEqual(self.call("GET", f"/api/saves?since={later['rev']}", token=self.anu)[1]["saves"], [])

    # Made puzzles and sending

    def test_bad_puzzles_are_refused(self):
        for change in ({"width": 16}, {"colors": ["red", "#000000"]}, {"pixels": [0] * 1023}, {"pixels": [5] * 1024},
                       {"id": "level-1"}, {"title": ""}, {"colors": ["#000000", "#111111", "#222222"]}):
            self.assertEqual(self.call("POST", "/api/puzzles", {"art": {**made("custom-bad"), **change}}, token=self.anu)[0], 400, change)

    def test_sending_a_made_puzzle_puts_it_in_the_friends_free_play(self):
        self.assertEqual(self.call("POST", "/api/puzzles", {"art": made("custom-send1")}, token=self.hanmo)[0], 201)
        stored = saves.made_art(self.db, "custom-send1")
        self.assertEqual(stored["title"], "A cat", "titles are cleaned up")
        since = self.call("GET", "/api/saves?since=0", token=self.anu)[1]["rev"]
        status, body = self.call("POST", "/api/messages", {"to": "anushka", "puzzle": "custom-send1", "client_id": "send-0000001"}, token=self.hanmo)
        self.assertEqual(status, 201, body)
        library = self.call("GET", f"/api/saves?since={since}", token=self.anu)[1]["library"]
        self.assertEqual([(l["puzzle"], l["from"]) for l in library], [("custom-send1", "hanmo")])
        self.assertEqual(library[0]["art"]["pixels"], made()["pixels"])

    def test_only_puzzles_you_made_can_be_sent(self):
        self.call("POST", "/api/puzzles", {"art": made("custom-only1")}, token=self.hanmo)
        self.call("POST", "/api/messages", {"to": "anushka", "puzzle": "custom-only1", "client_id": "only-0000001"}, token=self.hanmo)
        for puzzle in ("custom-only1", LEVEL["id"], "custom-missing"):
            status, _ = self.call("POST", "/api/messages", {"to": "hanmo", "puzzle": puzzle, "client_id": f"only-{puzzle}"}, token=self.anu)
            self.assertEqual(status, 403, puzzle)
        self.call("DELETE", "/api/puzzles/custom-only1", token=self.hanmo)
        status, _ = self.call("POST", "/api/messages", {"to": "anushka", "puzzle": "custom-only1", "client_id": "only-0000002"}, token=self.hanmo)
        self.assertEqual(status, 403, "a removed puzzle can't be sent")

    def test_a_received_puzzle_removed_can_come_back_and_the_id_is_not_stealable(self):
        self.call("POST", "/api/puzzles", {"art": made("custom-back1")}, token=self.hanmo)
        self.call("POST", "/api/messages", {"to": "anushka", "puzzle": "custom-back1", "client_id": "back-0000001"}, token=self.hanmo)
        self.assertEqual(self.call("DELETE", "/api/puzzles/custom-back1", token=self.anu)[0], 200)
        self.assertEqual(self.call("POST", "/api/puzzles", {"art": {"id": "custom-back1"}}, token=self.anu)[0], 200)
        stranger = self.sign_in("stranger", "third-password")
        self.assertEqual(self.call("POST", "/api/puzzles", {"art": made("custom-back1")}, token=stranger)[0], 409)

    def test_finishing_a_sent_puzzle_tells_the_sender_once(self):
        art = made("custom-done1")
        self.call("POST", "/api/puzzles", {"art": art}, token=self.hanmo)
        self.call("POST", "/api/messages", {"to": "anushka", "puzzle": "custom-done1", "client_id": "done-0000001"}, token=self.hanmo)
        self.call("PUT", "/api/saves", {"saves": [{"puzzle": "custom-done1", "state": state_for(art, moves=64), "based_on": 0}]}, token=self.anu)
        rev = self.call("GET", "/api/saves?since=0", token=self.anu)[1]["rev"]
        self.call("PUT", "/api/saves", {"saves": [{"puzzle": "custom-done1", "state": state_for(art, moves=65, saved_at=9), "based_on": rev}]}, token=self.anu)
        notes = [m for m in self.call("GET", "/api/messages", token=self.hanmo)[1]["messages"]
                 if m["kind"] == "finished" and m["puzzle"] == "custom-done1"]
        self.assertEqual([(n["from"], n["to"], n["moves"]) for n in notes], [("anushka", "hanmo", 64)])

    # Chat

    def test_text_is_cleaned_limited_and_only_between_friends(self):
        ok = self.call("POST", "/api/messages", {"to": "hanmo", "text": " hi\x07 <b>there</b>\r\n ", "client_id": "text-0000001"}, token=self.anu)
        self.assertEqual(ok[1]["message"]["text"], "hi <b>there</b>", "stored as text; the browser shows it as text")
        self.assertEqual(self.call("POST", "/api/messages", {"to": "hanmo", "text": "x" * 1001, "client_id": "text-0000002"}, token=self.anu)[0], 400)
        self.assertEqual(self.call("POST", "/api/messages", {"to": "stranger", "text": "hi", "client_id": "text-0000003"}, token=self.anu)[0], 403)

    def test_a_retry_does_not_send_twice(self):
        first = self.call("POST", "/api/messages", {"to": "hanmo", "text": "once", "client_id": "retry-000001"}, token=self.anu)
        again = self.call("POST", "/api/messages", {"to": "hanmo", "text": "once", "client_id": "retry-000001"}, token=self.anu)
        self.assertEqual((first[0], again[0]), (201, 200))
        self.assertEqual(first[1]["message"]["id"], again[1]["message"]["id"])

    def test_unread_count_and_reading(self):
        start = self.call("GET", "/api/me", token=self.hanmo)[1]["unread"]
        sent = self.call("POST", "/api/messages", {"to": "hanmo", "text": "new", "client_id": "unread-00001"}, token=self.anu)[1]["message"]
        self.assertEqual(self.call("GET", "/api/me", token=self.hanmo)[1]["unread"], start + 1)
        self.assertEqual(self.call("POST", "/api/messages/read", {"friend": "anushka", "up_to": sent["id"]}, token=self.hanmo)[1]["unread"], 0)

    def test_scrolling_back_reaches_the_first_message(self):
        for n in range(chat.PAGE + 5):
            chat.recent.clear()
            self.call("POST", "/api/messages", {"to": "anushka", "text": f"m{n}", "client_id": f"page-{n:08d}"}, token=self.hanmo)
        newest = self.call("GET", "/api/messages", token=self.anu)[1]
        seen, before, start = list(newest["messages"]), newest["messages"][0]["id"], newest["start"]
        while not start:
            page = self.call("GET", f"/api/messages?before={before}", token=self.anu)[1]
            seen = page["messages"] + seen
            start = page["start"]
            if page["messages"]:
                before = page["messages"][0]["id"]
        first = self.db.one("SELECT min(id) FROM messages WHERE from_id IN (SELECT id FROM accounts WHERE name IN ('anushka','hanmo')) "
                            "AND to_id IN (SELECT id FROM accounts WHERE name IN ('anushka','hanmo'))")[0]
        self.assertEqual(seen[0]["id"], first)
        self.assertEqual(len({m["id"] for m in seen}), len(seen))

    def test_the_rate_limit_holds(self):
        statuses = [self.call("POST", "/api/messages", {"to": "hanmo", "text": "x", "client_id": f"fast-{n:08d}"}, token=self.anu)[0]
                    for n in range(chat.PER_MINUTE + 1)]
        self.assertEqual(statuses[-1], 429)

    # Backups

    def test_backup_is_a_full_copy(self):
        target = self.db.backup("jewels-test.db")
        copy = Database(target, backups=Path(TEMP.name) / "unused")
        self.assertEqual(copy.one("SELECT count(*) FROM accounts")[0], self.db.one("SELECT count(*) FROM accounts")[0])


if __name__ == "__main__":
    unittest.main()
