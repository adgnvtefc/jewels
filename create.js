// Making a new puzzle works the same from everywhere (the start screen, Free play, the
// chat's 🧩): one pop-up asks for an idea, the Mac paints four versions, and the player
// picks one. The picked one is then played now, saved to Free play, or thrown away to
// try again: back to the first pop-up, with the words and photo as they were, until Create.
// Closing the pop-up at that point keeps it in Free play.
//
// The idea can be words, a photo, or both (words that add to the photo, not fight it). A photo is
// shrunk here, sent once with the request, and never saved or shared: the Mac's artist looks
// at it, writes what to paint, and drops it (server/generator.py).
//
// The Mac sends finished puzzles, each marked with the pipeline that made it (variant). In
// the painter test, two are "current" (the artist's rewrite, convert.js) and two "painter"
// (the words as typed, painter v3), shuffled; each pick records its pipeline and its place.
import { requestPuzzles, pictureToArt } from './generator.js';
import { online, ServerError } from './account.js';

// deps: { $, show(markup, then), esc, thumbnail, track,
//         keep(puzzle) → saved?, play(puzzle), freePlay(), signIn(note, then) }
// start({ send }): from the chat, `send(puzzle)` sends a puzzle there, and the finished
// pop-up offers Send to chat first.
export function createMaker(deps) {
  const { $, show, esc } = deps;
  let run = 0;  // the latest request; an older one, or one whose pop-up closed, is dropped
  let send = null;  // set when started from the chat
  const title = idea => idea[0].toUpperCase() + idea.slice(1, 60);
  const PHOTO_SIDE = 768;  // a photo's longer side as sent, in pixels; the Mac re-encodes it too

  // A chosen photo as a small JPEG data: URL (drawing it on a canvas leaves its location and
  // camera details behind).
  async function photoData(file) {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const scale = Math.min(1, PHOTO_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.85);
    } finally { URL.revokeObjectURL(url); }
  }

  function start(options) {
    send = typeof options?.send === 'function' ? options.send : null;  // a click event is not options
    if (online()) ask();
    else deps.signIn('Creating puzzles needs an account.', ask);
  }

  function ask(idea = '', photo = null) {
    show(`<p class="eyebrow">CREATE PUZZLE</p><h2>Describe a picture</h2><form id="createForm" class="create-form"><input id="prompt" maxlength="200" placeholder="A cat in a teacup" autocomplete="off" enterkeyhint="go" aria-label="Describe a picture to make into a puzzle" value="${esc(idea)}">`
      + `<div class="photo-row"><span class="photo-or">or</span><label class="photo-pick" id="photoPick"><input type="file" id="photoInput" accept="image/*" aria-label="Upload a photo">📷 Upload photo</label>`
      + `<span class="photo-chosen" id="photoChosen" hidden><img id="photoThumb" alt="Your photo"><button type="button" id="photoRemove" aria-label="Remove the photo">×</button></span></div>`
      + `<p class="photo-note">Photos stay private. If you use a photo, add no text, or text that complements it rather than contradicts it.</p>`
      + `<button class="primary" type="submit" id="createGo">Create</button></form><p id="createStatus" role="status">You’ll get four versions to choose from.</p>`, () => { run++; });
    let chosen = photo;
    const showPhoto = () => {
      $('photoPick').hidden = Boolean(chosen); $('photoChosen').hidden = !chosen;
      if (chosen) $('photoThumb').src = chosen;
    };
    showPhoto();
    if (!photo) $('prompt').focus();
    $('photoInput').onchange = async () => {
      const file = $('photoInput').files?.[0];
      $('photoInput').value = '';
      if (!file) return;
      try { chosen = await photoData(file); }
      catch { $('createStatus').textContent = 'That photo couldn’t be opened. Try another one.'; return; }
      showPhoto();
    };
    $('photoRemove').onclick = () => { chosen = null; showPhoto(); };
    $('createForm').onsubmit = e => {
      e.preventDefault();
      const text = $('prompt').value.trim();
      if (text || chosen) paint(text, chosen);
      else $('createStatus').textContent = 'Describe a picture, or add a photo.';
    };
  }

  async function paint(idea, photo = null) {
    const mine = ++run, started = Date.now();
    const status = text => { if (mine === run) $('createStatus').textContent = text; };
    const lock = locked => { $('createGo').disabled = locked; $('prompt').readOnly = locked; $('photoInput').disabled = locked; $('photoRemove').disabled = locked; };
    lock(true);
    status(photo ? 'Sending your photo…' : 'Sending your idea…');
    try {
      const job = await requestPuzzles('create', idea, job => {
        if (job.status === 'queued') status(job.ahead ? `Waiting in line (${job.ahead} ahead)…` : 'Starting…');
        else if (job.status === 'writing') status(photo && !idea ? 'Looking at your photo…' : 'Thinking about your idea…');
        else if (job.status === 'painting') status(`Painting “${job.subject}” — ${job.painted} of ${job.total}…`);
      }, photo);
      status('Cutting the jewels…');
      const candidates = job.candidates || job.images.map(image => ({ variant: 'current', image }));  // images: an older server
      const variants = candidates.map(c => c.variant);
      // Words alone name the puzzle; with a photo, the Mac names it from what the artist saw
      // (words that go with a photo, like "with a birthday candle", make a poor title).
      const name = idea && !photo ? title(idea) : null;
      const choices = await Promise.all(candidates.map(c => c.art ? { ...c.art, ...(name && { title: name }) } : pictureToArt(c.image, { title: name || 'Your photo' })));
      deps.track('llm_generate', { ok: true, prompt: idea, photo: Boolean(photo), subject: job.subject, agent: job.agent, images: candidates.length, seconds: job.seconds, ms: Date.now() - started });
      if (mine === run) pick(idea, choices, variants, photo);
    } catch (error) {
      deps.track('llm_generate', { ok: false, prompt: idea, photo: Boolean(photo), error: error.message, status: error.status, ms: Date.now() - started });
      if (mine !== run) return;
      if (error instanceof ServerError && error.status === 401) return deps.signIn('Please sign in again.', () => ask(idea, photo));
      status(error.message || 'Something went wrong.');
      lock(false);
    }
  }

  // Four versions; Try again goes back to the first pop-up with the same words and photo.
  function pick(idea, choices, variants, photo) {
    const asked = `${photo ? `<img class="photo-asked" src="${photo}" alt="Your photo">` : ''}${idea ? `<p>${esc(idea)}</p>` : ''}`;
    show(`<p class="eyebrow">CREATE PUZZLE</p><h2>Pick one</h2>${asked}<div class="candidates" id="candidates"></div><button class="home-button" id="again">Try again</button>`, () => { run++; });
    choices.forEach((choice, n) => {
      const button = document.createElement('button');
      button.className = 'candidate'; button.setAttribute('aria-label', `Option ${n + 1}, ${choice.colors.length} colors`);
      button.innerHTML = `<img alt="" src="${thumbnail(choice, n)}"><span>${choice.colors.length} colors</span>`;
      button.onclick = () => {
        deps.track('llm_pick', { prompt: idea, option: n + 1, colors: choice.colors.length, variant: variants[n], shown: variants.join(',') });
        made(idea, { ...choice, id: `custom-${Date.now().toString(36)}` }, variants[n], photo);
      };
      $('candidates').append(button);
    });
    $('again').onclick = () => again(idea, photo);
  }
  const thumbnail = (choice, n) => deps.thumbnail({ ...choice, id: `choice-${Date.now()}-${n}` }, 4);
  function again(idea, photo) { ask(idea, photo); }

  // The picked version isn't saved until the player decides; closing the pop-up keeps it.
  function made(idea, puzzle, variant, photo) {
    let decided = false;
    const keep = () => { decided = true; if (deps.keep(puzzle)) return true; $('madeNote').textContent = 'This browser could not save the puzzle.'; decided = false; return false; };
    const sendButton = send ? '<button class="primary" id="sendMade">Send to chat</button>' : '';
    show(`<p class="eyebrow">YOUR NEW PUZZLE</p><h2>${esc(puzzle.title)}</h2><img src="${deps.thumbnail(puzzle, 8)}" alt="Your new puzzle">${sendButton}<button class="${send ? 'home-button' : 'primary'}" id="playMade">Play now</button><button class="home-button" id="keepMade">Save to Free play</button><button class="home-button" id="againMade">Try again</button><p id="madeNote" role="status"></p>`,
      () => { if (!decided) deps.keep(puzzle); });
    // Sending keeps it in Free play too, as every puzzle you send is one of yours.
    if (send) $('sendMade').onclick = () => { if (keep()) { deps.track('made_puzzle', { choice: 'send', variant }); $('modal').close(); send(puzzle); } };
    $('playMade').onclick = () => { if (keep()) { deps.track('made_puzzle', { choice: 'play', variant }); $('modal').close(); deps.play(puzzle); } };
    $('keepMade').onclick = () => { if (keep()) { deps.track('made_puzzle', { choice: 'free_play', variant }); deps.freePlay(); } };
    $('againMade').onclick = () => { decided = true; deps.track('made_puzzle', { choice: 'again', variant }); again(idea, photo); };
  }

  return { start };
}
