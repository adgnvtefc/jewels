// The gauntlet, from Free play: five surprise puzzles, played one after another. The Mac
// picks a random "word soup" for each (3 to 5 familiar words), the artist blends it into one
// subject, Z-Image paints it, and the browser converts it like any made puzzle. The five go
// into Free play, titled with their words, and the run is remembered so it can be continued.
import { generateGauntlet, pictureToArt } from './generator.js';
import { online, ServerError } from './account.js';
import { gauntletRun, setGauntletRun } from './library.js';

// deps: { $, show(markup, then), esc, thumbnail, track, find(id) → art, done(art) → finished?,
//         movesOf(art), keep(puzzle) → saved?, play(puzzle), signIn(note, then), home() }
export function createGauntlet(deps) {
  const { $, show, esc } = deps;
  let run = 0;  // the latest request; one whose pop-up closed is dropped
  const titleOf = words => { const text = words.join(', '); return text[0].toUpperCase() + text.slice(1, 80); };

  // The run's puzzles still in Free play, in order.
  const puzzles = () => (gauntletRun()?.ids || []).map(deps.find).filter(Boolean);
  const nextUp = () => puzzles().find(art => !deps.done(art));

  function start() {
    if (!online()) return deps.signIn('The gauntlet needs an account.', start);
    const all = puzzles(), next = all.find(art => !deps.done(art));
    if (next) {
      show(`<p class="eyebrow">GAUNTLET</p><h2>Puzzle ${all.indexOf(next) + 1} of ${all.length} is waiting</h2><p>Pick up where you left off, or start five new ones.</p><button class="primary" id="gauntletGo">Continue</button><button class="home-button" id="gauntletNew">New gauntlet</button>`);
      $('gauntletGo').onclick = () => { $('modal').close(); deps.play(next); };
      $('gauntletNew').onclick = make;
    } else make();
  }

  async function make() {
    const mine = ++run, started = Date.now();
    show(`<p class="eyebrow">GAUNTLET</p><h2>Five surprise puzzles</h2><p>Each one is painted from a random handful of words. Play them one after another.</p><p id="gauntletStatus" role="status">Picking words…</p>`, () => { run++; });
    const status = text => { if (mine === run) $('gauntletStatus').textContent = text; };
    try {
      const job = await generateGauntlet(job => {
        if (job.status === 'queued') status(job.ahead ? `Waiting in line (${job.ahead} ahead)…` : 'Starting…');
        else status(`Painting puzzle ${Math.min(job.painted + 1, job.total)} of ${job.total}…`);
      });
      if (mine !== run) return;
      status('Cutting the jewels…');
      const base = Date.now().toString(36);
      const made = await Promise.all(job.puzzles.map(async (p, n) => ({ ...(await pictureToArt(p.image, { title: titleOf(p.words) })), id: `custom-${base}${n}` })));
      if (mine !== run) return;
      if (!made.every(deps.keep)) return status('This browser could not save the puzzles.');
      setGauntletRun({ ids: made.map(a => a.id), started });
      deps.track('gauntlet_start', { soups: job.puzzles.map(p => p.words.join(' ')), subjects: job.puzzles.map(p => p.subject), seconds: job.seconds, ready: job.ready === true, ms: Date.now() - started });
      run++; $('modal').close(); deps.play(made[0]);
    } catch (error) {
      deps.track('gauntlet_start', { ok: false, error: error.message, status: error.status });
      if (mine !== run) return;
      if (error instanceof ServerError && error.status === 401) return deps.signIn('Please sign in again.', start);
      status(error.message || 'Something went wrong.');
    }
  }

  return {
    start,
    // "Gauntlet 2 of 5" for a puzzle in the run, or null.
    label(art) { const all = puzzles(), n = all.findIndex(a => a.id === art.id); return n < 0 ? null : `Gauntlet ${n + 1} of ${all.length}`; },
    // The finish pop-up for a gauntlet puzzle: on to the next, or the whole run at the end.
    finished(art) {
      const all = puzzles(), n = all.findIndex(a => a.id === art.id), next = nextUp();
      if (next) {
        let going = false;  // closing the pop-up any other way goes back to the start screen
        show(`<p class="eyebrow">GAUNTLET · ${n + 1} OF ${all.length} DONE</p><h2>${esc(art.title)}</h2><img src="${deps.thumbnail(art, 8)}" alt="Your completed puzzle"><button class="primary" id="gauntletNext">Next puzzle</button>`, () => { if (!going) deps.home(); });
        $('gauntletNext').onclick = () => { going = true; $('modal').close(); deps.play(next); };
        return;
      }
      const moves = all.reduce((sum, a) => sum + deps.movesOf(a), 0);
      deps.track('gauntlet_done', { moves, puzzles: all.length });
      setGauntletRun(null);
      show(`<p class="eyebrow">GAUNTLET COMPLETE</p><h2>All ${all.length} restored</h2><p>${moves} moves in all.</p><div class="puzzle-list">${all.map(a => `<figure class="gallery-item"><img alt="${esc(a.title)}" src="${deps.thumbnail(a)}"><figcaption>${esc(a.title)}</figcaption></figure>`).join('')}</div><button class="primary" id="gauntletHome">Back to start</button>`, deps.home);
      $('gauntletHome').onclick = () => $('modal').close();
    },
  };
}
