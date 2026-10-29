# Pixel Game

An iPhone-first jewel-sorting browser game, based on the board-and-shelf mechanics in the [Jewel Coloring walkthrough](https://www.youtube.com/watch?v=kdOWbqm7tuY). The first puzzle, "A little love", is imported exactly from `assets/original.pixil`: 32 × 32 pixels and 13 colors. It is the first of the levels listed in `assets/puzzles.json`, and anyone with the password can create their own puzzles from a prompt (see [Create your own](#create-your-own)).

## Play

Run `npm start`, then open http://localhost:4173. No installation or build is required. On an iPhone on the same Wi-Fi, open your computer's LAN IP with port 4173; localhost on the phone refers to the phone itself.

The board starts filled with scrambled jewels. The colored spaces underneath show where each color belongs. The original artwork contains 682 turquoise pixels and only 342 other pixels, so at least 340 turquoise jewels must start correctly placed when preserving the exact inventory and an empty starting shelf. The scramble achieves that minimum; those unavoidable matches are locked from the start.

1. Tap a misplaced jewel to select its connected same-color group (including diagonals). Correctly placed jewels are locked: they cannot be selected, moved to the shelf, moved to another matching tile, or used to connect movable groups.
2. Tap an empty slot on the bottom shelf to store jewels and free their board spaces. The shelf starts with 24 spaces, and transfers stop when it fills. **Add shelf space** adds a row of eight slots (up to 1,024 total). Extra space is saved with your puzzle.
3. Select a group on the board or a color on the shelf, then tap an empty matching board space. Jewels flow through connected empty matching spaces, stopping at occupied cells or other colors.
4. Restore the picture by matching all 1,024 jewels to their spaces. Every jewel is conserved; there is no infinite palette or painting action.

Occupied shelf slots always select their stored color, even if a board group was previously selected. Selecting shelf jewels never changes the board zoom or position; matching empty sockets have a light rim. If none exists yet, free a matching space first.

Target squares and the central jewel faces retain the original colors. State is conveyed by depth: empty cells have recessed sockets; loose jewels have raised faceted edges and a shadow; selected jewels lift above the board; locked jewels sit flush with a shallow bevel and no raised shadow. There are no checkmarks, numbers, or plus symbols on the artwork. The target color remains visible around the foreground jewel. The shelf begins with 24 slots in three rows; added rows scroll inside the shelf.

Your selected color stays active after transfers, including partial transfers and moves between board and shelf. Remaining shelf jewels slide forward into earlier slots without changing their order. Tap a selected group again to cancel; select another jewel to change colors. The board starts fully visible. Pinch to zoom in or out and drag to pan; mouse and trackpad wheel zoom is also supported. There is no zoom, Fit, Undo, or Hint toolbar. Keyboard: focus the canvas, move with arrows and use Space/Enter to select or transfer; Escape clears the selection. Shelf slots are keyboard-accessible buttons.

The mobile layout places the board within four pixels of the screen edges (outside device safe areas). The shelf uses compact rows and scrolls when expanded; below it are Add shelf space and ☰ Menu, which returns to the start screen. Gameplay messages remain available to screen readers without taking space on the screen.

Progress saves in localStorage in the current browser and origin. Without the password, it stays in that one browser: it does not follow you to another device, to a Home Screen copy of the game, or from local preview to the published site, and private browsing or clearing browser data may remove it. With the password, saves also live on the generator server (see [Saves on the server](#saves-on-the-server)). Sorting progress uses a separate save key from the previous color-by-number prototype, whose saves are left untouched.

## Start screen

The game always opens on the start screen, including after a reload. It has three buttons:

- **Start game** plays the levels in order: the built-in puzzles, in the order of `assets/puzzles.json`. It opens the first level not yet finished, resuming any saved progress, and the row of squares above it shows finished levels as thumbnails; unfinished ones are blank, with the next one outlined. Once every level is finished, the button is disabled.
- **Fill and skip to level 11** marks levels 1–10 finished at once, each saved as its completed picture (it leaves any already-finished level alone), and Start game then opens level 11. It is for players who already finished those levels somewhere their progress did not follow. Finished this way, the levels count like any others: they show in the row of squares and the gallery, and sync to the server with the password. The button disappears once levels 1–10 are all finished.
- **Free play** lists the bonus puzzles, then the puzzles you created, each with its progress, plus **✦ Create your own**. The bonus puzzles (listed in `assets/bonus.json`) are hand-drawn pixel art, one for each of five drawings: ghosts, dinosaurs, crabs, chicks and cats in love. They are not levels: they stay out of Start game and its row of squares, but save, sync and show in the gallery like any other puzzle. A **Play the bonus ones here!** pop-up under Free play points at them until Free play is opened, and comes back when new bonus puzzles are added (remembered in this browser only). Your puzzles show a × to remove them along with their progress. Created puzzles live in this browser's localStorage, like progress, and sync to the server with the password.
- **Gallery** shows every finished picture: levels first, then the bonus puzzles, then your own. Close it with ×.

Finishing a puzzle shows the completed picture; closing that returns to the start screen. **☰ Menu** below the shelf also returns there, keeping your progress.

## Create your own

**✦ Create your own** in Free play asks for the password. The server checks it, so it never appears in this public repository; once accepted, the browser remembers it. A bar then opens at the bottom of the screen: describe a picture, wait about 20–25 seconds, and pick one of four versions. That version becomes a new puzzle.

How it works:

1. The game sends the idea to the generator running on the Mac (`server/`).
2. One model call through orchestra's `chat()` (from `~/projects/harness`, used as a library) turns the idea into one concrete subject that can be drawn, such as "something cozy for autumn" → "a brown mug with orange steam and a cinnamon stick". The model, temperature and system prompt come from `server/agents/artist.md`. orchestra records each call under the app `jewels`, with the job id in its metadata. If the call fails or the reply is cut off, the idea is used as written.
3. Z-Image Turbo (mflux, 4-bit) paints four 512 px candidates in a flat-icon style, about 2.5 s each.
4. The browser turns each picture into puzzle art with `convert.js`: it picks a palette in OKLab at 128 × 128, crops to the subject, shrinks to 32 × 32 by majority vote, and removes isolated pixels.

### Running the generator

```bash
cp server/.env.example server/.env   # then set JEWELS_PASSWORD
cd server && uv sync
uv run server.py                     # listens on http://127.0.0.1:8787
```

The first run downloads the 4-bit model (about 6 GB). The artist call needs the oMLX server running with the model named in `server/agents/artist.md`; the generator reads `OMLX_API_KEY` from `~/projects/harness/.env` (change this with `HARNESS_ENV`). Set `USE_AGENT=0` to skip it.

API: `POST /api/unlock` checks the password; `POST /api/jobs` (with `Authorization: Bearer <password>`) starts a job; `GET /api/jobs/<id>` reports progress and then returns the pictures; `GET` and `PUT /api/saves` read and replace the shared saves (see below). CORS allows only the origins in `ALLOWED_ORIGINS`. After 20 wrong passwords in 10 minutes, the server refuses all password attempts for a while. It runs one job at a time and accepts at most 5 waiting jobs.

A page served from localhost uses `http://localhost:8787`. The published site uses `PUBLIC_SERVER` in `generator.js`: the Mac's [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) address, which forwards public HTTPS to the server (the server itself listens only on 127.0.0.1). Opening the site with `?server=http://localhost:<port>` points it at a generator on the same machine (for testing) and is remembered in that browser; no other address is accepted, so a link can never send the password or saves elsewhere. If the Mac is asleep, offline, or not running the generator, the game says the generator is offline, and every other part of the game keeps working.

### Keeping it running on the Mac

- **Generator:** the LaunchAgent `~/Library/LaunchAgents/com.little-jewel.generator.plist` starts `server.py` from `server/.venv` at login and restarts it if it exits. It runs under `caffeinate -i -s`, so the Mac stays awake while the generator runs. Logs go to `server/logs/launchd.log`. Restart after changing the server with `launchctl kickstart -k gui/$(id -u)/com.little-jewel.generator`, and stop it with `launchctl bootout gui/$(id -u)/com.little-jewel.generator`.
- **Funnel:** set up once with `tailscale funnel --bg 8787` (on macOS the CLI is `/Applications/Tailscale.app/Contents/MacOS/Tailscale`). The setting persists, but it works only while the Tailscale app is running and signed in, so keep **Launch Tailscale at login** on. Check it with `tailscale funnel status`; turn it off with `tailscale funnel --https=443 off`.
- **Artist:** the oMLX server must be running for the artist call. Without it, each request falls back to the idea as written.

### Saves on the server

Everyone with the password shares one copy of the saves on the server: every level's progress, the puzzles they created, and the ones they removed. It is stored in `server/data/saves.json` (not in git; set `SAVES_FILE` to use another file, for example a throwaway one when testing). Each browser still keeps its own copy in localStorage, so the game works offline and without the password.

The game syncs when it loads, right after the password is accepted, a few seconds after each move, when a level is finished, and when the page goes into the background. A sync reads the server's copy, merges it with the browser's, stores the result locally and sends it back:

- **Progress:** for each puzzle, the save with more jewels home wins; if they are equal, the more recent one. The puzzle on screen always keeps the browser's own copy, so the board never changes under the player.
- **Created puzzles:** every puzzle from either copy, minus any removed in either. Removals are remembered, so an old copy cannot bring a puzzle back.
- **Two browsers at once:** each `PUT` names the version it started from. If another browser saved in between, the server answers 409 with its current copy, and the game merges again (up to three tries).

A browser that has progress but has never been given the password keeps that progress to itself until someone unlocks Create your own in it; the next sync then adds it to the shared copy.

**Known weaknesses** (not fixed yet):

- **The puzzle on screen can roll back the server's copy.** The browser keeps its own copy of the open puzzle, and it also sends that copy to the server, even when the server's copy is further along. For example, a phone has level 11 open at 40% while level 11 is finished on a laptop; when the phone syncs, the server's level 11 drops to 40%. The laptop's next sync restores 100%, but only if its browser still has that save. The fix is to send the furthest progress to the server and keep the on-screen copy only in the browser playing it.
- **The server keeps no backups.** Each sync replaces `server/data/saves.json` whole, and the Mac has no Time Machine. If a broken version of the game, or anyone with the password, sent an empty copy, the only other copies would be the ones in each browser. The fix is to keep recent versions (say the last 50, about 5 MB) next to the file.
- **Size limit.** The server refuses saves over 2 MB (`MAX_SAVES_BODY`), and browsers allow about 5 MB of localStorage. The saves are about 100 KB now; the limit would be reached after roughly 200 more created puzzles.

## GitHub Pages

The production URL is [https://momoswebsiteofthehour.com](https://momoswebsiteofthehour.com). A GitHub Actions workflow tests and deploys the static game whenever `main` changes. The custom domain is configured in the repository's Pages settings.

In the repository's **Settings → Pages**, the build source must be **GitHub Actions** and the custom domain must be `momoswebsiteofthehour.com`. At the DNS provider, point the apex domain to GitHub Pages using GitHub's current documented apex-domain records. DNS propagation and HTTPS certificate issuance can take time after the first successful deployment.

**One address.** Browsers keep separate saves for `http://` and `https://`, so a player who switched between them would see their progress vanish. When the game loads on `http://momoswebsiteofthehour.com`, it packs that browser's saves into the link (`#carry=…`, compressed; the part after `#` is never sent to a server, and the password is not included) and moves to the `https://` address, which merges them in and removes the `#carry` part from the address. Once players have visited the old address once, turning on **Enforce HTTPS** in the Pages settings is safe; turned on earlier, GitHub's redirect would skip that handoff.

Open the resulting HTTPS URL in iPhone Safari. Safe-area padding and responsive layout support browser play without a native app. Add to Home Screen provides a standalone window. An initial network connection is required; offline caching is not implemented.

## Implementation and verification

`game.js` contains the puzzle state and legal transfers; `app.js` renders the board, gestures, animated transfers, the start screen, free play, the gallery and the create bar. `library.js` loads built-in puzzles and stores created ones; `generator.js` talks to the generator; `convert.js` turns a picture into puzzle art. `assets/art.json` preserves the imported image. The deterministic scramble exchanges connected patches while preserving the exact color inventory. It is a recreation of the observed mechanics with our own puzzle generation, not the original game's level data.

`npm test` also loads the actual app entry point against a small DOM to verify transfers, shelf selections without camera changes, pinch zoom, gesture cancellation, the start screen, free play, the gallery and returning to the start screen after a level. The puzzle tests check the tutorial's full board → shelf → board sequence, diagonal connectivity, disconnected destinations, shelf limits, invalid transfers, inventory conservation, deterministic scrambling and save validation. `sync.test.js` checks how saves merge, that removals stick, that the password never leaves with the saves, and that packed saves unpack unchanged; the app tests also check the `http` → `https` handoff. `convert.test.js` checks that the original art converts back exactly, that a noisy picture becomes a solvable puzzle with no isolated pixels, and that every built-in puzzle can be finished using hint moves. There are no frameworks, remote fonts, analytics, or external runtime dependencies.
