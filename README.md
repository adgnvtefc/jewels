# Pixel Game

An iPhone-first jewel-sorting browser game, based on the board-and-shelf mechanics in the [Jewel Coloring walkthrough](https://www.youtube.com/watch?v=kdOWbqm7tuY). The first puzzle, "A little love", is imported exactly from `assets/original.pixil`: 32 × 32 pixels and 13 colors. It is the first of the levels listed in `assets/puzzles.json`, and signed-in players can create their own puzzles from a prompt (see [Create your own](#create-your-own)), chat, and send each other puzzles (see [Accounts and chat](#accounts-and-chat)).

## Play

Run `npm start`, then open http://localhost:4173. No installation or build is required. On an iPhone on the same Wi-Fi, open your computer's LAN IP with port 4173; localhost on the phone refers to the phone itself.

The board starts filled with scrambled jewels. The colored spaces underneath show where each color belongs. The original artwork contains 682 turquoise pixels and only 342 other pixels, so at least 340 turquoise jewels must start correctly placed when preserving the exact inventory and an empty starting shelf. The scramble achieves that minimum; those unavoidable matches are locked from the start.

1. Tap a misplaced jewel to select its connected same-color group (including diagonals). Correctly placed jewels are locked: they cannot be selected, moved to the shelf, moved to another matching tile, or used to connect movable groups.
2. Tap an empty slot on the bottom shelf to store jewels and free their board spaces. The shelf starts with 24 spaces, and transfers stop when it fills. **Add shelf space** adds a row of eight slots (up to 1,024 total). Extra space is saved with your puzzle.
3. Select a group on the board or a color on the shelf, then tap an empty matching board space. Jewels flow through connected empty matching spaces, stopping at occupied cells or other colors.
4. Restore the picture by matching all 1,024 jewels to their spaces. Every jewel is conserved; there is no infinite palette or painting action.

Occupied shelf slots always select their stored color, even if a board group was previously selected. Selecting shelf jewels never changes the board zoom or position; matching empty sockets have a light rim. If none exists yet, free a matching space first.

Target squares and the central jewel faces retain the original colors. State is conveyed by depth: empty cells have recessed sockets; loose jewels have raised faceted edges and a shadow; selected jewels lift above the board; locked jewels sit flush with a shallow bevel and no raised shadow. There are no checkmarks, numbers, or plus symbols on the artwork. The target color remains visible around the foreground jewel. The shelf begins with 24 slots in three rows; added rows scroll inside the shelf. When jewels go onto a scrolled shelf, it first scrolls to show the slots they fill; a jewel flying to or from a slot still out of view fades at the shelf's edge.

When a jewel lands in its right spot on the picture, three tiny white stars glitter around it for about half a second (not on the shelf, and not with reduced motion). When the last jewel of a color lands, that whole color ripples: starting from that jewel, each jewel of the color swells and brightens for a moment, spreading outward over about a second (also skipped with reduced motion). The ripple stamps one pre-drawn jewel, so even an 800-jewel background stays cheap on a phone. Your selected color stays active after transfers, including partial transfers and moves between board and shelf. Remaining shelf jewels slide forward into earlier slots without changing their order. Tap a selected group again to cancel; select another jewel to change colors. The board starts fully visible. Pinch to zoom in or out and drag to pan; mouse and trackpad wheel zoom is also supported. Pinching zooms only the board, never the page. There is no zoom, Fit, Undo, or Hint toolbar. Keyboard: focus the canvas, move with arrows and use Space/Enter to select or transfer; Escape clears the selection. Shelf slots are keyboard-accessible buttons.

The game is played in portrait. Above the board, a thin line names the level and puzzle on the left and counts your moves on the right ("12 moves"); the count is saved with your progress. The board is as wide as the screen allows (four pixels from the edges, outside device safe areas), and the header, board, shelf and Menu are centred top to bottom, with any spare height split above and below. On a short screen the board shrinks so everything fits. The shelf uses compact rows and scrolls when expanded; below it are Add shelf space and ☰ Menu, which returns to the start screen.

No screen scrolls as a page: the start screen and the board always fit the window, and only the chat, the shelf and long pop-ups (such as Free play) scroll inside themselves. The page can't be pinch-zoomed or pulled past its edges either. Gameplay messages remain available to screen readers without taking space on the screen.

Progress saves in localStorage in the current browser and origin. As a guest (not signed in), it stays in that one browser: it does not follow you to another device, to a Home Screen copy of the game, or from local preview to the published site, and private browsing or clearing browser data may remove it. Signed in, progress also lives on the server on the Mac (see [Saves on the server](#saves-on-the-server)). Sorting progress uses a separate save key from the previous color-by-number prototype, whose saves are left untouched.

## Start screen

The game always opens on the start screen, including after a reload. **Sign in** sits in the top corner; signed in, it shows your name and opens Sign out and Sign out everywhere. The buttons:

- **Start game** plays the levels in order: the built-in puzzles, in the order of `assets/puzzles.json`. Levels are drawn by hand or by a frontier model, never by the Mac's picture model; that is what sets them apart from Free play, where puzzles made on the Mac go. It opens the first level not yet finished, resuming any saved progress, and the row of squares above it shows finished levels as thumbnails; unfinished ones are blank, with the next one outlined. Once every level is finished, the button is disabled.
- **Free play** lists the bonus puzzles, then **Sent to you** (puzzles your friend sent, marked "from …"), then the puzzles you created, each with its progress, plus **✦ Create your own**. The bonus puzzles (listed in `assets/bonus.json`) are hand-drawn pixel art, one for each of five drawings: ghosts, dinosaurs, crabs, chicks and cats in love. They are not levels: they stay out of Start game and its row of squares, but save, sync and show in the gallery like any other puzzle. A **Play the bonus ones here!** pop-up under Free play points at them until Free play is opened, and comes back when new bonus puzzles are added (remembered in this browser only). Your puzzles and sent ones show a × to remove them along with their progress (a removed sent puzzle stays in the chat, and tapping it there brings it back). Created puzzles live in this browser's localStorage, like progress, and sync to the server when signed in.
- **✦ Create puzzle** makes a new puzzle from a description (see [Create your own](#create-your-own)).
- **Gallery** shows every finished picture: levels first, then the bonus puzzles, then your own. Close it with ×.
- **Settings** (signed in only) opens its own screen; ‹ Back returns. It holds **Chat notifications**: three switches for which chat events text you (see [Texts about unread messages](#texts-about-unread-messages)). Each switch saves to the server as soon as it changes.
- **Chat with …** (signed in only) opens the chat, with the number of unread messages on the button.

Finishing a puzzle shows the completed picture; closing that returns to the start screen (or to the chat, for a puzzle opened from the chat). **☰ Menu** below the shelf also returns there, keeping your progress.

## Create your own

Making a puzzle works the same from all three places that offer it: **✦ Create puzzle** on the start screen, **✦ Create your own** in Free play, and **✦ Create puzzle** in the chat's 🧩 picker. It needs an account; a guest is asked to sign in first, and the pop-up opens once signed in. All of it is in `create.js`.

1. A pop-up asks you to describe a picture. While the Mac paints (about 20–25 seconds), the pop-up shows how it's going.
2. Pick one of the four versions, or **Try again** for four more of the same idea.
3. The picked version then offers **Play now** (saves it and opens it), **Save to Free play** (saves it and shows it there) or **Try again** (throws it away and paints the same idea again). Until you choose, it isn't saved; closing the pop-up with × keeps it in Free play, so a picture is never lost by accident. Closing the pop-up while it's still painting drops that request.

To send a puzzle you made, use 🧩 in the chat.

How it works:

1. The game sends the idea to the server running on the Mac (`server/`), with the sign-in token.
2. One model call through orchestra's `chat()` (from `~/projects/harness`, used as a library) turns the idea into one concrete subject that can be drawn, such as "something cozy for autumn" → "a brown mug with orange steam and a cinnamon stick". The model, temperature and system prompt come from `server/agents/artist.md`. orchestra records each call under the app `jewels`, with the job id and account in its metadata. If the call fails or the reply is cut off, the idea is used as written.
3. Z-Image Turbo (mflux, 4-bit) paints four 512 px candidates in a flat-icon style, about 2.5 s each.
4. The browser turns each picture into puzzle art with `convert.js`: it picks a palette in OKLab at 128 × 128, crops to the subject, shrinks to 32 × 32 by majority vote, and removes isolated pixels.

### The Create puzzle test

To learn which pictures make better puzzles, the server can split each Create puzzle in half (`CREATE_TEST=1` in `server/.env`; off by default, and then all four come from the artist):

- **Top two, "today":** painted from the artist's subject, converted as usual.
- **Bottom two, "typed":** painted from the player's words exactly as typed, with the same style line, and converted with the lighter, feature-keeping conversion (`LIGHTER` in `convert.js`). It removes soft line edges instead of letting them become colors, thins a thick outline to one jewel, keeps at least one jewel for each small feature that clearly differs from its surroundings (an eye, a seed), and keeps lone pixels that contrast strongly. Its options are all off by default, so other conversions are unchanged.

Each pick is recorded with its half (`llm_pick` and `made_puzzle` carry `variant: "today"` or `"typed"`), and the server keeps each job's four pictures and prompts in `server/data/create-test/<job>/` (not in git) to compare side by side. The top half always comes first, so it may get a few extra picks just for being first.

## Accounts and chat

Accounts are invite-only: they are added on the Mac, and there is no sign-up page. Each account has its own progress and puzzles. Friends (set on the Mac too) can chat and send each other puzzles.

- **Signing in** gives the browser a random token, kept in localStorage as `little-jewel:account`; the password is never stored in the browser. The server keeps only scrypt hashes of passwords and SHA-256 hashes of tokens. A token lasts 90 days from its last use, and an account can be signed in on at most 10 browsers. After 20 wrong passwords in 10 minutes, the server refuses all sign-ins for a while; there is no per-account lock.
- **Separate progress.** A signed-in account's saves and puzzles live under `little-jewel:<name>:…` in the browser; a guest's stay under the older `little-jewel:…` keys. The first sign-in in a browser with guest progress asks whether to add it to the account; if yes, it moves over (furthest progress wins per puzzle) and the guest copy is cleared.
- **The old shared password.** Before accounts, everyone with one password shared a single copy of the saves; it was moved into account 1 on the server (see `server/migrate_v91.py`). A browser that still has the password forgets it on its next visit. Any copy of the old saves left in such a browser is treated like any other guest progress: whoever signs in there is asked whether to add it, and can say Not now.
- **Signing out** sends any unsent progress, ends the session on the server (or every session, with Sign out everywhere), and removes the account's copy from the browser. If progress couldn't be sent, it asks first. When a sign-in runs out, the game keeps everything and the corner button says **Sign in again**.
- **Chat.** The chat screen shows the conversation, a message box, and 🧩 to send a puzzle. Messages are kept forever; scrolling up loads older ones back to the first. The game checks for new messages every 3 seconds while the chat is open, every minute otherwise, and not while the page is hidden; the latest 200 are cached in the browser. Messages are always shown as text, never as HTML, and links aren't clickable. Up to 1,000 characters each, and 30 a minute.
- **Sending puzzles.** Only puzzles you made can be sent. The 🧩 picker lists them, plus **✦ Create puzzle**, which opens the create pop-up; once saved, the new puzzle is in the 🧩 list to send. The friend gets a card in the chat and the puzzle in Free play under Sent to you; tapping the card opens it (and Menu returns to the chat). When they first finish it, the chat shows "… finished it in N moves" to both of you. Only finishing is shared, not partial progress.
- **Notifications.** New messages show as a count on the Chat button and in the tab title. Messages left unread get one text message (see below); there are no push notifications.

Accounts and friends are managed on the Mac, with passwords typed at a hidden prompt (never on a command line or in a file):

```bash
cd server
.venv/bin/python accounts.py add billy
.venv/bin/python accounts.py befriend billy bob
.venv/bin/python accounts.py set-password billy    # also signs them out everywhere
.venv/bin/python accounts.py list                    # each line starts with the account's ID
```

Every account has a permanent number, its **account ID** (billy is 1, bob is 2), which `accounts.py list` shows. textbot's `contacts.json` maps these IDs to phone numbers (see [Texts about unread messages](#texts-about-unread-messages)). **Caveat:** the ID is SQLite's row number, and SQLite can hand the highest one out again if that account is deleted and another added. There is no delete command, but if an account is ever removed by hand, fix textbot's `contacts.json` before adding the next one, or the new account would get texts meant for the old one's phone.

### Texts about unread messages

Ten minutes after the newest message to you, if you still have unread messages, the server texts you once. After that, nothing more until a newer message arrives, which starts the 10 minutes again. Reading the chat within the 10 minutes means no text. The text never includes the messages themselves.

The chat has three kinds of events, and each account chooses which ones text it, under Settings → **Chat notifications** (all on to start; saved per account in the database's `notify_settings` table):

| Switch | Chat event | Text |
| --- | --- | --- |
| New messages | a message | "Bob sent you a new message in Pixel Game" (or "3 new messages") |
| New puzzles | a sent puzzle | "Bob sent you a new puzzle in Pixel Game" |
| A puzzle you sent is finished | "finished it in N moves" | "Bob finished your puzzle in Pixel Game" |

Several kinds combine into one text: "Bob sent you a new message and a new puzzle in Pixel Game". A kind that's switched off is ignored completely: it doesn't start the 10 minutes or appear in a text. Switching one on counts only events from then on, never older unread ones.

- **Who sends it:** jewels decides when (only it knows who has read what), and textbot's notify service on the Mac (`~/projects/textbot/notify.py`, `POST http://127.0.0.1:8765/notify`) sends the iMessage. jewels sends only the **account ID** and the text; the phone numbers live only in textbot's `contacts.json`, under `jewels`, keyed by account ID (`"2"` for bob). An account with no entry there gets no texts (textbot answers 404).
- **How:** a background thread in `server.py` checks once a minute (`chat.due_notices` has the rule, and checks each account's switches every time). `chat_notices.up_to` remembers the newest message already handled, in the database, so a restart never texts twice. Each message gets one try: if textbot is down or answers 404 or 429, the server logs it and moves on, and the chat itself never waits on textbot.
- **Texting anything yourself:** `server/texts.py` sends any text (up to 300 characters) to any accounts, by ID, or to all of them. It checks everything first (unknown IDs, length, the token), so a mistake sends nothing, then texts each account and prints how each one went. One failing (say, no phone number in textbot for that ID) doesn't stop the rest. In code, it's `texts.send_text(db, text, [2])` or `texts.send_text(db, text, "all")`.

  ```bash
  cd server
  .venv/bin/python texts.py "New puzzles are up!" all
  .venv/bin/python texts.py "Dinner's ready" 2
  .venv/bin/python texts.py "Hi, both of you" 1 2
  ```

  It exits with 0 if every text went out, 1 if any didn't, and 2 if nothing was sent because of a mistake. textbot texts each person at most once every 5 minutes, counting the unread-message texts too.
- **Setup:** `TEXTBOT_NOTIFY_TOKEN` in `server/.env` is textbot's `NOTIFY_TOKEN_JEWELS`. Without it, texts are off and the server says so when it starts. Messages from before texts existed never cause one.

## The server

`server/` runs on the Mac: accounts, saves, chat and the picture generator, with all data in one SQLite file, `server/data/jewels.db` (not in git).

```bash
cd server && uv sync
uv run server.py                     # listens on http://127.0.0.1:8787
```

The first run downloads the 4-bit picture model (about 6 GB). The artist call needs the oMLX server running with the model named in `server/agents/artist.md`; the server reads `OMLX_API_KEY` from `~/projects/harness/.env` (change this with `HARNESS_ENV`). Set `USE_AGENT=0` to skip it, or `USE_MODEL=0` to run without the picture model (for testing accounts and chat). Set `DB_FILE` to use another database, for example a throwaway one when testing. See `server/.env.example`.

API (all but sign-in and health need `Authorization: Bearer <token>`; the full list is at the top of `server/server.py`): `POST /api/login`, `POST /api/logout`, `GET /api/me`; `GET`/`PUT /api/saves`; `POST /api/puzzles` and `DELETE /api/puzzles/<id>`; `GET`/`POST /api/messages` and `POST /api/messages/read`; `GET`/`PUT /api/notifications`; `POST /api/jobs` and `GET /api/jobs/<id>`; `GET /api/health`. CORS allows only the origins in `ALLOWED_ORIGINS`. It runs one picture job at a time and accepts at most 5 waiting jobs.

A page served from localhost uses `http://localhost:8787`. The published site uses `PUBLIC_SERVER` in `account.js`: the Mac's [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) address, which forwards public HTTPS to the server (the server itself listens only on 127.0.0.1). Opening the site with `?server=http://localhost:<port>` points it at a server on the same machine (for testing) and is remembered in that browser; no other address is accepted, so a link can never send a sign-in or saves elsewhere. If the Mac is asleep, offline, or not running the server, the game keeps working from the browser's own copy.

### Keeping it running on the Mac

- **Server:** the LaunchAgent `~/Library/LaunchAgents/com.little-jewel.generator.plist` starts `server.py` from `server/.venv` at login and restarts it if it exits. It runs under `caffeinate -i -s`, so the Mac stays awake while the server runs. Logs go to `server/logs/launchd.log`. Restart after changing the server with `launchctl kickstart -k gui/$(id -u)/com.little-jewel.generator`, and stop it with `launchctl bootout gui/$(id -u)/com.little-jewel.generator`.
- **Funnel:** set up once with `tailscale funnel --bg 8787` (on macOS the CLI is `/Applications/Tailscale.app/Contents/MacOS/Tailscale`). The setting persists, but it works only while the Tailscale app is running and signed in, so keep **Launch Tailscale at login** on. Check it with `tailscale funnel status`; turn it off with `tailscale funnel --https=443 off`.
- **Artist:** the oMLX server must be running for the artist call. Without it, each request falls back to the idea as written.

### Saves on the server

Each account's progress is one row per puzzle in the database, with a revision number. The game syncs when it loads, after signing in, a few seconds after each move, when a level is finished, when the page goes into the background and when it comes back. A sync sends any new puzzles and removals, downloads what changed since the last sync, then sends the saves changed in this browser:

- **Each save goes up with the revision it was based on.** If nothing else saved that puzzle since, the server takes it as it is, even if it has fewer jewels home. If another device saved in between, the copy with more jewels home wins (then the newer one), and the browser gets the winner back. If that puzzle is on screen, the board switches to it ("Picked up from your other device"). So a stale browser can no longer roll back progress made elsewhere.
- **The server counts jewels itself** (a Python copy of the game's rules in `server/saves.py`), using the shipped puzzles in this checkout's `assets/` and made puzzles from the database, and rejects saves that don't fit their puzzle.
- **Made puzzles** are checked before they are stored, since they are drawn in other people's browsers: 32 × 32, valid pixels, 2–16 `#rrggbb` colors each used at least once, and a title of up to 200 characters.
- **Backups:** each time the server starts, and once a day, it copies the whole database to `server/data/backups/jewels-YYYY-MM-DD.db` and keeps the last 30. A schema upgrade first saves `jewels-before-v<N>.db`. The backups cover saves, puzzles and chat together. They stay on the Mac; if its disk fails, they go with it.

The shared saves from before accounts were moved into Billy's account with `server/migrate_v91.py`; the original file is kept as `server/data/saves-v91.json`.

**Known weakness:** browsers allow about 5 MB of localStorage, and one `PUT` is limited to 2 MB and 300 saves (the rest go in the next sync). A browser holding hundreds of made puzzles could reach the localStorage limit.

## GitHub Pages

The production URL is [https://momoswebsiteofthehour.com](https://momoswebsiteofthehour.com). A GitHub Actions workflow tests and deploys the static game whenever `main` changes. The custom domain is configured in the repository's Pages settings.

In the repository's **Settings → Pages**, the build source must be **GitHub Actions** and the custom domain must be `momoswebsiteofthehour.com`. At the DNS provider, point the apex domain to GitHub Pages using GitHub's current documented apex-domain records. DNS propagation and HTTPS certificate issuance can take time after the first successful deployment.

**One address.** Browsers keep separate saves for `http://` and `https://`, so a player who switched between them would see their progress vanish. When the game loads on `http://momoswebsiteofthehour.com`, it packs that browser's guest saves into the link (`#carry=…`, compressed; the part after `#` is never sent to a server, and no sign-in is included) and moves to the `https://` address, which merges them into the guest saves there (signing in offers to add them to an account) and removes the `#carry` part from the address. Once players have visited the old address once, turning on **Enforce HTTPS** in the Pages settings is safe; turned on earlier, GitHub's redirect would skip that handoff.

Open the resulting HTTPS URL in iPhone Safari. On an iPhone or iPad that isn't already running the Home Screen version, the game suggests **Add to Home Screen** once (remembered as `little-jewel:home-screen-hint`); the Home Screen icon is `assets/apple-touch-icon.png`, the first level's art at 180 × 180. The Home Screen version keeps its own storage on iOS, so guest progress stays in Safari, and signing in brings an account's progress along. Safe-area padding and responsive layout support browser play without a native app. Add to Home Screen provides a standalone window. An initial network connection is required; offline caching is not implemented.

## Implementation and verification

`game.js` contains the puzzle state and legal transfers; `app.js` renders the board, gestures, animated transfers, the start screen, free play and the gallery. `create.js` is the create-a-puzzle pop-up. `library.js` loads built-in puzzles and keeps each profile's saves and puzzles in localStorage; `account.js` signs in and makes every server call; `sync.js` syncs an account with the server; `chat.js` runs the chat screen; `generator.js` asks the Mac for pictures; `convert.js` turns a picture into puzzle art. On the server, `server.py` routes requests to `accounts.py`, `saves.py` and `chat.py`, which share the SQLite database in `db.py`. `assets/art.json` preserves the imported image. The deterministic scramble exchanges connected patches while preserving the exact color inventory. It is a recreation of the observed mechanics with our own puzzle generation, not the original game's level data.

`npm test` also loads the actual app entry point against a small DOM to verify transfers, shelf selections without camera changes, pinch zoom, gesture cancellation, the start screen, free play, the gallery and returning to the start screen after a level. The puzzle tests check the tutorial's full board → shelf → board sequence, diagonal connectivity, disconnected destinations, shelf limits, invalid transfers, inventory conservation, deterministic scrambling and save validation. `sync.test.js` checks how saves merge, that removals stick, and that packed saves unpack unchanged; the app tests also check the `http` → `https` handoff, signing in and out, separate progress per account, moving guest progress, the chat (messages shown as text, puzzle cards that open), sending only your own puzzles and the Settings screen. `server/test_server.py` (run with `cd server && .venv/bin/python -m unittest test_server`) checks sign-in, tokens, the per-puzzle save rule, made-puzzle checks, sending, completion notices, chat paging, retries, rate limits and backups against a throwaway database. `convert.test.js` checks that the original art converts back exactly, that a noisy picture becomes a solvable puzzle with no isolated pixels, and that every built-in puzzle can be finished using hint moves. There are no frameworks, remote fonts, or external runtime dependencies; the only outside script is the catseye analytics snippet, allowed by the page's Content-Security-Policy.
