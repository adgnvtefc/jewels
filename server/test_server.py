"""Tests for the server, run against a throwaway database:

    cd server && .venv/bin/python -m unittest test_server
"""

import contextlib
import io
import json
import random
import os
import tempfile
import threading
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
import saves  # noqa: E402
import server  # noqa: E402
import texts  # noqa: E402
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


class PainterTestTest(unittest.TestCase):
    """The painter test: what gets painted, the painter's art, and the shuffled order kept."""
    IDEA, SUBJECT = "a sleepy cat", "a curled gray cat with closed eyes"

    @staticmethod
    def ball(color=(220, 40, 40)):
        from PIL import Image, ImageDraw
        picture = Image.new("RGB", (512, 512), (250, 250, 250))
        ImageDraw.Draw(picture).ellipse((140, 140, 372, 372), fill=color, outline=(30, 30, 40), width=12)
        return picture

    def test_off_all_four_come_from_the_artist(self):
        with mock.patch.object(server, "PAINTER_TEST", False):
            plan = server.paint_plan(self.IDEA, self.SUBJECT)
        self.assertEqual([v for v, _ in plan], ["current"] * 4)
        self.assertTrue(all(p.startswith(self.SUBJECT + ", one subject centered, flat vector") for _, p in plan))

    def test_on_two_rewritten_and_two_as_typed_with_the_same_style_line(self):
        with mock.patch.object(server, "PAINTER_TEST", True):
            plan = server.paint_plan(self.IDEA, self.SUBJECT)
        self.assertEqual([v for v, _ in plan], ["current", "current", "painter", "painter"])
        self.assertTrue(plan[0][1].startswith(self.SUBJECT + ", one subject centered, "))
        self.assertTrue(plan[2][1].startswith(self.IDEA + ", one subject centered, "), "the player's words, untouched")
        self.assertEqual(plan[0][1].split("centered, ")[1], plan[2][1].split("centered, ")[1])

    def test_the_cleanup_makes_valid_calm_art_and_leaves_the_background_alone(self):
        import numpy as np
        palette = np.array([[255, 255, 255], [200, 30, 30], [203, 32, 31], [20, 20, 30], [40, 200, 60]])
        grid = np.zeros((32, 32), int)
        grid[8:24, 8:24] = 1
        grid[8:24, 16:24] = 2      # nearly the same red: merged into one
        grid[4, 4] = 3             # a lone speck on the background: cleared
        grid[12:14, 12:14] = 4     # a small green patch: kept
        art = server.painting.art_from_grid(grid, palette, "A red square")
        self.assertIsNotNone(saves.valid_art({**art, "id": "custom-abc"}))
        self.assertEqual(sorted(art["colors"]), ["#28c83c", "#cb201f", "#ffffff"], "the two reds merged into the commoner")
        self.assertEqual(art["pixels"][0], art["colors"].index("#ffffff"), "white background")
        self.assertIsNone(server.painting.art_from_grid(np.zeros((32, 32), int), palette, "Blank"), "one color is no puzzle")

    @unittest.skipUnless(server.PAINTER_DIR.joinpath("painter.py").exists(), "painter v3 isn't on this machine")
    def test_painter_v3_turns_a_full_picture_into_valid_puzzle_art(self):
        found = server.candidate("painter", self.ball(), "a red ball")
        self.assertEqual(found["variant"], "painter")
        art = found["art"]
        self.assertEqual(art["title"], "A red ball")
        self.assertIsNotNone(saves.valid_art({**art, "id": "custom-ball1"}))
        self.assertLessEqual(len(art["colors"]), server.PAINTER_COLORS)

    def test_if_the_painter_fails_the_picture_goes_to_the_browser_marked_as_such(self):
        with mock.patch.object(server.painting, "painted_puzzle", side_effect=RuntimeError("no model")), \
                contextlib.redirect_stderr(io.StringIO()):
            found = server.candidate("painter", self.ball(), "a red ball")
        self.assertEqual(found["variant"], "painter-failed")
        self.assertTrue(found["image"].startswith("data:image/png;base64,"))
        self.assertTrue(server.candidate("current", self.ball(), "a red ball")["image"].startswith("data:image/png"))

    def test_candidates_are_shuffled_and_the_order_shown_is_kept(self):
        art = {"title": "A sleepy cat", "width": 32, "height": 32, "colors": ["#ffffff", "#000000"], "pixels": [0, 1] * 512}
        painted = [{"picture": self.ball((n * 60, 40, 40)), "file": f"{n}-{v}.png", "variant": v, "prompt": f"p{n}", "seed": 100 + n}
                   for n, v in enumerate(["current", "current", "painter", "painter"])]
        orders = set()
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(server, "PAINTER_TEST_DIR", Path(folder)), \
                mock.patch.object(server.painting, "painted_puzzle", return_value=art):
            for n in range(12):
                job_id = f"{n:032x}"
                shown = server.test_candidates(job_id, {"prompt": self.IDEA, "account": "bob"}, self.SUBJECT, painted)
                orders.add(tuple(c["variant"] for c in shown))
                self.assertEqual(sorted(c["variant"] for c in shown), ["current", "current", "painter", "painter"])
                self.assertTrue(all(("art" in c) == (c["variant"] == "painter") for c in shown), "art for painter, a picture otherwise")
                kept = json.loads((Path(folder) / job_id / "job.json").read_text())
                self.assertEqual([k["variant"] for k in kept["shown"]], [c["variant"] for c in shown], "saved in the order shown")
                self.assertEqual([k["position"] for k in kept["shown"]], [1, 2, 3, 4])
                self.assertEqual(sorted(k["seed"] for k in kept["shown"]), [100, 101, 102, 103])
                self.assertEqual(kept["subject"], self.SUBJECT)
                self.assertTrue(all((Path(folder) / job_id / k["file"]).exists() for k in kept["shown"]), "the full pictures")
                self.assertTrue(all("art" in k for k in kept["shown"] if k["variant"] == "painter"))
        self.assertGreater(len(orders), 1, "not always the same order")

    def test_a_finished_job_sends_candidates_in_the_test_and_images_otherwise(self):
        test = {"id": "b" * 32, "status": "done", "created": 0, "candidates": [{"variant": "painter", "art": {}}]}
        self.assertEqual(server.public_view(test)["candidates"], test["candidates"])
        self.assertNotIn("images", server.public_view(test))
        plain = {"id": "c" * 32, "status": "done", "created": 0, "images": ["data:a"]}
        self.assertEqual(server.public_view(plain)["images"], ["data:a"])
        self.assertNotIn("candidates", server.public_view(plain))


class GauntletTest(Harness):
    """The gauntlet: word soups, the job that paints five, and its endpoint."""

    def test_a_soup_is_three_to_five_different_familiar_words(self):
        rng = random.Random(3)
        known = {w for group in ("describers", "creatures", "things", "doings") for w in server.WORDS[group]}
        for _ in range(200):
            words = server.soup(rng)
            self.assertTrue(3 <= len(words) <= 5, words)
            self.assertEqual(len(set(words)), len(words), "no word twice")
            self.assertTrue(set(words) <= known)
            self.assertTrue(set(words) & set(server.WORDS["describers"]), "a describer")
            self.assertTrue(set(words) & set(server.WORDS["creatures"] + server.WORDS["things"]), "something to draw")

    def test_a_gauntlet_job_writes_and_paints_five_puzzles(self):
        from PIL import Image

        class Painted:
            def __init__(self):
                self.prompts = []

            def generate_image(self, seed, prompt, **_):
                self.prompts.append(prompt)
                return type("Result", (), {"image": Image.new("RGB", (512, 512), (200, 40, 40))})()

        model, job_id = Painted(), "f" * 32
        server.jobs[job_id] = {"id": job_id, "kind": "gauntlet", "prompt": "gauntlet", "account": "bob", "status": "queued", "painted": 0, "created": 0}
        with mock.patch.object(server, "USE_AGENT", False), contextlib.redirect_stdout(io.StringIO()):
            server.run_gauntlet(job_id, model)
        view = server.public_view(server.jobs[job_id])
        self.assertEqual((view["status"], view["painted"], view["total"]), ("done", 5, 5))
        self.assertEqual(len(view["puzzles"]), 5)
        for puzzle, prompt in zip(view["puzzles"], model.prompts):
            self.assertEqual(puzzle["subject"], " ".join(puzzle["words"]), "without the artist, the soup itself")
            self.assertEqual(prompt, f"{puzzle['subject']}, one subject centered, {server.STYLE}")
            self.assertTrue(puzzle["image"].startswith("data:image/png;base64,"))
        del server.jobs[job_id]

    def test_starting_a_gauntlet_needs_an_account_and_the_picture_model(self):
        self.assertEqual(self.call("POST", "/api/gauntlet", {}, token="")[0], 401)
        self.assertEqual(self.call("POST", "/api/gauntlet", {}, token=self.bob)[0], 503, "no picture model in tests")
        with mock.patch.dict(server.model_state, status="ready"), mock.patch.object(server.waiting, "put") as queued:
            status, body = self.call("POST", "/api/gauntlet", {}, token=self.bob)
        self.assertEqual(status, 202)
        self.assertEqual(server.jobs[body["id"]]["kind"], "gauntlet")
        queued.assert_called_once_with(body["id"])
        del server.jobs[body["id"]]


if __name__ == "__main__":
    unittest.main()
