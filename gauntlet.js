// The gauntlet, from Free play: five surprise puzzles, played one after another. The Mac
// picks a random "word soup" for each (3 to 5 familiar words), the artist blends it into one
// subject, Z-Image paints it, and it's converted like any made puzzle (server/generator.py).
//
// A gauntlet's five puzzles share an id stem: custom-g<stem>0 … custom-g<stem>4 (the first
// gauntlets, before the "g", were custom-<stem>0 … 4). So every device can tell which
// puzzles belong together and in what order, from the ids alone. Free play shows them in a
// section of their own, revealed one at a time: a puzzle stays hidden until the one before
// it is finished.
import { requestPuzzles, pictureToArt } from './generator.js';
import { online, ServerError } from './account.js';

const SIZE = 5;
const MEMBER = /^custom-(g?)([a-z0-9]{8})([0-9])$/;

// deps: { $, show(markup, then), esc, thumbnail, track, all() → your puzzles, done(art) → finished?,
//         movesOf(art), keep(puzzle) → saved?, play(puzzle), card(puzzle, onPick) → element,
//         signIn(note, then), home() }
export function createGauntlet(deps) {
  const { $, show, esc } = deps;
  let run = 0;  // the latest request; one whose pop-up closed is dropped
  const titleOf = words => { const text = words.join(', '); return text[0].toUpperCase() + text.slice(1, 80); };

  // Every gauntlet among your puzzles, newest first: { stem, started, puzzles: [five, in order] }.
  function runs() {
    const groups = new Map();
    for (const art of deps.all()) {
      const match = !art.from && MEMBER.exec(art.id);
      if (!match) continue;
      const stem = match[1] + match[2];
      if (!groups.has(stem)) groups.set(stem, { stem, started: parseInt(match[2], 36), puzzles: [] });
      groups.get(stem).puzzles[Number(match[3])] = art;
    }
    // Only whole gauntlets: five in a row (so an ordinary made puzzle is never mistaken for one).
    return [...groups.values()].filter(g => g.puzzles.length === SIZE && g.puzzles.every(Boolean)).sort((a, b) => b.started - a.started);
  }
  const runOf = art => runs().find(g => g.puzzles.some(a => a.id === art.id));
  // A puzzle is revealed once every puzzle before it in its gauntlet is finished.
  const revealedIn = g => g.puzzles.map((_, n) => g.puzzles.slice(0, n).every(deps.done));
  const nextIn = g => g.puzzles.find(a => !deps.done(a));

  function start() {
    if (!online()) return deps.signIn('The gauntlet needs an account.', start);
    const current = runs().find(nextIn);
    if (current) {
      const next = nextIn(current);
      show(`<p class="eyebrow">GAUNTLET</p><h2>Puzzle ${current.puzzles.indexOf(next) + 1} of ${SIZE} is waiting</h2><p>Pick up where you left off, or start five new ones.</p><button class="primary" id="gauntletGo">Continue</button><button class="home-button" id="gauntletNew">New gauntlet</button>`);
      $('gauntletGo').onclick = () => { $('modal').close(); deps.play(next); };
      $('gauntletNew').onclick = make;
    } else make();
  }

  async function make() {
    const mine = ++run, started = Date.now();
    show(`<p class="eyebrow">GAUNTLET</p><h2>Five surprise puzzles</h2><p>Each one is painted from a random handful of words. Play them one after another.</p><p id="gauntletStatus" role="status">Picking words…</p>`, () => { run++; });
    const status = text => { if (mine === run) $('gauntletStatus').textContent = text; };
    try {
      const job = await requestPuzzles('gauntlet', null, job => {
        if (job.status === 'queued') status(job.ahead ? `Waiting in line (${job.ahead} ahead)…` : 'Starting…');
        else status(`Painting puzzle ${Math.min(job.painted + 1, job.total)} of ${job.total}…`);
      });
      if (mine !== run) return;
      status('Cutting the jewels…');
      const stem = Date.now().toString(36);
      const made = await Promise.all(job.puzzles.map(async (p, n) => ({ ...(p.art || await pictureToArt(p.image, { title: titleOf(p.words) })), title: titleOf(p.words), id: `custom-g${stem}${n}` })));
      if (mine !== run) return;
      if (!made.every(deps.keep)) return status('This browser could not save the puzzles.');
      deps.track('gauntlet_start', { soups: job.puzzles.map(p => p.words.join(' ')), subjects: job.puzzles.map(p => p.subject), seconds: job.seconds, ready: job.ready === true, ms: Date.now() - started });
      run++; $('modal').close(); deps.play(made[0]);
    } catch (error) {
      deps.track('gauntlet_start', { ok: false, error: error.message, status: error.status });
      if (mine !== run) return;
      if (error instanceof ServerError && error.status === 401) return deps.signIn('Please sign in again.', start);
      status(error.message || 'Something went wrong.');
    }
  }

  // A hidden puzzle: its place in the gauntlet, but no picture or words.
  function hiddenCard(n) {
    const card = document.createElement('div');
    card.className = 'puzzle-card hidden-card';
    card.innerHTML = `<button class="puzzle-pick" disabled aria-label="Puzzle ${n + 1}, hidden until you finish puzzle ${n}"><span class="puzzle-hidden" aria-hidden="true">?</span><span class="puzzle-title">Puzzle ${n + 1}</span><span class="puzzle-progress">After puzzle ${n}</span></button>`;
    return card;
  }

  return {
    start,
    // Whether this puzzle belongs to a gauntlet, and whether it can be seen yet.
    isMember: art => Boolean(runOf(art)),
    revealed(art) { const g = runOf(art); return !g || revealedIn(g)[g.puzzles.findIndex(a => a.id === art.id)]; },
    // Free play's Gauntlets section: each gauntlet, newest first, its puzzles revealed one at a time.
    section() {
      const all = runs(), box = document.createElement('div');
      if (!all.length) return box;
      box.innerHTML = '<h2>Gauntlets</h2>';
      for (const g of all) {
        const shown = revealedIn(g), finished = g.puzzles.filter(deps.done).length;
        const heading = document.createElement('p');
        heading.className = 'gauntlet-heading';
        heading.textContent = `${new Date(g.started).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${finished === SIZE ? 'all 5 done' : `${finished} of 5 done`}`;
        const list = document.createElement('div');
        list.className = 'puzzle-list';
        g.puzzles.forEach((art, n) => list.append(shown[n] ? deps.card(art, () => { $('modal').close(); deps.play(art); }) : hiddenCard(n)));
        box.append(heading, list);
      }
      return box;
    },
    // "Gauntlet 2 of 5" for a puzzle in a gauntlet, or null.
    label(art) { const g = runOf(art); return g ? `Gauntlet ${g.puzzles.findIndex(a => a.id === art.id) + 1} of ${SIZE}` : null; },
    // The finish pop-up for a gauntlet puzzle: on to the next, or the whole gauntlet at the end.
    finished(art) {
      const g = runOf(art);
      if (!g) return deps.home();
      const n = g.puzzles.findIndex(a => a.id === art.id), next = nextIn(g);
      if (next) {
        let going = false;  // closing the pop-up any other way goes back to the start screen
        show(`<p class="eyebrow">GAUNTLET · ${n + 1} OF ${SIZE} DONE</p><h2>${esc(art.title)}</h2><img src="${deps.thumbnail(art, 8)}" alt="Your completed puzzle"><button class="primary" id="gauntletNext">Next puzzle</button>`, () => { if (!going) deps.home(); });
        $('gauntletNext').onclick = () => { going = true; $('modal').close(); deps.play(next); };
        return;
      }
      const moves = g.puzzles.reduce((sum, a) => sum + deps.movesOf(a), 0);
      deps.track('gauntlet_done', { moves, puzzles: SIZE });
      show(`<p class="eyebrow">GAUNTLET COMPLETE</p><h2>All ${SIZE} restored</h2><p>${moves} moves in all.</p><div class="puzzle-list">${g.puzzles.map(a => `<figure class="gallery-item"><img alt="${esc(a.title)}" src="${deps.thumbnail(a)}"><figcaption>${esc(a.title)}</figcaption></figure>`).join('')}</div><button class="primary" id="gauntletHome">Back to start</button>`, deps.home);
      $('gauntletHome').onclick = () => $('modal').close();
    },
  };
}
