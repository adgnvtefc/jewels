// Making a new puzzle works the same from everywhere (the start screen, Free play, the
// chat's 🧩): one pop-up asks for an idea, the Mac paints four versions, and the player
// picks one. The picked one is then played now, saved to Free play, or thrown away to
// try the same idea again. Closing the pop-up at that point keeps it in Free play.
//
// The Create puzzle test (switched on at the server): the top two pictures come from the
// artist's subject as usual ("today"), the bottom two from the player's words as typed
// ("typed"), converted with the lighter, feature-keeping conversion. Picks say which.
import { generate, pictureToArt } from './generator.js';
import { LIGHTER } from './convert.js';
import { online, ServerError } from './account.js';

// deps: { $, show(markup, then), esc, thumbnail, track,
//         keep(puzzle) → saved?, play(puzzle), freePlay(), signIn(note, then) }
export function createMaker(deps) {
  const { $, show, esc } = deps;
  let run = 0;  // the latest request; an older one, or one whose pop-up closed, is dropped
  const title = idea => idea[0].toUpperCase() + idea.slice(1, 60);

  function start() {
    if (online()) ask();
    else deps.signIn('Creating puzzles needs an account.', ask);
  }

  function ask(idea = '') {
    show(`<p class="eyebrow">CREATE PUZZLE</p><h2>Describe a picture</h2><form id="createForm" class="create-form"><input id="prompt" maxlength="200" placeholder="A cat in a teacup" autocomplete="off" enterkeyhint="go" aria-label="Describe a picture to make into a puzzle" value="${esc(idea)}"><button class="primary" type="submit" id="createGo">Create</button></form><p id="createStatus" role="status">You’ll get four versions to choose from.</p>`, () => { run++; });
    $('prompt').focus();
    $('createForm').onsubmit = e => {
      e.preventDefault();
      const text = $('prompt').value.trim();
      if (text) paint(text);
    };
  }

  async function paint(idea) {
    const mine = ++run, started = Date.now();
    const status = text => { if (mine === run) $('createStatus').textContent = text; };
    $('createGo').disabled = true; $('prompt').readOnly = true;
    status('Sending your idea…');
    try {
      const job = await generate(idea, job => {
        if (job.status === 'queued') status(job.ahead ? `Waiting in line (${job.ahead} ahead)…` : 'Starting…');
        else if (job.status === 'writing') status('Thinking about your idea…');
        else if (job.status === 'painting') status(`Painting “${job.subject}” — ${job.painted} of ${job.total}…`);
      });
      status('Cutting the jewels…');
      const variants = job.variants || job.images.map(() => 'today');
      const choices = await Promise.all(job.images.map((src, n) => pictureToArt(src, { title: title(idea), ...(variants[n] === 'typed' ? LIGHTER : {}) })));
      deps.track('llm_generate', { ok: true, prompt: idea, subject: job.subject, agent: job.agent, images: job.images.length, seconds: job.seconds, ms: Date.now() - started });
      if (mine === run) pick(idea, choices, variants);
    } catch (error) {
      deps.track('llm_generate', { ok: false, prompt: idea, error: error.message, status: error.status, ms: Date.now() - started });
      if (mine !== run) return;
      if (error instanceof ServerError && error.status === 401) return deps.signIn('Please sign in again.', () => ask(idea));
      status(error.message || 'Something went wrong.');
      $('createGo').disabled = false; $('prompt').readOnly = false;
    }
  }

  // Four versions; Try again paints four more of the same idea.
  function pick(idea, choices, variants) {
    show(`<p class="eyebrow">CREATE PUZZLE</p><h2>Pick one</h2><p>${esc(idea)}</p><div class="candidates" id="candidates"></div><button class="home-button" id="again">Try again</button>`, () => { run++; });
    choices.forEach((choice, n) => {
      const button = document.createElement('button');
      button.className = 'candidate'; button.setAttribute('aria-label', `Option ${n + 1}, ${choice.colors.length} colors`);
      button.innerHTML = `<img alt="" src="${thumbnail(choice, n)}"><span>${choice.colors.length} colors</span>`;
      button.onclick = () => {
        deps.track('llm_pick', { prompt: idea, option: n + 1, colors: choice.colors.length, variant: variants[n] });
        made(idea, { ...choice, id: `custom-${Date.now().toString(36)}` }, variants[n]);
      };
      $('candidates').append(button);
    });
    $('again').onclick = () => again(idea);
  }
  const thumbnail = (choice, n) => deps.thumbnail({ ...choice, id: `choice-${Date.now()}-${n}` }, 4);
  function again(idea) { ask(idea); paint(idea); }

  // The picked version isn't saved until the player decides; closing the pop-up keeps it.
  function made(idea, puzzle, variant) {
    let decided = false;
    const keep = () => { decided = true; if (deps.keep(puzzle)) return true; $('madeNote').textContent = 'This browser could not save the puzzle.'; decided = false; return false; };
    show(`<p class="eyebrow">YOUR NEW PUZZLE</p><h2>${esc(puzzle.title)}</h2><img src="${deps.thumbnail(puzzle, 8)}" alt="Your new puzzle"><button class="primary" id="playMade">Play now</button><button class="home-button" id="keepMade">Save to Free play</button><button class="home-button" id="againMade">Try again</button><p id="madeNote" role="status"></p>`,
      () => { if (!decided) deps.keep(puzzle); });
    $('playMade').onclick = () => { if (keep()) { deps.track('made_puzzle', { choice: 'play', variant }); $('modal').close(); deps.play(puzzle); } };
    $('keepMade').onclick = () => { if (keep()) { deps.track('made_puzzle', { choice: 'free_play', variant }); deps.freePlay(); } };
    $('againMade').onclick = () => { decided = true; deps.track('made_puzzle', { choice: 'again', variant }); again(idea); };
  }

  return { start };
}
