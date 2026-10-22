# Little Jewel

An iPhone-first jewel-sorting browser game, based on the board-and-shelf mechanics in the [Jewel Coloring walkthrough](https://www.youtube.com/watch?v=kdOWbqm7tuY). The only artwork is imported exactly from `assets/original.pixil`: 32 × 32 pixels and 13 colors.

## Play

Run `npm start`, then open http://localhost:4173. No installation or build is required. On an iPhone on the same Wi-Fi, open your computer's LAN IP with port 4173; localhost on the phone refers to the phone itself.

The board starts filled with scrambled jewels. The colored spaces underneath show where each color belongs. The original artwork contains 682 turquoise pixels and only 342 other pixels, so at least 340 turquoise jewels must start correctly placed when preserving the exact inventory and an empty starting shelf. The scramble achieves that minimum; those unavoidable matches are locked from the start.

1. Tap a misplaced jewel to select its connected same-color group (including diagonals). Correctly placed jewels are locked: they cannot be selected, moved to the shelf, moved to another matching tile, or used to connect movable groups.
2. Tap an empty slot on the bottom shelf to store jewels and free their board spaces. The shelf starts with 24 spaces, and transfers stop when it fills. **Add shelf space** adds a row of eight slots (up to 1,024 total). Extra space is saved and is retained when undoing a move; restarting resets capacity.
3. Select a group on the board or a color on the shelf, then tap an empty matching board space. Jewels flow through connected empty matching spaces, stopping at occupied cells or other colors.
4. Restore the picture by matching all 1,024 jewels to their spaces. Every jewel is conserved; there is no infinite palette or painting action.

Occupied shelf slots always select their stored color, even if a board group was previously selected. Selecting shelf jewels brings an empty matching destination into view; matching empty sockets have a light rim. If none exists yet, the game explains that a matching space must be freed first.

Target squares and the central jewel faces retain the original colors. State is conveyed by depth: empty cells have recessed sockets; loose jewels have raised faceted edges and a shadow; selected jewels lift above the board; locked jewels sit flush with a shallow bevel and no raised shadow. There are no checkmarks, numbers, or plus symbols on the artwork. The target color remains visible around the foreground jewel. The shelf begins with 24 slots in three rows; added rows scroll inside the shelf.

Your selected color stays active after transfers, including partial transfers and moves between board and shelf. Remaining shelf jewels slide forward into earlier slots without changing their order. Tap a selected group again or **Clear selection** to cancel; select another jewel to change colors. Pinch to zoom, drag to pan, or use +, − and Fit. Hint highlights a possible transfer; Undo restores the previous move. Restart requires confirmation. Keyboard: focus the canvas, move with arrows and use Space/Enter to select or transfer; Escape clears the selection. Shelf slots are keyboard-accessible buttons.

Progress saves in localStorage in the current browser and origin. It does not sync between devices or from local preview to the published site. Private browsing or clearing browser data may remove it. Sorting progress uses a separate save key from the previous color-by-number prototype, whose saves are left untouched. Undo history lasts for the current session.

## GitHub Pages

The production URL is [https://momoswebsiteofthehour.com](https://momoswebsiteofthehour.com). A GitHub Actions workflow tests and deploys the static game whenever `main` changes. The custom domain is configured in the repository's Pages settings.

In the repository's **Settings → Pages**, the build source must be **GitHub Actions** and the custom domain must be `momoswebsiteofthehour.com`. At the DNS provider, point the apex domain to GitHub Pages using GitHub's current documented apex-domain records. DNS propagation and HTTPS certificate issuance can take time after the first successful deployment.

Open the resulting HTTPS URL in iPhone Safari. Safe-area padding and responsive layout support browser play without a native app. Add to Home Screen provides a standalone window. An initial network connection is required; offline caching is not implemented.

## Implementation and verification

`game.js` contains the puzzle state and legal transfers; `app.js` renders the board, gestures and animated transfers. `assets/art.json` preserves the imported image. The deterministic scramble exchanges connected patches while preserving the exact color inventory. It is a recreation of the observed mechanics with our own puzzle generation, not the original game's level data.

`npm test` checks the tutorial's full board → shelf → board sequence, diagonal connectivity, disconnected destinations, shelf limits, invalid transfers, inventory conservation, deterministic scrambling and save validation. There are no frameworks, remote fonts, analytics, or external runtime dependencies.
