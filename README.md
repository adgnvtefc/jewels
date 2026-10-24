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

Progress saves in localStorage in the current browser and origin. It does not sync between devices or from local preview to the published site. Private browsing or clearing browser data may remove it. Sorting progress uses a separate save key from the previous color-by-number prototype, whose saves are left untouched.

## Start screen

The game always opens on the start screen, including after a reload. It has three buttons:

- **Start game** plays the levels in order: the built-in puzzles, in the order of `assets/puzzles.json`. It opens the first level not yet finished, resuming any saved progress, and the row of squares above it shows finished levels as thumbnails; unfinished ones are blank, with the next one outlined. Once every level is finished, the button is disabled.
- **Free play** lists the puzzles you created, with their progress, plus **✦ Create your own**. Your puzzles show a × to remove them along with their progress. Created puzzles live in this browser's localStorage, like progress, so they do not sync between devices.
- **Gallery** shows every finished picture, levels first and then your own. Close it with ×.

Finishing a puzzle shows the completed picture; closing that returns to the start screen. **☰ Menu** below the shelf also returns there, keeping your progress.

## Create your own

**✦ Create your own** in Free play asks for the password. The server checks it, so it never appears in this public repository; once accepted, the browser remembers it. A bar then opens at the bottom of the screen: describe a picture, wait about 20–25 seconds, and pick one of four versions. That version becomes a new puzzle.

How it works:

1. The game sends the idea to the generator running on the Mac (`server/`).
2. The generator's harness agent (`server/agents/artist.md`, run through `~/projects/harness` as a library, with no tools) turns the idea into one concrete subject that can be drawn, such as "something cozy for autumn" → "a brown mug with orange steam and a cinnamon stick". If the agent fails, the idea is used as written.
3. Z-Image Turbo (mflux, 4-bit) paints four 512 px candidates in a flat-icon style, about 2.5 s each.
4. The browser turns each picture into puzzle art with `convert.js`: it picks a palette in OKLab at 128 × 128, crops to the subject, shrinks to 32 × 32 by majority vote, and removes isolated pixels.

### Running the generator

```bash
cp server/.env.example server/.env   # then set JEWELS_PASSWORD
cd server && uv sync
uv run server.py                     # listens on http://127.0.0.1:8787
```

The first run downloads the 4-bit model (about 6 GB). The harness agent needs the oMLX server running with the model named in `server/agents/artist.md`; the generator reads `OMLX_API_KEY` from `~/projects/harness/.env` (change this with `HARNESS_ENV`). Set `USE_AGENT=0` to skip the agent.

API: `POST /api/unlock` checks the password; `POST /api/jobs` (with `Authorization: Bearer <password>`) starts a job; `GET /api/jobs/<id>` reports progress and then returns the pictures. CORS allows only the origins in `ALLOWED_ORIGINS`. After 20 wrong passwords in 10 minutes, the server refuses all password attempts for a while. It runs one job at a time and accepts at most 5 waiting jobs.

A page served from localhost uses `http://localhost:8787`. The published site uses `PUBLIC_SERVER` in `generator.js`: the Mac's [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) address, which forwards public HTTPS to the server (the server itself listens only on 127.0.0.1). Opening the site with `?server=https://…` overrides this address and is remembered in that browser. If the Mac is asleep, offline, or not running the generator, the game says the generator is offline, and every other part of the game keeps working.

### Keeping it running on the Mac

- **Generator:** the LaunchAgent `~/Library/LaunchAgents/com.little-jewel.generator.plist` starts `server.py` from `server/.venv` at login and restarts it if it exits. It runs under `caffeinate -i -s`, so the Mac stays awake while the generator runs. Logs go to `server/logs/launchd.log`. Restart after changing the server with `launchctl kickstart -k gui/$(id -u)/com.little-jewel.generator`, and stop it with `launchctl bootout gui/$(id -u)/com.little-jewel.generator`.
- **Funnel:** set up once with `tailscale funnel --bg 8787` (on macOS the CLI is `/Applications/Tailscale.app/Contents/MacOS/Tailscale`). The setting persists, but it works only while the Tailscale app is running and signed in, so keep **Launch Tailscale at login** on. Check it with `tailscale funnel status`; turn it off with `tailscale funnel --https=443 off`.
- **Agent:** the oMLX server must be running for the harness agent. Without it, each request falls back to the idea as written.

## GitHub Pages

The production URL is [https://momoswebsiteofthehour.com](https://momoswebsiteofthehour.com). A GitHub Actions workflow tests and deploys the static game whenever `main` changes. The custom domain is configured in the repository's Pages settings.

In the repository's **Settings → Pages**, the build source must be **GitHub Actions** and the custom domain must be `momoswebsiteofthehour.com`. At the DNS provider, point the apex domain to GitHub Pages using GitHub's current documented apex-domain records. DNS propagation and HTTPS certificate issuance can take time after the first successful deployment.

Open the resulting HTTPS URL in iPhone Safari. Safe-area padding and responsive layout support browser play without a native app. Add to Home Screen provides a standalone window. An initial network connection is required; offline caching is not implemented.

## Implementation and verification

`game.js` contains the puzzle state and legal transfers; `app.js` renders the board, gestures, animated transfers, the start screen, free play, the gallery and the create bar. `library.js` loads built-in puzzles and stores created ones; `generator.js` talks to the generator; `convert.js` turns a picture into puzzle art. `assets/art.json` preserves the imported image. The deterministic scramble exchanges connected patches while preserving the exact color inventory. It is a recreation of the observed mechanics with our own puzzle generation, not the original game's level data.

`npm test` also loads the actual app entry point against a small DOM to verify transfers, shelf selections without camera changes, pinch zoom, gesture cancellation, the start screen, free play, the gallery and returning to the start screen after a level. The puzzle tests check the tutorial's full board → shelf → board sequence, diagonal connectivity, disconnected destinations, shelf limits, invalid transfers, inventory conservation, deterministic scrambling and save validation. `convert.test.js` checks that the original art converts back exactly, that a noisy picture becomes a solvable puzzle with no isolated pixels, and that every built-in puzzle can be finished using hint moves. There are no frameworks, remote fonts, analytics, or external runtime dependencies.
