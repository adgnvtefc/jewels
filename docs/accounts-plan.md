# Accounts, chat and sending puzzles — design notes

A running record of what has been approved. Every section is approved and built (not yet live: see the change log).
No password ever goes in this file or anywhere in the repo (it is public).

## Approved

| # | Decision | Approved |
|---|----------|----------|
| 1 | Two invite-only accounts, `hanmo` and `anushka`. No sign-up page; accounts are added on the Mac. | 2026-11-05 |
| 2 | An account is needed to create puzzles (the generator), sync, chat and send puzzles. | 2026-11-05 |
| 3 | Each account has its own progress. | 2026-11-05 |
| 4 | The two are each other's only friends. Chat between friends. | 2026-11-05 |
| 5 | Friends can send each other puzzles (made ones, levels and bonus ones). | 2026-11-05 |
| 6 | **Anushka owns the current shared progress** (server copy v91: 41 saves, 16 made puzzles). | 2026-11-05 |
| 7 | **Guests can play without an account**; their progress stays in that browser only. | 2026-11-05 |
| 8 | **Back up saves and chat on the server.** | 2026-11-05 |
| 9 | **Show puzzle completion** in chat ("Anushka finished your puzzle in 64 moves"). | 2026-11-05 |
| 10 | **SQLite** (`server/data/jewels.db`, Python's built-in `sqlite3`) is the database. | 2026-11-05 |
| 11 | **Sign-in and sessions as described below.** No per-account lock; only the overall limit. | 2026-11-05 |
| 12 | Signing out sends unsent saves, then removes that account's progress from the browser. | 2026-11-05 |
| 13 | Saves on browsers that used the old shared password are Anushka's: offered to her at sign-in, not to Hanmo. | 2026-11-05 |
| 14 | **Chat and sending puzzles as described below.** | 2026-11-05 |
| 15 | Chat history is kept forever, and you can scroll back to the very first message. | 2026-11-05 |
| 16 | Tapping a puzzle in chat (a sent puzzle or a completion notice) opens that puzzle. | 2026-11-05 |
| 17 | Only puzzles you made can be sent; not levels, bonus puzzles or puzzles sent to you. | 2026-11-05 |
| 18 | The sender sees only "finished", not partial progress. Links in messages aren't clickable. | 2026-11-05 |
| 19 | Backups stay on the Mac for now; no off-Mac copy. | 2026-11-05 |
| 20 | **Per-puzzle saves** as described below: more jewels home wins a clash, and the open board switches to the winner. | 2026-11-05 |
| 21 | **The database schema** as written below. | 2026-11-05 |
| 22 | **The API** as written below. | 2026-11-05 |

Carried over from the sketch (not objected to):

- Passwords stored only as scrypt hashes; sign-in gives the browser a token, never storing the password.
- Signing in on a browser that has guest progress asks before adding it to the account.
- Chat checks for new messages every few seconds while open, about once a minute otherwise (no WebSockets).
- Messages are escaped and capped at 1,000 characters; sent puzzles are validated on the server.
- Fix the open-puzzle rollback in the same pass (see "Saves" below).

## What exists today

| Part | Where | Notes |
|------|-------|-------|
| Game page | `/Users/hanmozhang/projects/jewels/index.html`, `style.css`, `app.js` | Served by GitHub Pages at https://momoswebsiteofthehour.com |
| Game rules | `/Users/hanmozhang/projects/jewels/game.js` | `restore`, `correctCount`, the save shape `{board, shelf, moves, selectedColor, savedAt}` |
| Puzzle list, browser saves, merge | `/Users/hanmozhang/projects/jewels/library.js` | localStorage keys below; `snapshot`, `mergeSaves`, `storeSnapshot` |
| Talking to the Mac | `/Users/hanmozhang/projects/jewels/generator.js` | Password in localStorage, `fetchSaves`/`sendSaves`, `generate` |
| Picture → puzzle | `/Users/hanmozhang/projects/jewels/convert.js` | Runs in the browser |
| Shipped puzzles | `/Users/hanmozhang/projects/jewels/assets/puzzles.json`, `bonus.json`, `assets/puzzles/*.json` | Never stored on the server |
| Deploy | `/Users/hanmozhang/projects/jewels/.github/workflows/pages.yml` | Runs `npm test`, copies the listed files and `assets/` |
| Server | `/Users/hanmozhang/projects/jewels/server/server.py` | stdlib `ThreadingHTTPServer` on 127.0.0.1:8787 |
| Server secrets | `/Users/hanmozhang/projects/jewels/server/.env` (not committed) | `JEWELS_PASSWORD`, optional `SAVES_FILE` etc. |
| Artist prompt | `/Users/hanmozhang/projects/jewels/server/agents/artist.md` | Called through orchestra `chat()` |
| Saves on the server | `/Users/hanmozhang/projects/jewels/server/data/saves.json` (not committed) | One shared copy, `{version, data: {saves, custom, removed}}`, ~255 KB |
| Server log | `/Users/hanmozhang/projects/jewels/server/logs/launchd.log` | |
| Always-on service | `/Users/hanmozhang/Library/LaunchAgents/com.little-jewel.generator.plist` | Runs `server/.venv/bin/python server/server.py` under `caffeinate` |
| Public address | Tailscale Funnel `https://hanmos-mac-studio.tail6c4683.ts.net` | `/` → 127.0.0.1:8787 (this server), `/catseye` → 127.0.0.1:8790 (analytics) |
| Model call records | `/Users/hanmozhang/.orchestra/jewels/log/<day>.jsonl` | Written by orchestra |
| Tests | `/Users/hanmozhang/projects/jewels/*.test.js` | `node --test`; no server tests yet |

Browser storage today (all in localStorage):

- `little-jewel:sorting-v2:<puzzle id>` — one save per puzzle
- `little-jewel:custom-puzzles` — made puzzles (full art)
- `little-jewel:removed-puzzles` — ids of deleted made puzzles
- `little-jewel:generator-password` — the raw password (to be retired)
- `little-jewel:generator-url` — local-server override
- `little-jewel:bonus-seen` — bonus pop-up dismissed

## Database (approved)

**One SQLite file: `server/data/jewels.db`**, using Python's built-in `sqlite3` (SQLite 3.53 on the Mac, Python 3.12). Not committed, like the rest of `server/data/`.

Why SQLite rather than more JSON files: chat needs "messages after id N" and unread counts; sending a puzzle writes a puzzle and a message together; per-puzzle saves need per-row versions. SQLite gives transactions for all of that, and a consistent backup of one file with `Connection.backup()`. No new dependency.

Settings: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`. Schema version in `PRAGMA user_version`; the server upgrades it on start (after taking a backup).

```sql
CREATE TABLE accounts (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,     -- sign-in name: 'hanmo', 'anushka'
  password_hash TEXT NOT NULL,            -- scrypt$n$r$p$salt$hash
  rev           INTEGER NOT NULL DEFAULT 0, -- bumps on any change to this account's saves or library
  created_at    INTEGER NOT NULL          -- all times are unix milliseconds
);

CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,          -- sha256 of the token; the token lives only in the browser
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device       TEXT,                      -- short label from the user agent
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL           -- ~90 days, extended while in use
);

CREATE TABLE friends (                    -- one row each way
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  friend_id  INTEGER NOT NULL REFERENCES accounts(id),
  since      INTEGER NOT NULL,
  PRIMARY KEY (account_id, friend_id)
);

CREATE TABLE puzzles (                    -- made puzzles only; shipped ones stay in assets/
  id         TEXT PRIMARY KEY,            -- 'custom-…', as today
  creator_id INTEGER NOT NULL REFERENCES accounts(id),
  title      TEXT NOT NULL,
  art        TEXT NOT NULL,               -- JSON {id,title,width,height,colors,pixels}, validated
  created_at INTEGER NOT NULL
);

CREATE TABLE library (                    -- which made puzzles are in whose Free play
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  puzzle_id  TEXT NOT NULL REFERENCES puzzles(id),
  from_id    INTEGER REFERENCES accounts(id), -- NULL: you made it; else who sent it
  added_at   INTEGER NOT NULL,
  removed_at INTEGER,                     -- replaces today's `removed` list
  rev        INTEGER NOT NULL,
  PRIMARY KEY (account_id, puzzle_id)
);

CREATE TABLE saves (
  account_id  INTEGER NOT NULL REFERENCES accounts(id),
  puzzle_id   TEXT NOT NULL,              -- any puzzle id; no foreign key, since shipped ones have no row
  state       TEXT NOT NULL,              -- JSON, today's save shape unchanged
  home        INTEGER NOT NULL,           -- jewels home, worked out by the server
  total       INTEGER NOT NULL,
  rev         INTEGER NOT NULL,
  saved_at    INTEGER NOT NULL,
  finished_at INTEGER,                    -- first time home = total
  PRIMARY KEY (account_id, puzzle_id)
);
CREATE INDEX saves_rev ON saves(account_id, rev);

CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id    INTEGER NOT NULL REFERENCES accounts(id),
  to_id      INTEGER NOT NULL REFERENCES accounts(id),
  kind       TEXT NOT NULL CHECK (kind IN ('text', 'puzzle', 'finished')),
  body       TEXT,                        -- 'text': up to 1,000 characters
  puzzle_id  TEXT,                        -- 'puzzle' and 'finished'
  moves      INTEGER,                     -- 'finished'
  client_id  TEXT NOT NULL,               -- browser-made id, so a retry never sends twice
  created_at INTEGER NOT NULL,
  UNIQUE (from_id, client_id)
);
CREATE INDEX messages_pair ON messages(to_id, id);

CREATE TABLE chat_reads (                 -- for the unread count
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  friend_id    INTEGER NOT NULL REFERENCES accounts(id),
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, friend_id)
);
```

Failed sign-in counts stay in memory, as today.

### Saves: one row per puzzle (fixes the rollback, approved)

Today the whole save set is one blob with one version, and the puzzle on screen always keeps its own copy, so a stale browser can roll back progress made elsewhere.

New rule, per puzzle:

1. The browser sends only changed saves, each with `based_on`: the `rev` it last saw for that puzzle.
2. If the server's row still has that `rev`, the write is accepted, even if progress went down (the player moved jewels out on purpose).
3. If not, another device wrote in between. The server keeps whichever copy has more jewels home (tie: newer `saved_at`) and sends the winner back.
4. If the puzzle on screen loses, the board switches to the server copy with "Picked up from your other device."

The server works out `home` and `total` itself with a Python copy of `restore` and `correctCount` (about 20 lines), reading shipped puzzles from `assets/` in this checkout and made ones from `puzzles`. It rejects saves that don't fit their puzzle. The Mac's checkout is where deploys come from, so it always has every shipped puzzle.

### Completion notices

When a save first reaches `home = total`, the server sets `finished_at`. If that puzzle reached this account in a `'puzzle'` message and no `'finished'` message for it has been sent yet, the server adds one to the sender in the same transaction. Done on the server, so it fires once however many devices are open.

## Sign-in and sessions (approved)

### Passwords

- Hashed with `hashlib.scrypt` (built into Python): n = 2^15, r = 8, p = 1, a random 16-byte salt, 32-byte result. Stored as `scrypt$15$8$1$<salt>$<hash>` in `accounts.password_hash`.
- Checked with `hmac.compare_digest`. An unknown name is checked against a dummy hash, so a wrong name and a wrong password take the same time and get the same reply: "That name and password don't match."
- Names are trimmed and lowercased, so "Anushka " works.
- Passwords are set on the Mac only, typed at a hidden prompt (`server/.venv/bin/python server/accounts.py set-password anushka`). Never in the repo, `.env`, shell history or a command line. Setting a password signs that account out everywhere.

### Guessing limits (in memory, like today)

- No per-account lock, so nobody can lock someone out by guessing.
- Overall: 20 wrong in 10 minutes refuses all sign-ins for a while (today's rule).
- Each wrong try waits half a second before answering.
- Behind Funnel every request looks like it comes from the Mac itself, so there is no per-address limit.

### Tokens

- Signing in makes a random token (`secrets.token_urlsafe(32)`). The browser keeps it; the server keeps only its SHA-256 in `sessions`.
- A token lasts 90 days from its last use. `last_seen_at` is updated at most once an hour, so play doesn't mean constant writes.
- At most 10 sessions per account; a new sign-in past that removes the oldest.
- Sent as `Authorization: Bearer <token>`. Cookies won't do: the game (momoswebsiteofthehour.com) and the server (ts.net) are different sites, and Safari blocks cookies across sites.
- An expired or cancelled token gets 401. The game keeps everything local and shows "Sign in again"; nothing is lost.

### In the browser

- `little-jewel:account` holds `{name, token}`; `little-jewel:generator-password` is deleted on first load.
- Signed in: the game reads and writes `little-jewel:<name>:…` keys. Signed out: the guest keys used today.
- A Content-Security-Policy in `index.html` allows scripts only from the site itself and the catseye address, and connections only to the Mac. Chat brings other people's text into the page, so this is a second guard on top of escaping.

### Screens

- Start screen: "Sign in" in a corner; once signed in, the name, which opens "Sign out" and "Sign out everywhere".
- Sign-in dialog: name and password (`autocomplete="username"` / `"current-password"`, so password managers fill them).
- "Create your own" as a guest opens the same dialog with "Creating puzzles needs an account."

### Guest progress at sign-in

- If this browser has guest progress, after signing in: "Add this browser's progress (12 puzzles) to hanmo?"
- Yes: guest saves go into the account (furthest progress wins per puzzle) and the guest copy is cleared, so it can't be added to a second account.
- Not now: the guest copy stays and can be played again after signing out.

### Signing out

- Sends any unsent saves, then deletes the server session and the token.
- Then removes that account's copy from this browser. If saves couldn't be sent (offline), it says so and asks before removing.
- "Sign out everywhere" deletes all of the account's sessions.

### Calls

| Call | Does |
|------|------|
| `POST /api/login {name, password}` | → `{token, name, friends, expires_at}` or 401 / 429 |
| `POST /api/logout {everywhere?}` | Deletes this session, or all of them |
| `GET /api/me` | → `{name, friends, unread}`; also confirms the token still works |

### Old-password browsers

Browsers that used the shared password hold copies of the shared progress, which now belongs to Anushka. On first load after the change, a browser that still has `little-jewel:generator-password` marks its existing saves as the old shared copy (`little-jewel:shared-v91` = true) and deletes the password.

- Anushka signs in there: the offer to add them works as for any guest progress (it is her progress anyway).
- Hanmo signs in there: no offer. The old saves stay as guest saves.
- Guest progress made after the change is offered as usual.

## Chat and sending puzzles (approved)

### Conversations

- One conversation per pair of friends; with two accounts, that is one conversation.
- Message kinds: `text`, `puzzle` (a sent puzzle) and `finished` (the completion notice). No editing or deleting for now.
- History is kept forever on the server and backed up with everything else.

### Getting new messages

- `GET /api/messages?after=<id>` returns messages to or from you newer than `id` (up to 200), the unread count, and the art for any made puzzle they mention that the browser hasn't seen.
- `GET /api/messages?before=<id>` loads 50 older ones each time you reach the top, all the way back to the first message.
- How often the game asks:
  - chat open and on screen: every 3 seconds
  - signed in, game on screen, chat closed: every 60 seconds (for the unread count)
  - tab hidden or phone locked: never; it asks once as soon as the game is back on screen.
- The last 200 messages are also kept in `little-jewel:<name>:chat`, so the chat opens instantly and recent ones can be read offline. Older ones load from the server.

### Sending text

- `POST /api/messages {to, text, client_id}`. `client_id` is a random id the browser makes, unique per sender (`UNIQUE(from_id, client_id)` in `messages`), so a retry after a dropped connection never sends twice.
- The message shows straight away as "Sending…"; on failure it shows "Not sent · Retry".
- Text is trimmed, 1–1,000 characters, with control characters other than line breaks removed.
- Shown with `textContent`, never as HTML, with line breaks kept. Links are plain text, not clickable.
- At most 30 messages a minute per account (in memory).

### Uploading made puzzles

When a signed-in player picks one of the generated pictures, the game also sends it to `POST /api/puzzles`, so the server holds every made puzzle and sending one only names its id. The server checks it before storing, since it will be drawn in someone else's browser:

- `id` like `custom-<letters and digits>`, at most 32 characters, not already taken (the browser makes a new id if it is).
- 32 × 32, exactly 1,024 pixels, each an integer from -1 to the last color.
- 2 to 16 colors, each `#rrggbb`. (The converter makes at most 12.)
- Title: text, 1–200 characters (the prompt limit), control characters removed.
- Every color is used at least once.

### Sending a puzzle

- Only puzzles you made can be sent. Levels, bonus puzzles and puzzles sent to you can't.
- Ways to send:
  - "Send a puzzle" in chat opens a picker of the puzzles you made, as thumbnails, newest first.
  - "Send to Anushka" on the screen that opens after picking a generated picture.
- `POST /api/messages {to, puzzle, client_id}`. The server checks that the sender made the puzzle (`puzzles.creator_id`) and hasn't removed it.
- In the same transaction, the puzzle is added to the friend's `library` with `from_id` set to the sender. If the friend had removed it, it comes back.

### The puzzle card in chat

- Thumbnail, title and "from hanmo".
- The whole card is tappable and opens the puzzle (the receiver gets it back in Free play first if they had removed it).
- For the receiver: their own progress on it (Not started / 45% / Finished).
- For the sender: "Sent", and later "Anushka finished it in 64 moves". Tapping opens the sender's own copy.

### Completion notices

- As in the database section: the first time the receiver finishes a puzzle that reached them in a `puzzle` message, the server adds one `finished` message to the sender.
- Shown as a line with a small thumbnail: "Anushka finished Ghosts in love in 64 moves." Tapping it opens that puzzle.
- Only completion is shared, not partial progress.

### Free play

- New section "Sent to you", between Bonus and Your puzzles. Each card says "from hanmo".
- Removing a received puzzle from Free play hides it (`library.removed_at`). Its chat card still works, and tapping it brings the puzzle back.
- If the maker deletes a puzzle they made, the receiver keeps it. A `puzzles` row is never deleted while any library row or message refers to it.

### Unread messages

- `chat_reads.last_read_id` moves forward when messages are on screen with the chat open.
- The start screen's Chat button shows the number of unread messages, and the tab title becomes "(2) Pixel Game".
- No phone notifications.

### The chat screen

- Its own screen (like the game board, not a pop-up): a top bar with "‹ Back" and Anushka's name, the messages, then a text box with Send and a puzzle button.
- Opening a puzzle from chat and then pressing Menu returns to the chat.
- On phones the text box stays above the on-screen keyboard (`visualViewport`).

### Tests

- Server (`server/test_server.py`):
  - sending works only between friends
  - only puzzles the sender made can be sent
  - a retry doesn't send twice
  - scrolling back reaches the first message
  - bad puzzles are refused
  - a sent made puzzle lands in the friend's library
  - the completion notice is sent exactly once
  - the rate limit holds
- Browser (`app.test.js`):
  - a message containing `<img onerror=…>` shows as text
  - the unread count
  - tapping a card or a completion notice opens the right puzzle
  - "Sent to you" in Free play.

## API (approved)

All but sign-in and health need `Authorization: Bearer <token>`.

| Call | Does |
|------|------|
| `POST /api/login {name, password}` | → `{token, account, friends}`; per-account and overall attempt limits |
| `POST /api/logout` | Deletes this token's session |
| `GET /api/me` | → `{account, friends, unread}` |
| `GET /api/saves?since=<rev>` | Saves and library rows changed after `rev`, plus the current `rev` |
| `PUT /api/saves {saves: [{puzzle, state, based_on}]}` | Per-puzzle rule above; → winners and new `rev` |
| `POST /api/puzzles {art}` | Store a made puzzle, add it to your library |
| `DELETE /api/puzzles/<id>` | Remove from your library (tombstone) |
| `GET /api/messages?after=<id>` / `?before=<id>` | Newer messages (up to 200) or 50 older ones, the unread count, and art for made puzzles mentioned |
| `POST /api/messages {to, text, client_id}` or `{to, puzzle, client_id}` | Send text or a puzzle; a sent made puzzle is added to the friend's library |
| `POST /api/messages/read {friend, up_to}` | Mark read |
| `POST /api/jobs`, `GET /api/jobs/<id>` | As today, but needs a session; orchestra metadata becomes `{"job", "account"}` |
| `GET /api/health` | As today |

`/api/unlock` and the shared `JEWELS_PASSWORD` are retired.

## How the parts connect

```
Browser (momoswebsiteofthehour.com, GitHub Pages)
  app.js ─ library.js (localStorage, per account) ─ account.js (token, API calls) ─ chat.js
     │ fetch, Bearer token, CORS limited to ALLOWED_ORIGINS
     ▼
Tailscale Funnel  https://hanmos-mac-studio.tail6c4683.ts.net   (/catseye goes elsewhere, untouched)
     ▼
server/server.py on 127.0.0.1:8787 (LaunchAgent com.little-jewel.generator)
  routes ─ accounts.py ─ saves.py ─ chat.py ─ db.py ──► server/data/jewels.db
     │                                         └─────► server/data/backups/
     └─ generator worker ─ orchestra chat() (artist) ─ Z-Image (mflux)
```

### Files that would change or appear

Server (`/Users/hanmozhang/projects/jewels/server/`):

- `db.py` (new): open the database, create and upgrade the schema, backups.
- `accounts.py` (new): scrypt hashing, sessions, sign-in limits; also a command-line tool to add an account or set a password, typed at a hidden prompt on the Mac, e.g. `python accounts.py set-password hanmo`.
- `saves.py` (new): the per-puzzle rule, the Python `restore`/`correctCount`, puzzle validation.
- `chat.py` (new): messages, reads, completion notices.
- `server.py`: routes only; the generator stays here.
- `migrate_v91.py` (new, run once): moves `data/saves.json` into Anushka's rows.
- `test_server.py` (new): sign-in, tokens, saves rule, chat, validation, against a throwaway database.
- `.env.example`: drop `JEWELS_PASSWORD`; `SAVES_FILE` becomes `DB_FILE`.

Browser (`/Users/hanmozhang/projects/jewels/`):

- `account.js` (new, takes over the server calls in `generator.js`): sign-in, token, API calls.
- `chat.js` (new): chat screen, polling, puzzle cards.
- `library.js`: keys gain the account (`little-jewel:<account>:sorting-v2:<id>` etc.); guest keys stay as they are now.
- `app.js`: sign-in button, per-puzzle sync, "Sent to you" in Free play, Chat button with unread count.
- `generator.js`: keeps `generate` and `pictureToArt`.
- `index.html`, `style.css`, tests, and the copy list in `.github/workflows/pages.yml` (new `.js` files).

Unchanged: `game.js`, `convert.js`, `assets/`, the Funnel, the LaunchAgent (restarted after the change), catseye.

## Moving existing data

1. Back up `server/data/saves.json`, then keep it as `server/data/saves-v91.json` (read-only).
2. `migrate_v91.py` creates the two accounts (passwords typed at the prompt), the friendship, then for Anushka: 16 made puzzles into `puzzles` and `library`, 41 saves into `saves` with `home` worked out.
3. Hanmo starts with no server progress.
4. Browsers holding the old password are signed out and asked to sign in once. Their local saves stay as guest saves and are offered to the account on sign-in.

## Backups

- On every server start (before any schema upgrade) and once a day: `Connection.backup()` to `server/data/backups/jewels-YYYY-MM-DD.db`.
- Keep the last 30 daily copies.
- Covers saves, made puzzles, library and chat together, since they share the file.
- On the Mac only, for now (decision 19). If the Mac's disk fails, the backups go with it.

## Open questions

- None.

## Change log

- 2026-11-05: First version. Decisions 1–9 approved; database proposed.
- 2026-11-05: SQLite approved (decision 10). Schema, per-puzzle save rule and API still open for review.
- 2026-11-05: Sign-in and sessions proposed.
- 2026-11-05: Sign-in and sessions approved without the per-account lock (decisions 11–13).
- 2026-11-05: Chat and sending puzzles proposed; `messages` gains `client_id`.
- 2026-11-05: Chat and sending approved (decisions 14–18): history kept forever, puzzles in chat open on tap, only puzzles you made can be sent.
- 2026-11-05: No off-Mac backups for now (decision 19).
- 2026-11-05: Per-puzzle saves, schema and API approved (decisions 20–22). Design complete.
- 2026-11-05: Built. Server: `db.py`, `accounts.py`, `saves.py`, `chat.py`, `migrate_v91.py`, `test_server.py` (21 tests). Browser: `account.js`, `sync.js`, `chat.js`, changes to `library.js`, `app.js`, `index.html`, `style.css` (37 tests). Small additions: `USE_MODEL=0` for testing without the picture model; a new sent or finished puzzle in chat triggers a save sync so cards show current progress. Checked in the preview against a throwaway server.
