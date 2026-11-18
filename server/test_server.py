"""Tests for the server, run against a throwaway database:

    cd server && .venv/bin/python -m unittest test_server
"""

import contextlib
import io
import json
import random
import os
import tempfile
import subprocess
import threading
import uuid
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock
from pathlib import Path

TEMP = tempfile.TemporaryDirectory()
# No real textbot token and an address nothing listens on, so no test can text a real phone
# (set before importing the server, whose .env loading never overrides what's already set).
os.environ.update(DB_FILE=str(Path(TEMP.name) / "test.db"), USE_MODEL="0", USE_AGENT="0",
                  TEXTBOT_NOTIFY_TOKEN="", TEXTBOT_URL="http://127.0.0.1:9/notify")

import accounts  # noqa: E402
import chat  # noqa: E402
import gauntlets  # noqa: E402
import generator  # noqa: E402
import saves  # noqa: E402
import server  # noqa: E402
import texts  # noqa: E402
from db import Database  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

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


class Harness(unittest.TestCase):
    """One throwaway database with three accounts, shared by every test class, and a server per class."""
    @classmethod
    def setUpClass(cls):
        if server.db is None:
            server.db = Database(Path(TEMP.name) / "test.db")
            accounts.add_account(server.db, "billy", "first-password")
            accounts.add_account(server.db, "bob", "second-password")
            accounts.add_account(server.db, "stranger", "third-password")
            accounts.befriend(server.db, "billy", "bob")
        cls.db = server.db
        server.Handler.log_message = lambda *args: None  # keep test output quiet
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

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
        self.billy = self.sign_in(" Billy ", "first-password")
        self.bob = self.sign_in("bob", "second-password")


class ServerTest(Harness):
    # Sign-in and sessions

    def test_wrong_name_and_wrong_password_get_the_same_answer(self):
        a = self.call("POST", "/api/login", {"name": "billy", "password": "nope"})
        b = self.call("POST", "/api/login", {"name": "nobody", "password": "nope"})
        self.assertEqual(a, b)
        self.assertEqual(a[0], 401)

    def test_twenty_wrong_tries_refuse_all_sign_ins_for_a_while(self):
        server.failures.extend([__import__("time").time()] * 20)
        status, _ = self.call("POST", "/api/login", {"name": "billy", "password": "first-password"})
        self.assertEqual(status, 429)

    def test_only_a_hash_of_the_token_is_stored_and_logout_ends_it(self):
        self.assertIsNone(self.db.one("SELECT 1 FROM sessions WHERE token_hash = ?", (self.billy,)))
        self.assertEqual(self.call("GET", "/api/me", token=self.billy)[1]["friends"], ["bob"])
        self.assertEqual(self.call("POST", "/api/logout", {}, token=self.billy)[0], 200)
        self.assertEqual(self.call("GET", "/api/me", token=self.billy)[0], 401)

    def test_logout_everywhere_and_new_password_end_every_session(self):
        other = self.sign_in("bob", "second-password")
        self.call("POST", "/api/logout", {"everywhere": True}, token=self.bob)
        self.assertEqual(self.call("GET", "/api/me", token=other)[0], 401)
        other = self.sign_in("bob", "second-password")
        accounts.set_password(self.db, "bob", "second-password")
        self.assertEqual(self.call("GET", "/api/me", token=other)[0], 401)

    def test_everything_but_sign_in_needs_a_token(self):
        for method, path in (("GET", "/api/saves"), ("GET", "/api/messages"), ("POST", "/api/jobs"), ("PUT", "/api/saves")):
            self.assertEqual(self.call(method, path, {} if method != "GET" else None, token="made-up")[0], 401, path)

    def test_passwords_are_scrypt_hashes(self):
        stored = self.db.one("SELECT password_hash FROM accounts WHERE name = 'billy'")[0]
        self.assertTrue(stored.startswith("scrypt$15$8$1$"))
        self.assertNotIn("first-password", stored)

    # Saves

    def test_saves_are_separate_per_account(self):
        self.call("PUT", "/api/saves", {"saves": [{"puzzle": LEVEL["id"], "state": state_for(LEVEL, 3), "based_on": 0}]}, token=self.billy)
        theirs = self.call("GET", "/api/saves?since=0", token=self.bob)[1]
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
                                                          {"puzzle": "custom-unknown", "state": broken, "based_on": 0}]}, token=self.billy)[1]
        self.assertEqual(body["rejected"], [LEVEL["id"], "custom-unknown"])

    def test_changes_since_a_revision(self):
        rev = self.call("GET", "/api/saves?since=0", token=self.billy)[1]["rev"]
        self.call("PUT", "/api/saves", {"saves": [{"puzzle": LEVEL["id"], "state": state_for(LEVEL, 7), "based_on": 0}]}, token=self.billy)
        later = self.call("GET", f"/api/saves?since={rev}", token=self.billy)[1]
        self.assertEqual([s["puzzle"] for s in later["saves"]], [LEVEL["id"]])
        self.assertEqual(self.call("GET", f"/api/saves?since={later['rev']}", token=self.billy)[1]["saves"], [])

    # Made puzzles and sending

    def test_bad_puzzles_are_refused(self):
        for change in ({"width": 16}, {"colors": ["red", "#000000"]}, {"pixels": [0] * 1023}, {"pixels": [5] * 1024},
                       {"id": "level-1"}, {"title": ""}, {"colors": ["#000000", "#111111", "#222222"]}):
            self.assertEqual(self.call("POST", "/api/puzzles", {"art": {**made("custom-bad"), **change}}, token=self.billy)[0], 400, change)

    def test_sending_a_made_puzzle_puts_it_in_the_friends_free_play(self):
        self.assertEqual(self.call("POST", "/api/puzzles", {"art": made("custom-send1")}, token=self.bob)[0], 201)
        stored = saves.made_art(self.db, "custom-send1")
        self.assertEqual(stored["title"], "A cat", "titles are cleaned up")
        since = self.call("GET", "/api/saves?since=0", token=self.billy)[1]["rev"]
        status, body = self.call("POST", "/api/messages", {"to": "billy", "puzzle": "custom-send1", "client_id": "send-0000001"}, token=self.bob)
        self.assertEqual(status, 201, body)
        library = self.call("GET", f"/api/saves?since={since}", token=self.billy)[1]["library"]
        self.assertEqual([(l["puzzle"], l["from"]) for l in library], [("custom-send1", "bob")])
        self.assertEqual(library[0]["art"]["pixels"], made()["pixels"])

    def test_only_puzzles_you_made_can_be_sent(self):
        self.call("POST", "/api/puzzles", {"art": made("custom-only1")}, token=self.bob)
        self.call("POST", "/api/messages", {"to": "billy", "puzzle": "custom-only1", "client_id": "only-0000001"}, token=self.bob)
        for puzzle in ("custom-only1", LEVEL["id"], "custom-missing"):
            status, _ = self.call("POST", "/api/messages", {"to": "bob", "puzzle": puzzle, "client_id": f"only-{puzzle}"}, token=self.billy)
            self.assertEqual(status, 403, puzzle)
        self.call("DELETE", "/api/puzzles/custom-only1", token=self.bob)
        status, _ = self.call("POST", "/api/messages", {"to": "billy", "puzzle": "custom-only1", "client_id": "only-0000002"}, token=self.bob)
        self.assertEqual(status, 403, "a removed puzzle can't be sent")

    def test_a_received_puzzle_removed_can_come_back_and_the_id_is_not_stealable(self):
        self.call("POST", "/api/puzzles", {"art": made("custom-back1")}, token=self.bob)
        self.call("POST", "/api/messages", {"to": "billy", "puzzle": "custom-back1", "client_id": "back-0000001"}, token=self.bob)
        self.assertEqual(self.call("DELETE", "/api/puzzles/custom-back1", token=self.billy)[0], 200)
        self.assertEqual(self.call("POST", "/api/puzzles", {"art": {"id": "custom-back1"}}, token=self.billy)[0], 200)
        stranger = self.sign_in("stranger", "third-password")
        self.assertEqual(self.call("POST", "/api/puzzles", {"art": made("custom-back1")}, token=stranger)[0], 409)

    def test_finishing_a_sent_puzzle_tells_the_sender_once(self):
        art = made("custom-done1")
        self.call("POST", "/api/puzzles", {"art": art}, token=self.bob)
        self.call("POST", "/api/messages", {"to": "billy", "puzzle": "custom-done1", "client_id": "done-0000001"}, token=self.bob)
        self.call("PUT", "/api/saves", {"saves": [{"puzzle": "custom-done1", "state": state_for(art, moves=64), "based_on": 0}]}, token=self.billy)
        rev = self.call("GET", "/api/saves?since=0", token=self.billy)[1]["rev"]
        self.call("PUT", "/api/saves", {"saves": [{"puzzle": "custom-done1", "state": state_for(art, moves=65, saved_at=9), "based_on": rev}]}, token=self.billy)
        notes = [m for m in self.call("GET", "/api/messages", token=self.bob)[1]["messages"]
                 if m["kind"] == "finished" and m["puzzle"] == "custom-done1"]
        self.assertEqual([(n["from"], n["to"], n["moves"]) for n in notes], [("billy", "bob", 64)])

    # Chat

    def test_text_is_cleaned_limited_and_only_between_friends(self):
        ok = self.call("POST", "/api/messages", {"to": "bob", "text": " hi\x07 <b>there</b>\r\n ", "client_id": "text-0000001"}, token=self.billy)
        self.assertEqual(ok[1]["message"]["text"], "hi <b>there</b>", "stored as text; the browser shows it as text")
        self.assertEqual(self.call("POST", "/api/messages", {"to": "bob", "text": "x" * 1001, "client_id": "text-0000002"}, token=self.billy)[0], 400)
        self.assertEqual(self.call("POST", "/api/messages", {"to": "stranger", "text": "hi", "client_id": "text-0000003"}, token=self.billy)[0], 403)

    def test_a_retry_does_not_send_twice(self):
        first = self.call("POST", "/api/messages", {"to": "bob", "text": "once", "client_id": "retry-000001"}, token=self.billy)
        again = self.call("POST", "/api/messages", {"to": "bob", "text": "once", "client_id": "retry-000001"}, token=self.billy)
        self.assertEqual((first[0], again[0]), (201, 200))
        self.assertEqual(first[1]["message"]["id"], again[1]["message"]["id"])

    def test_unread_count_and_reading(self):
        start = self.call("GET", "/api/me", token=self.bob)[1]["unread"]
        sent = self.call("POST", "/api/messages", {"to": "bob", "text": "new", "client_id": "unread-00001"}, token=self.billy)[1]["message"]
        self.assertEqual(self.call("GET", "/api/me", token=self.bob)[1]["unread"], start + 1)
        self.assertEqual(self.call("POST", "/api/messages/read", {"friend": "billy", "up_to": sent["id"]}, token=self.bob)[1]["unread"], 0)

    def test_scrolling_back_reaches_the_first_message(self):
        for n in range(chat.PAGE + 5):
            chat.recent.clear()
            self.call("POST", "/api/messages", {"to": "billy", "text": f"m{n}", "client_id": f"page-{n:08d}"}, token=self.bob)
        newest = self.call("GET", "/api/messages", token=self.billy)[1]
        seen, before, start = list(newest["messages"]), newest["messages"][0]["id"], newest["start"]
        while not start:
            page = self.call("GET", f"/api/messages?before={before}", token=self.billy)[1]
            seen = page["messages"] + seen
            start = page["start"]
            if page["messages"]:
                before = page["messages"][0]["id"]
        first = self.db.one("SELECT min(id) FROM messages WHERE from_id IN (SELECT id FROM accounts WHERE name IN ('billy','bob')) "
                            "AND to_id IN (SELECT id FROM accounts WHERE name IN ('billy','bob'))")[0]
        self.assertEqual(seen[0]["id"], first)
        self.assertEqual(len({m["id"] for m in seen}), len(seen))

    def test_the_rate_limit_holds(self):
        statuses = [self.call("POST", "/api/messages", {"to": "bob", "text": "x", "client_id": f"fast-{n:08d}"}, token=self.billy)[0]
                    for n in range(chat.PER_MINUTE + 1)]
        self.assertEqual(statuses[-1], 429)

    # Backups

    def test_backup_is_a_full_copy(self):
        target = self.db.backup("jewels-test.db")
        copy = Database(target, backups=Path(TEMP.name) / "unused")
        self.assertEqual(copy.one("SELECT count(*) FROM accounts")[0], self.db.one("SELECT count(*) FROM accounts")[0])


class TextTest(Harness):
    """Texts. texts.text_player is swapped for a fake that records calls, and the clock is
    passed in, so nothing waits 10 minutes or talks to textbot."""
    MINUTE = 60 * 1000

    def setUp(self):
        super().setUp()
        self.texts = []
        self.fake = mock.patch.object(texts, "text_player", lambda who, text: self.texts.append((who, text)))
        self.fake.start()
        self.token = mock.patch.dict(os.environ, TEXTBOT_NOTIFY_TOKEN="test-token")
        self.token.start()
        # Earlier tests left unread messages; start each test with nothing due.
        newest = self.db.one("SELECT coalesce(max(id), 0) FROM messages")[0]
        for (account,) in self.db.read("SELECT id FROM accounts"):
            chat.mark_noticed(self.db, account, newest)
        with self.db.transaction() as conn:
            conn.execute("DELETE FROM notify_settings")  # everyone back to all on
        self.billy_id = accounts.account_id(self.db, "billy")

    def tearDown(self):
        self.fake.stop()
        self.token.stop()

    def message(self, text="see you at 5", to="billy", token=None, client_id=None):
        client_id = client_id or f"note-{len(self.texts)}-{__import__('uuid').uuid4().hex[:8]}"
        status, body = self.call("POST", "/api/messages", {"to": to, "text": text, "client_id": client_id}, token=token or self.bob)
        self.assertIn(status, (200, 201), body)
        return body["message"]

    def check(self, minutes_from_now):
        """One run of the background check, as if this many minutes had passed."""
        with contextlib.redirect_stdout(io.StringIO()):
            return server.send_notices(now=chat.now_ms() + minutes_from_now * self.MINUTE)

    def test_one_text_ten_minutes_after_an_unread_message_and_no_more(self):
        self.message("my secret plans")
        self.assertEqual(self.check(9), 0, "not yet")
        self.assertEqual(self.check(11), 1)
        self.assertEqual(self.texts, [(self.billy_id, "Bob sent you a new message in Pixel Game")])
        self.assertNotIn("secret", self.texts[0][1], "never the message itself")
        self.assertEqual(self.check(30), 0, "once only, until a new message")

    def test_a_new_message_restarts_the_clock_and_allows_one_more_text(self):
        first = self.message("one")
        self.db.conn.execute("UPDATE messages SET created_at = created_at - ? WHERE id = ?", (5 * self.MINUTE, first["id"]))
        self.message("two")  # sent now: the 10 minutes start again
        self.assertEqual(self.check(6), 0, "11 minutes after the first, but only 6 after the newest")
        self.assertEqual(self.check(11), 1)
        self.message("three")
        self.assertEqual(self.check(11), 1, "a newer message: one more text")
        self.assertEqual(len(self.texts), 2)

    def test_reading_in_time_means_no_text(self):
        sent = self.message()
        self.call("POST", "/api/messages/read", {"friend": "bob", "up_to": sent["id"]}, token=self.billy)
        self.assertEqual(self.check(11), 0)
        self.assertEqual(self.texts, [])

    def test_a_retry_with_the_same_client_id_is_not_a_new_message(self):
        self.message(client_id="same-id-0001")
        self.assertEqual(self.check(11), 1)
        self.message(client_id="same-id-0001")  # the browser retried: 200, nothing new
        self.assertEqual(self.check(30), 0)

    def test_a_sent_puzzle_counts_as_unread_too(self):
        self.call("POST", "/api/puzzles", {"art": made("custom-texted")}, token=self.bob)
        status, _ = self.call("POST", "/api/messages", {"to": "billy", "puzzle": "custom-texted", "client_id": "puzzle-texted1"}, token=self.bob)
        self.assertEqual(status, 201)
        self.assertEqual(self.check(11), 1)

    def send_puzzle(self, pid, client_id):
        self.call("POST", "/api/puzzles", {"art": made(pid)}, token=self.bob)
        status, _ = self.call("POST", "/api/messages", {"to": "billy", "puzzle": pid, "client_id": client_id}, token=self.bob)
        self.assertEqual(status, 201)

    def finish(self, pid, client_id):
        """Bob sends Billy a puzzle and Billy finishes it: Bob gets a 'finished' event."""
        art = made(pid)
        self.call("POST", "/api/puzzles", {"art": art}, token=self.billy)
        self.call("POST", "/api/messages", {"to": "bob", "puzzle": pid, "client_id": client_id}, token=self.billy)
        self.call("PUT", "/api/saves", {"saves": [{"puzzle": pid, "state": state_for(art, moves=40), "based_on": 0}]}, token=self.bob)

    def settings(self, token=None, **change):
        if change:
            return self.call("PUT", "/api/notifications", change, token=token or self.billy)
        return self.call("GET", "/api/notifications", token=token or self.billy)

    def test_notification_settings_start_on_and_save_per_account(self):
        self.assertEqual(self.settings(), (200, {"messages": True, "puzzles": True, "finished": True}))
        self.assertEqual(self.settings(puzzles=False), (200, {"messages": True, "puzzles": False, "finished": True}))
        self.assertEqual(self.settings()[1]["puzzles"], False, "kept")
        self.assertEqual(self.settings(token=self.bob)[1]["puzzles"], True, "only for that account")
        for bad in ({}, {"puzzles": "no"}, {"sounds": True}, {"messages": 1}):
            self.assertEqual(self.settings(**bad)[0] if bad else self.call("PUT", "/api/notifications", {}, token=self.billy)[0], 400, bad)
        self.assertEqual(self.call("GET", "/api/notifications")[0], 401, "signed in only")

    def test_a_kind_that_is_off_never_causes_a_text(self):
        self.settings(messages=False)
        self.message()
        self.assertEqual(self.check(11), 0)
        self.send_puzzle("custom-kinds1", "kinds-000001")
        self.assertEqual(self.check(11), 1, "puzzles are still on")
        self.assertEqual(self.texts, [(self.billy_id, "Bob sent you a new puzzle in Pixel Game")], "and the message isn't mentioned")

    def test_a_kind_that_is_off_does_not_restart_the_ten_minutes(self):
        sent = self.message()
        self.db.conn.execute("UPDATE messages SET created_at = created_at - ? WHERE id = ?", (11 * self.MINUTE, sent["id"]))
        self.settings(puzzles=False)
        self.send_puzzle("custom-kinds2", "kinds-000002")  # now, but puzzles are off
        self.assertEqual(self.check(0), 1, "11 minutes after the message")
        self.assertEqual(self.texts, [(self.billy_id, "Bob sent you a new message in Pixel Game")])

    def test_switching_a_kind_on_never_texts_about_older_events(self):
        self.settings(messages=False)
        self.message("before")
        self.settings(messages=True)
        self.assertEqual(self.check(11), 0, "it arrived while messages were off")
        self.message("after")
        self.assertEqual(self.check(11), 1)
        self.assertEqual(self.texts, [(self.billy_id, "Bob sent you a new message in Pixel Game")], "only the newer one counts")

    def test_finished_puzzles_text_the_sender_and_respect_their_setting(self):
        self.finish("custom-kinds3", "kinds-000003")  # Billy sent it, Bob finished it
        self.check(11)
        self.assertIn((self.billy_id, "Bob finished your puzzle in Pixel Game"), self.texts)
        self.texts.clear()
        self.settings(finished=False)
        self.finish("custom-kinds4", "kinds-000004")
        self.check(11)
        self.assertNotIn(self.billy_id, [who for who, _ in self.texts])

    def test_the_text_names_each_kind(self):
        rows = lambda *kinds, sender="bob": [{"sender": sender, "kind": k} for k in kinds]
        for unread, text in ((rows("text"), "Bob sent you a new message"),
                             (rows("text", "text", "text"), "Bob sent you 3 new messages"),
                             (rows("puzzle", "text"), "Bob sent you a new message and a new puzzle"),
                             (rows("puzzle", "puzzle"), "Bob sent you 2 new puzzles"),
                             (rows("finished"), "Bob finished your puzzle"),
                             (rows("finished", "finished", "text"), "Bob sent you a new message and finished 2 of your puzzles"),
                             (rows("text") + rows("finished", sender="ann"), "Ann finished your puzzle and Bob sent you a new message")):
            self.assertEqual(chat.notice_text(unread), text + " in Pixel Game")

    def test_no_token_means_no_texts(self):
        self.message()
        with mock.patch.dict(os.environ, TEXTBOT_NOTIFY_TOKEN=""):
            self.assertEqual(self.check(11), 0)
        self.assertEqual(self.texts, [])

    def test_textbot_failing_never_breaks_chat_and_is_tried_once(self):
        def broken(who, text):
            self.texts.append((who, text))
            raise urllib.error.URLError("textbot is not running")
        with mock.patch.object(texts, "text_player", broken):
            self.message()
            self.assertEqual(self.check(11), 0, "the failure is logged, not raised")
            self.assertEqual(self.check(12), 0, "and not retried every minute")
        self.assertEqual(len(self.texts), 1)
        status, _ = self.call("POST", "/api/messages", {"to": "billy", "text": "still works", "client_id": "after-fail-01"}, token=self.bob)
        self.assertEqual(status, 201)

    def test_text_player_sends_only_the_account_id_with_the_token(self):
        """The real text_player, against a stand-in for textbot on this machine."""
        got = []

        class FakeTextbot(BaseHTTPRequestHandler):
            def do_POST(self):
                got.append((self.path, self.headers["Authorization"], json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                answer = 404 if got[-1][2]["to"] == "3" else 200
                self.send_response(answer); self.send_header("Content-Length", "0"); self.end_headers()

            def log_message(self, *args):
                pass

        textbot = ThreadingHTTPServer(("127.0.0.1", 0), FakeTextbot)
        threading.Thread(target=textbot.serve_forever, daemon=True).start()
        self.fake.stop()  # use the real one
        try:
            with mock.patch.dict(os.environ, TEXTBOT_URL=f"http://127.0.0.1:{textbot.server_address[1]}/notify"):
                texts.text_player(2, "You have unread messages from Billy in Pixel Game")
                with self.assertRaises(urllib.error.HTTPError):
                    texts.text_player(3, "no such contact")
        finally:
            self.fake.start()
            textbot.shutdown()
            textbot.server_close()
        self.assertEqual(got[0], ("/notify", "Bearer test-token", {"to": "2", "text": "You have unread messages from Billy in Pixel Game"}))

    # Any text, to any accounts (texts.send_text and its command line)

    def ids(self, *names):
        return [accounts.account_id(self.db, name) for name in names]

    def test_send_text_to_some_accounts_or_all(self):
        billy, bob = self.ids("billy", "bob")
        everyone = [row["id"] for row in self.db.read("SELECT id FROM accounts ORDER BY id")]
        self.assertEqual(texts.send_text(self.db, "  Hello!  ", [bob]), {bob: "sent"})
        self.assertEqual(texts.send_text(self.db, "Both", [str(bob), billy, billy]), {billy: "sent", bob: "sent"}, "each once, in order")
        self.assertEqual(texts.send_text(self.db, "Everyone", "all"), {i: "sent" for i in everyone})
        self.assertEqual(self.texts[0], (bob, "Hello!"), "trimmed, and only the ID goes to textbot")
        self.assertEqual(len(self.texts), 3 + len(everyone))

    def test_send_text_checks_everything_before_sending_anything(self):
        bob, = self.ids("bob")
        for text, to, problem in (("Hi", [bob, 999], "No account with ID 999"),
                                  ("Hi", ["bob"], "Account IDs are numbers"),
                                  ("Hi", [], "Say who"),
                                  ("", [bob], "1 to 300 characters"),
                                  ("x" * 301, [bob], "1 to 300 characters")):
            with self.assertRaisesRegex(ValueError, problem):
                texts.send_text(self.db, text, to)
        with mock.patch.dict(os.environ, TEXTBOT_NOTIFY_TOKEN=""), self.assertRaisesRegex(ValueError, "texts are off"):
            texts.send_text(self.db, "Hi", [bob])
        self.assertEqual(self.texts, [], "nothing was sent")

    def test_one_failing_text_does_not_stop_the_rest(self):
        billy, bob = self.ids("billy", "bob")

        def no_contact_for_billy(who, text):
            if who == billy:
                raise urllib.error.HTTPError("http://textbot", 404, "no contact", {}, None)
            self.texts.append((who, text))
        with mock.patch.object(texts, "text_player", no_contact_for_billy):
            results = texts.send_text(self.db, "Hi", [billy, bob])
        self.assertEqual(results, {billy: "no phone number for this account in textbot's contacts", bob: "sent"})

    def test_the_command_line(self):
        bob, = self.ids("bob")
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(texts.main(["Dinner's ready", str(bob)]), 0)
            self.assertEqual(texts.main(["To everyone", "ALL"]), 0)
            self.assertEqual(texts.main(["Hi", "nobody"]), 2, "a bad ID sends nothing")
            self.assertEqual(texts.main(["only a text"]), 2, "says how to use it")
        self.assertIn(f"{bob} bob: sent", out.getvalue())
        self.assertIn("Account IDs are numbers", err.getvalue())
        self.assertIn('texts.py "New puzzles are up!" all', err.getvalue())
        self.assertEqual(len(self.texts), 1 + self.db.one("SELECT count(*) FROM accounts")[0])


class FakeModel:
    """Stands in for Z-Image: a red ball on white, and a note of every prompt."""

    def __init__(self, broken=False):
        self.prompts, self.broken = [], broken

    def generate_image(self, seed, prompt, **_):
        from PIL import Image, ImageDraw
        if self.broken:
            raise RuntimeError("out of memory")
        self.prompts.append(prompt)
        picture = Image.new("RGB", (512, 512), (250, 250, 250))
        ImageDraw.Draw(picture).ellipse((140, 140, 372, 372), fill=(220, 40, 40), outline=(30, 30, 40), width=12)
        return type("Result", (), {"image": picture})()


def valid(art):
    return saves.valid_art({**art, "id": "custom-test1"}) is not None


class GeneratorTest(unittest.TestCase):
    """generator.py: the pipelines and their steps."""
    IDEA, SUBJECT = "a sleepy cat", "a curled gray cat with closed eyes"

    def setUp(self):
        self.agent = mock.patch.object(generator, "USE_AGENT", False)
        self.agent.start()

    def tearDown(self):
        self.agent.stop()

    def test_create_plan_is_all_current_or_in_the_test_two_of_each_shuffled(self):
        with mock.patch.object(generator, "PAINTER_TEST", False):
            self.assertEqual(generator.create_plan(), ["current"] * 4)
        with mock.patch.object(generator, "PAINTER_TEST", True):
            plans = {tuple(generator.create_plan()) for _ in range(40)}
        self.assertTrue(all(sorted(p) == ["current", "current", "painter", "painter"] for p in plans))
        self.assertGreater(len(plans), 1, "not always the same order")

    def test_wording_as_typed_through_the_artist_or_as_a_word_soup(self):
        self.assertEqual(generator.wording("painter", self.IDEA, "bob", "t"), {"subject": self.IDEA, "agent": False, "title": "A sleepy cat"})
        with mock.patch.object(generator, "artist", return_value=(self.SUBJECT, True)) as artist:
            self.assertEqual(generator.wording("current", self.IDEA, "bob", "t")["subject"], self.SUBJECT)
            artist.assert_called_once_with(self.IDEA, "t", "bob")
            words = generator.wording("soup", "", "bob", "t")
        self.assertTrue(3 <= len(words["words"]) <= 5)
        self.assertEqual(artist.call_args[0][0], " ".join(words["words"]), "the artist blends the soup")
        self.assertEqual(words["title"], generator.title_for(", ".join(words["words"]), 80))

    def test_a_soup_is_three_to_five_different_familiar_words(self):
        rng = random.Random(3)
        known = {w for group in ("describers", "creatures", "things", "doings") for w in generator.WORDS[group]}
        for _ in range(200):
            words = generator.soup(rng)
            self.assertTrue(3 <= len(words) <= 5, words)
            self.assertEqual(len(set(words)), len(words), "no word twice")
            self.assertTrue(set(words) <= known)
            self.assertTrue(set(words) & set(generator.WORDS["describers"]), "a describer")
            self.assertTrue(set(words) & set(generator.WORDS["creatures"] + generator.WORDS["things"]), "something to draw")

    def test_the_server_converts_exactly_as_the_browser_did(self):
        picture = FakeModel().generate_image(1, "x").image
        png = generator.picture_png(picture)
        art = generator.converter.convert(png, "A red ball")
        self.assertTrue(valid(art))
        self.assertEqual(art["title"], "A red ball")
        # The browser decoded the same 256 px PNG and ran convert.js on its pixels.
        from PIL import Image
        with tempfile.TemporaryDirectory() as folder:
            Image.open(io.BytesIO(png)).convert("RGBA").save(Path(folder) / "p.png")
            (Path(folder) / "p.rgba").write_bytes(Image.open(Path(folder) / "p.png").tobytes())
            script = (f"import {{ convertImage }} from '{(ROOT / 'convert.js').as_uri()}'; import {{ readFileSync }} from 'node:fs';"
                      f"const a = convertImage(new Uint8ClampedArray(readFileSync('{Path(folder) / 'p.rgba'}')), 256, 256, {{ title: 'A red ball' }});"
                      "delete a.id; console.log(JSON.stringify(a));")
            browser = json.loads(subprocess.run([generator.find_node(), "--input-type=module", "-e", script],
                                                capture_output=True, text=True, check=True).stdout)
        self.assertEqual(art, browser)

    def test_the_converter_starts_again_if_its_process_dies(self):
        png = generator.picture_png(FakeModel().generate_image(1, "x").image)
        generator.converter.convert(png, "One")
        generator.converter.process.kill()
        generator.converter.process.wait()
        self.assertTrue(valid(generator.converter.convert(png, "Two")))

    @unittest.skipUnless(generator.PAINTER_DIR.joinpath("painter-v3.safetensors").exists(), "painter v3's weights aren't on this machine")
    def test_painter_v3_turns_a_full_picture_into_valid_puzzle_art(self):
        variant, art = generator.puzzle("painter", FakeModel().generate_image(1, "x").image, "A red ball")
        self.assertEqual(variant, "painter")
        self.assertTrue(valid(art))
        self.assertLessEqual(len(art["colors"]), generator.PAINTER_COLORS)

    def test_if_the_painter_fails_convert_js_makes_it_marked_as_such(self):
        with mock.patch.object(generator.painting, "painted_puzzle", side_effect=RuntimeError("no model")), \
                contextlib.redirect_stderr(io.StringIO()):
            variant, art = generator.puzzle("painter", FakeModel().generate_image(1, "x").image, "A red ball")
        self.assertEqual(variant, "painter-failed")
        self.assertTrue(valid(art))

    def test_a_candidate_is_painted_with_the_style_line_and_comes_back_as_puzzle_art(self):
        model = FakeModel()
        made = generator.Generator(model).make("current", {"subject": self.SUBJECT, "agent": True, "title": "A sleepy cat"})
        self.assertEqual(model.prompts, [f"{self.SUBJECT}, one subject centered, {generator.STYLE}"])
        self.assertEqual((made["variant"], made["subject"], made["prompt"]), ("current", self.SUBJECT, model.prompts[0]))
        self.assertTrue(valid(made["art"]))
        self.assertEqual(generator.shown(made), {"variant": "current", "art": made["art"]}, "the browser gets the puzzle only")

    def test_a_test_job_keeps_its_pictures_and_where_each_was_shown(self):
        maker = generator.Generator(FakeModel())
        made = [maker.make(name, generator.wording(name, self.IDEA, "bob", "t")) for name in ("painter", "current")]
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(generator, "PAINTER_TEST_DIR", Path(folder)), \
                mock.patch.object(generator.painting, "painted_puzzle", return_value=made[1]["art"]):
            generator.save_test_job("a" * 32, {"prompt": self.IDEA, "account": "bob"}, self.SUBJECT, made)
            kept = json.loads((Path(folder) / ("a" * 32) / "job.json").read_text())
            self.assertTrue(all((Path(folder) / ("a" * 32) / k["file"]).exists() for k in kept["shown"]))
        self.assertEqual([(k["position"], k["variant"]) for k in kept["shown"]], [(1, made[0]["variant"]), (2, "current")])
        self.assertTrue(all("art" in k and "seed" in k and "prompt" in k for k in kept["shown"]))


class JobTest(Harness):
    """Create puzzle and the gauntlet as jobs, through the generator."""

    def setUp(self):
        super().setUp()
        self.patches = [mock.patch.object(generator, "USE_AGENT", False)]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()

    def job(self, kind="create", prompt="a red ball"):
        job_id = uuid.uuid4().hex
        server.jobs[job_id] = {"id": job_id, "kind": kind, "prompt": prompt, "account": "bob", "status": "queued", "painted": 0, "created": 0}
        return job_id

    def run_job(self, job_id, model=None):
        maker = generator.Generator(model or FakeModel())
        with contextlib.redirect_stdout(io.StringIO()):
            (server.run_gauntlet if server.jobs[job_id]["kind"] == "gauntlet" else server.run_create)(job_id, maker)
        return server.public_view(server.jobs.pop(job_id))

    def test_create_puzzle_sends_four_finished_puzzles(self):
        with mock.patch.object(generator, "PAINTER_TEST", False):
            view = self.run_job(self.job())
        self.assertEqual((view["status"], view["painted"], view["total"]), ("done", 4, 4))
        self.assertEqual([c["variant"] for c in view["candidates"]], ["current"] * 4)
        self.assertTrue(all(valid(c["art"]) and c["art"]["title"] == "A red ball" for c in view["candidates"]))
        self.assertNotIn("images", view, "never pictures")

    def test_in_the_painter_test_two_of_each_are_shuffled_and_the_job_kept(self):
        art = {"title": "A red ball", "width": 32, "height": 32, "colors": ["#ffffff", "#000000"], "pixels": [0, 1] * 512}
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(generator, "PAINTER_TEST", True), \
                mock.patch.object(generator, "PAINTER_TEST_DIR", Path(folder)), \
                mock.patch.object(generator.painting, "painted_puzzle", return_value=art):
            job_id = self.job()
            model = FakeModel()
            view = self.run_job(job_id, model)
            kept = json.loads((Path(folder) / job_id / "job.json").read_text())
        self.assertEqual(sorted(c["variant"] for c in view["candidates"]), ["current", "current", "painter", "painter"])
        self.assertEqual([k["variant"] for k in kept["shown"]], [c["variant"] for c in view["candidates"]], "saved in the order shown")
        self.assertEqual(sum(p.startswith("a red ball, one subject centered") for p in model.prompts), 4, "without the artist, all from the words")

    def test_a_gauntlet_is_five_word_soup_puzzles(self):
        model = FakeModel()
        view = self.run_job(self.job("gauntlet", "gauntlet"), model)
        self.assertEqual((view["status"], view["painted"], view["total"]), ("done", 5, 5))
        for puzzle, prompt in zip(view["puzzles"], model.prompts):
            self.assertEqual(puzzle["subject"], " ".join(puzzle["words"]), "without the artist, the soup itself")
            self.assertEqual(prompt, f"{puzzle['subject']}, one subject centered, {generator.STYLE}")
            self.assertTrue(valid(puzzle["art"]))
            self.assertEqual(puzzle["art"]["title"], generator.title_for(", ".join(puzzle["words"]), 80))

    def test_starting_a_gauntlet_needs_an_account_and_the_picture_model(self):
        self.assertEqual(self.call("POST", "/api/gauntlet", {}, token="")[0], 401)
        with mock.patch.object(server, "GAUNTLET_READY", False):
            self.assertEqual(self.call("POST", "/api/gauntlet", {}, token=self.bob)[0], 503, "no picture model in tests")
            with mock.patch.dict(server.model_state, status="ready"), mock.patch.object(server.waiting, "put") as queued:
                status, body = self.call("POST", "/api/gauntlet", {}, token=self.bob)
        self.assertEqual(status, 202)
        self.assertEqual(server.jobs[body["id"]]["kind"], "gauntlet")
        queued.assert_called_once_with(body["id"])
        del server.jobs[body["id"]]


class ReadyGauntletTest(Harness):
    """Gauntlets made ahead: one per account, made a puzzle at a time, handed out once."""

    def setUp(self):
        super().setUp()
        with self.db.transaction() as conn:
            conn.execute("DELETE FROM gauntlets")
        self.patches = [mock.patch.object(generator, "USE_AGENT", False), mock.patch.object(server, "GAUNTLET_READY", True),
                        mock.patch.object(server, "building", None), mock.patch.object(server, "refill_paused_until", 0.0)]
        for patch in self.patches:
            patch.start()
        self.accounts = [row["id"] for row in self.db.read("SELECT id FROM accounts ORDER BY id")]

    def tearDown(self):
        for patch in self.patches:
            patch.stop()

    def fill(self, model):
        """Run the worker's idle steps until nothing is left to make."""
        maker = generator.Generator(model)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            for _ in range(500):
                if server.building and server.building["writing"]:
                    server.building["writing"].result(timeout=10)  # let the artist finish
                if not server.refill_step(maker):
                    return
        self.fail("never finished")

    def test_each_account_gets_one_ready_gauntlet_made_a_puzzle_at_a_time(self):
        model, threads, go = FakeModel(), [], threading.Event()
        real = generator.artist

        def artist(*args):  # a slow artist: waits until the test lets it answer
            threads.append(threading.current_thread().name)
            go.wait(10)
            return real(*args)

        maker = generator.Generator(model)
        with mock.patch.object(generator, "artist", artist):
            self.assertTrue(server.refill_step(maker))
            self.assertEqual(server.building["puzzles"], [], "the first step only starts the artist")
            self.assertTrue(server.refill_step(maker), "still writing: the worker returns at once")
            self.assertEqual(model.prompts, [], "nothing painted while the artist writes")
            go.set()
            server.building["writing"].result(timeout=10)
            self.assertTrue(server.refill_step(maker))
            self.assertEqual(len(server.building["puzzles"]), 1, "then one picture per step, so a player never waits long")
            self.assertEqual(self.db.one("SELECT count(*) FROM gauntlets")[0], 0, "stored only once all five are made")
            self.fill(model)
        self.assertEqual(len(model.prompts), 5 * len(self.accounts))
        self.assertTrue(threads and all(name.startswith("gauntlet-writer") for name in threads), "the artist never runs on the picture worker")
        rows = self.db.read("SELECT account_id, puzzles FROM gauntlets ORDER BY account_id")
        self.assertEqual([r["account_id"] for r in rows], self.accounts, "exactly one each")
        for row in rows:
            puzzles = json.loads(row["puzzles"])
            self.assertEqual(len(puzzles), 5)
            self.assertTrue(all(valid(p["art"]) and "image" not in p for p in puzzles), "kept as puzzles, not pictures")
            self.assertLess(len(row["puzzles"]), 40_000, "a few KB per puzzle")
        self.assertFalse(server.refill_step(maker), "nothing more to make")

    def test_a_ready_gauntlet_is_handed_out_at_once_and_only_once(self):
        self.fill(FakeModel())
        bob = accounts.account_id(self.db, "bob")
        stored = json.loads(self.db.one("SELECT puzzles FROM gauntlets WHERE account_id = ?", (bob,))[0])
        status, body = self.call("POST", "/api/gauntlet", {}, token=self.bob)
        self.assertEqual(status, 202)
        job = self.call("GET", f"/api/jobs/{body['id']}", token=self.bob)[1]
        self.assertEqual((job["status"], job["ready"], job["painted"], job["total"]), ("done", True, 5, 5))
        self.assertEqual(job["puzzles"], stored)
        self.assertEqual(self.call("GET", f"/api/jobs/{body['id']}", token=self.billy)[0], 404, "only for its account")
        self.assertEqual(gauntlets.needing(self.db), [(bob, "bob")], "bob needs a new one")
        self.assertEqual(self.call("POST", "/api/gauntlet", {}, token=self.bob)[0], 503, "none ready: made live, which needs the picture model")
        model = FakeModel()
        self.fill(model)
        self.assertEqual(len(model.prompts), 5, "the next one is made for bob")

    def test_one_made_before_the_server_converted_puzzles_is_converted_when_taken(self):
        picture = generator.picture_png(FakeModel().generate_image(1, "x").image)
        old = [{"words": ["tiny", "cat", "in space"], "subject": "a tiny cat in space", "image": "data:image/png;base64," + __import__("base64").b64encode(picture).decode()}] * 5
        gauntlets.store(self.db, accounts.account_id(self.db, "bob"), old)
        body = self.call("POST", "/api/gauntlet", {}, token=self.bob)[1]
        job = self.call("GET", f"/api/jobs/{body['id']}", token=self.bob)[1]
        self.assertTrue(all(valid(p["art"]) and p["art"]["title"] == "Tiny, cat, in space" and "image" not in p for p in job["puzzles"]))

    def test_a_failed_puzzle_drops_the_partial_gauntlet_and_waits_before_trying_again(self):
        broken = generator.Generator(FakeModel(broken=True))
        with contextlib.redirect_stderr(io.StringIO()):
            for _ in range(20):
                if server.building and server.building["writing"]:
                    server.building["writing"].result(timeout=10)
                server.refill_step(broken)
                if server.refill_paused_until:
                    break
        self.assertIsNone(server.building)
        self.assertFalse(server.refill_step(generator.Generator(FakeModel())), "paused for a while")
        self.assertEqual(self.db.one("SELECT count(*) FROM gauntlets")[0], 0)

    def test_switched_off_nothing_is_made_or_handed_out(self):
        with mock.patch.object(server, "GAUNTLET_READY", False):
            self.assertFalse(server.refill_step(generator.Generator(FakeModel())))
            gauntlets.store(self.db, accounts.account_id(self.db, "bob"), [{"words": ["a"], "subject": "a", "art": {}}])
            self.assertEqual(self.call("POST", "/api/gauntlet", {}, token=self.bob)[0], 503, "made live, not taken from the ready ones")


if __name__ == "__main__":
    unittest.main()
