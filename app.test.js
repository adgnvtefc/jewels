import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as game from './game.js';

// Inline the app's own modules (everything but game.js) so they share the test context.
const inline = file => {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/^import .*$/gm, '');
  const names = [...source.matchAll(/^export (?:async )?(?:function|const|class|let) (\w+)/gm)].map(m => m[1]);
  return `const {${names}} = (() => {${source.replace(/^export /gm, '')}\nreturn {${names}};})();`;
};

// Run the real app entry point against its actual HTML IDs and a small DOM.
// This catches missing-control crashes that pure puzzle tests cannot detect.
// What the fake canvas reads back from a painted picture: a red disc on white, 64 × 64.
const picture = new Uint8ClampedArray(64 * 64 * 4).map((_, i) => {
  const p = i >> 2, x = p % 64, y = p >> 6, inside = (x - 32) ** 2 + (y - 32) ** 2 < 400;
  return i % 4 === 3 ? 255 : inside ? [220, 40, 40][i % 4] : 250;
});
const art = { id: 'interaction-test', width: 2, height: 2,
  colors: ['#0088ff', '#ffee00'], pixels: [0, 1, 0, 1] };
async function mount({ location = { search: '', hostname: 'example.test' }, history = {}, wait = true, levels = 1, bonus = 0,
  saved: initial = { board: [1, 0, 1, 0], shelf: Array(24).fill(-1), moves: 0 }, stored = {}, server = () => [404, {}], confirm = () => true, navigator, catseye } = {}) {
  // One save per puzzle; level 1 is `art`, and further levels are copies of it under their own ids.
  const saves = { [art.id]: initial }, saved = () => saves[art.id];
  const ctx = new Proxy({}, {
    get(target, name) {
      if (name === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (name === 'getImageData') return () => ({ data: picture });
      return target[name] ?? (() => {});
    },
  });
  let elements;
  const element = () => ({
    children: [], style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {}, setPointerCapture() {}, addEventListener() {}, focus() {}, select() {},
    querySelector(selector) { return (this.found ??= {})[selector] ??= element(); },
    replaceChildren(...children) { this.children = children; },
    toDataURL: () => 'data:image/png;base64,',
    append(child) { this.children.push(child); }, remove() {},
    getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 400, height: 400 }),
    getContext: () => ctx, clientWidth: 400,
    animate: () => ({ finished: Promise.resolve() }),
    showModal() { this.open = true; }, close() { this.open = false; },
    set innerHTML(markup) {
      this.markup = markup;
      for (const [, id] of markup.matchAll(/id="([^"]+)"/g)) elements[id] = element();
    },
  });
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, element()]));
  const source = `const {${Object.keys(game)}} = game;\n`
    + ['./convert.js', './account.js', './library.js', './generator.js', './sync.js', './chat.js', './create.js'].map(inline).join('\n')
    + readFileSync(new URL('./app.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '');
  const store = { ...stored }, sorting = 'little-jewel:sorting-v2:', calls = [];
  const running = runInNewContext(`(async () => {
    ${source}
    return { view: () => ({zoom, ox, oy}), isBusy: () => busy, sparkles: () => sparkles.map(s => s.i),
      ripples: () => ripples.map(r => ({ cells: r.cells.map(c => c.i), from: r.cells.find(c => c.delay === 0).i })) };
  })()`, {
    game, console, window: { devicePixelRatio: 1 },
    document: { getElementById: id => elements[id] ?? null, createElement: element, body: element(), visibilityState: 'visible', addEventListener() {} },
    confirm, navigator, catseye,
    Image: class { naturalWidth = 64; naturalHeight = 64; decode() { return Promise.resolve(); } },
    fetch: async (url, options = {}) => url.includes('/api/') ? (() => {
      const path = url.slice(url.indexOf('/api/')), body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ method: options.method || 'GET', path, body });
      const [status, reply] = server(options.method || 'GET', path, body);
      return { ok: status < 400, status, json: async () => reply };
    })() : ({ ok: true, json: async () => url.endsWith('puzzles.json')
      ? Array.from({ length: levels }, (_, n) => `level-${n + 1}.json`)
      : url.endsWith('bonus.json') ? Array.from({ length: bonus }, (_, n) => `bonus-${n + 1}.json`)
      : url.endsWith('level-1.json') ? art : { ...art, id: url.match(/((?:level|bonus)-\d+)\.json$/)[1] } }),
    localStorage: {
      getItem: key => key.startsWith(sorting) ? (saves[key.slice(sorting.length)] ? JSON.stringify(saves[key.slice(sorting.length)]) : null) : store[key] ?? null,
      setItem: (key, value) => { if (key.startsWith(sorting)) saves[key.slice(sorting.length)] = JSON.parse(value); else store[key] = value; },
      removeItem: key => { if (key.startsWith(sorting)) delete saves[key.slice(sorting.length)]; else delete store[key]; },
      get length() { return Object.keys(store).length + Object.keys(saves).length; },
      key: i => [...Object.keys(store), ...Object.keys(saves).map(id => sorting + id)][i] ?? null,
    },
    location, history, URLSearchParams, TextEncoder, TextDecoder, Blob, Response, CompressionStream, DecompressionStream, btoa, atob,
    setTimeout: (f, ms) => setTimeout(f, ms).unref(), clearTimeout,
    matchMedia: () => ({ matches: false }),
    ResizeObserver: class { constructor(callback) { this.callback = callback; } observe() { this.callback(); } },
  });
  if (!wait) return { running, saved };
  const app = await running;
  const pointer = (id, x, y, type) => ({ pointerId: id, pointerType: 'touch', clientX: x, clientY: y, type });
  const board = elements.board;
  // A move ends once every flying jewel has landed, a frame after its flight.
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); for (let i = 0; i < 100 && app.isBusy(); i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.equal(app.isBusy(), false); };
  const tap = async (x, y) => {
    board.onpointerdown(pointer(1, x, y, 'pointerdown'));
    board.onpointerup(pointer(1, x, y, 'pointerup'));
    await settle();
  };
  return { app, elements, board, pointer, tap, settle, saved, saves, store, calls };
}

test('minimal UI loads and transfers board → shelf → board without camera jumps', async () => {
  const t = await mount();
  t.elements.startGame.onclick();
  assert.equal(t.app.view().zoom, 1);
  for (const id of ['fit', 'undo', 'hint', 'zoomIn', 'zoomOut']) assert.equal(t.elements[id], undefined);
  await t.tap(300, 100); // Blue jewels sitting on yellow.
  t.elements.shelf.children[0].onclick();
  await t.settle();
  assert.deepEqual(t.saved().board, [1, -1, 1, -1]);
  assert.deepEqual(t.saved().shelf.slice(0, 2), [0, 0]);
  assert.deepEqual([...t.app.sparkles()], [], 'no sparkle for jewels put on the shelf');
  await t.tap(100, 100); // Yellow jewels.
  await t.tap(300, 100); // Place them on the freed yellow spaces.
  assert.deepEqual(t.saved().board, [-1, 1, -1, 1]);
  assert.deepEqual([...t.app.sparkles()].sort(), [1, 3], 'each jewel landing in its spot sparkles');
  const [yellow, ...more] = t.app.ripples();
  assert.equal(more.length, 0, 'only the finished color ripples; blue still has jewels on the shelf');
  assert.deepEqual([...yellow.cells].sort(), [1, 3], 'every jewel of that color takes part');
  assert.ok([1, 3].includes(yellow.from), 'starting from a jewel that just landed');
  const view = JSON.stringify(t.app.view());
  t.elements.shelf.children[0].onclick();
  assert.equal(JSON.stringify(t.app.view()), view, 'shelf selection must not zoom or pan');
  await t.tap(100, 100);
  assert.deepEqual(t.saved().board, [0, 1, 0, 1]);
  assert.ok(t.saved().shelf.every(c => c === -1));
  assert.equal(t.saved().selectedColor, 0);
  assert.equal(t.elements.modal.open, true);
  t.elements.modal.close(); t.elements.modal.onclose();
  assert.equal(t.elements.home.hidden, false, 'a finished level returns to the start screen');
  assert.equal(t.elements.game.hidden, true);
  assert.equal(t.elements.startGame.disabled, true, 'the only level is complete');
  t.elements.gallery.onclick();
  assert.match(t.elements.modalContent.markup, /gallery-item/);
});

test('pinch zooms in and out, never moves jewels, and a cancelled gesture leaves taps usable', async () => {
  const t = await mount();
  t.elements.startGame.onclick();
  const before = JSON.stringify(t.saved().board);
  t.board.onpointerdown(t.pointer(1, 100, 200, 'pointerdown'));
  t.board.onpointerdown(t.pointer(2, 300, 200, 'pointerdown'));
  t.board.onpointermove(t.pointer(1, 50, 200, 'pointermove'));
  t.board.onpointermove(t.pointer(2, 350, 200, 'pointermove'));
  assert.equal(t.app.view().zoom, 1.5);
  const zoomed = JSON.stringify(t.app.view());
  t.elements.addShelf.onclick();
  assert.equal(t.saved().shelf.length, 32);
  assert.equal(JSON.stringify(t.app.view()), zoomed, 'adding shelf space must not move the camera');
  t.board.onpointermove(t.pointer(1, 100, 200, 'pointermove'));
  t.board.onpointermove(t.pointer(2, 300, 200, 'pointermove'));
  assert.equal(t.app.view().zoom, 1);
  t.board.onpointercancel(t.pointer(1, 100, 200, 'pointercancel'));
  t.board.onpointerup(t.pointer(2, 300, 200, 'pointerup'));
  assert.equal(JSON.stringify(t.saved().board), before);
  assert.equal(t.saved().moves, 0);
  await t.tap(300, 100);
  t.elements.shelf.children[0].onclick();
  await t.settle();
  assert.equal(t.saved().moves, 1);
});

test('the start screen offers levels, free play and the gallery; Menu returns to it', async () => {
  const t = await mount();
  assert.equal(t.elements.home.hidden, false);
  assert.equal(t.elements.game.hidden, true);
  assert.equal(t.elements.startLevel.textContent, 'Level 1 of 1');
  t.elements.gallery.onclick();
  assert.match(t.elements.modalContent.markup, /Finish a puzzle/);
  t.elements.freePlay.onclick();
  assert.equal(t.elements.modal.open, true);
  t.elements.createOwn.onclick();
  assert.ok(t.elements.signInForm, 'a guest is asked to sign in');
  assert.match(t.elements.modalContent.markup, /Creating puzzles needs an account/);
  assert.equal(t.elements.chatButton.hidden, true, 'no chat for a guest');
  assert.equal(t.calls.length, 0, 'a guest never talks to the server');
  t.elements.modal.close();
  t.elements.startGame.onclick();
  assert.equal(t.elements.game.hidden, false);
  t.elements.menu.onclick();
  assert.equal(t.elements.home.hidden, false);
});

test('a visit to the http address hands its saves to https in the link and leaves', async () => {
  let destination = null;
  const location = { protocol: 'http:', hostname: 'momoswebsiteofthehour.com', pathname: '/', search: '', replace: url => { destination = url; } };
  const { running } = await mount({ location, wait: false });
  running.catch(() => {});
  // Packing the saves is compressed asynchronously, so give it real time on a slow machine.
  for (let i = 0; i < 400 && !destination; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(destination, /^https:\/\/momoswebsiteofthehour\.com\/(#carry=[zj][\w-]+)?$/);
});

test('saves carried in the link are merged in on https, and the link is cleaned up', async () => {
  const { packSaves } = await import('./library.js');
  const solved = { board: [0, 1, 0, 1], shelf: Array(24).fill(-1), moves: 4, savedAt: 1 };
  const carry = await packSaves({ saves: { 'interaction-test': solved }, custom: [], removed: [] });
  let cleaned = null;
  const t = await mount({
    location: { protocol: 'https:', hostname: 'momoswebsiteofthehour.com', pathname: '/', search: '', hash: `#carry=${carry}` },
    history: { replaceState: (_, __, url) => { cleaned = url; } },
  });
  assert.equal(cleaned, '/');
  assert.deepEqual(t.saved().board, [0, 1, 0, 1], 'the carried finished level replaces the fresh one');
  assert.equal(t.elements.startGame.disabled, true, 'the level shows as complete');
});

test('the start screen has no skip button any more, and no bonus pop-up without bonus puzzles', async () => {
  const t = await mount({ levels: 11 });
  assert.equal(t.elements.skipAhead, undefined);
  assert.equal(t.elements.startLevel.textContent, 'Level 1 of 11');
  assert.equal(t.elements.bonusTip.hidden, true, 'no bonus puzzles, no pop-up');
});

test('the move counter shows the moves so far, and the header names the level', async () => {
  const t = await mount({ saved: { board: [1, 0, 1, 0], shelf: Array(24).fill(-1), moves: 1 } });
  t.elements.startGame.onclick();
  assert.equal(t.elements.moveCount.textContent, '1 move');
  assert.equal(t.elements.puzzleName.textContent, 'Level 1 · ' + art.title);
  await t.tap(300, 100);
  t.elements.shelf.children[0].onclick();
  await t.settle();
  assert.equal(t.elements.moveCount.textContent, '2 moves');
});

test('bonus puzzles live in Free play, not the levels, and the pop-up goes once Free play opens', async () => {
  const t = await mount({ bonus: 2 });
  assert.equal(t.elements.startLevel.textContent, 'Level 1 of 1');
  assert.equal(t.elements.bonusTip.hidden, false);
  t.elements.bonusTip.onclick();
  assert.equal(t.elements.bonusList.children.length, 2);
  assert.equal(t.elements.bonusTip.hidden, true);
  t.elements.bonusList.children[1].querySelector('.puzzle-pick').onclick();
  assert.equal(t.elements.game.hidden, false);
  t.board.onpointerdown(t.pointer(1, 300, 100, 'pointerdown'));
  t.board.onpointerup(t.pointer(1, 300, 100, 'pointerup'));
  await t.settle();
  t.elements.shelf.children[0].onclick();
  await t.settle();
  assert.equal(t.saves['bonus-2'].moves, 1, 'a bonus puzzle saves under its own id');
  t.elements.menu.onclick();
  assert.equal(t.elements.bonusTip.hidden, true, 'the pop-up stays gone');
  assert.equal(t.elements.startLevel.textContent, 'Level 1 of 1');
});

// A signed-in browser: bob, friends with billy, talking to a fake server.
const tick = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
const sent = { id: 'custom-sent1', title: 'From <b>her</b>', width: 2, height: 2, colors: ['#0088ff', '#ffee00'], pixels: [0, 1, 0, 1] };
const signedIn = { 'little-jewel:account': JSON.stringify({ name: 'bob', token: 'tok', friends: ['billy'] }) };
function fakeServer({ messages = [], library = [], unread = 0, notify = { messages: true, puzzles: true, finished: true } } = {}) {
  return (method, path, body) => {
    if (path.startsWith('/api/saves') && method === 'GET') return [200, { rev: 5, saves: [], library }];
    if (path === '/api/saves') return [200, { rev: 6, results: Object.fromEntries(body.saves.map(s => [s.puzzle, { rev: 6 }])), rejected: [] }];
    if (path.startsWith('/api/messages?') || path === '/api/messages') return method === 'GET'
      ? [200, { messages, puzzles: { [sent.id]: sent }, unread, start: true }]
      : [201, { message: { id: 99, from: 'bob', to: 'billy', kind: body.text ? 'text' : 'puzzle', text: body.text, puzzle: body.puzzle, client_id: body.client_id, at: 1 } }];
    if (path === '/api/messages/read') return [200, { unread: 0 }];
    if (path === '/api/logout') return [200, { ok: true }];
    if (path === '/api/notifications') return method === 'GET' ? [200, notify] : [200, Object.assign(notify, body)];
    return [404, {}];
  };
}

test('signed in: the corner shows the name, progress is the account’s own, and it syncs', async () => {
  const t = await mount({ stored: signedIn, server: fakeServer({ unread: 2 }) });
  await tick();
  assert.equal(t.elements.accountButton.textContent, 'Bob');
  assert.equal(t.elements.chatButton.hidden, false);
  assert.equal(t.elements.chatLabel.textContent, 'Chat with Billy');
  assert.equal(t.elements.unreadBadge.textContent, '2');
  t.elements.startGame.onclick();
  await t.tap(300, 100);
  t.elements.shelf.children[0].onclick();
  await t.settle();
  assert.equal(t.saves['interaction-test'].moves, 0, 'the guest save is untouched');
  assert.equal(JSON.parse(t.store['little-jewel:bob:sorting-v2:interaction-test']).moves, 1);
  assert.deepEqual(JSON.parse(t.store['little-jewel:bob:sync']).dirty, ['interaction-test'], 'noted for the next sync');
});

test('Settings shows only when signed in and saves each chat notification switch to the server', async () => {
  const guest = await mount();
  assert.equal(guest.elements.settingsButton.hidden, true, 'guests have no settings');
  const notify = { messages: true, puzzles: false, finished: true };
  const t = await mount({ stored: signedIn, server: fakeServer({ notify }) });
  await tick();
  assert.equal(t.elements.settingsButton.hidden, false);
  t.elements.settingsButton.onclick();
  await tick();
  assert.equal(t.elements.settings.hidden, false); assert.equal(t.elements.home.hidden, true);
  assert.deepEqual([t.elements.notifyMessages.checked, t.elements.notifyPuzzles.checked, t.elements.notifyFinished.checked], [true, false, true], 'shows what the server has');
  t.elements.notifyFinished.checked = false;
  await t.elements.notifyFinished.onchange();
  assert.deepEqual(t.calls.find(c => c.method === 'PUT' && c.path === '/api/notifications').body, { finished: false }, 'sends only the switch that changed');
  assert.equal(notify.finished, false);
  assert.equal(t.elements.settingsStatus.textContent, 'Saved.');
  t.elements.settingsBack.onclick();
  assert.equal(t.elements.home.hidden, false);
});

test('chat shows messages as text, never HTML, and a sent puzzle opens on tap; Menu returns to the chat', async () => {
  const attack = '<img src=x onerror=alert(1)>';
  const t = await mount({ stored: signedIn, server: fakeServer({
    library: [{ puzzle: sent.id, art: sent, from: 'billy', rev: 3, removed: false }],
    messages: [{ id: 1, from: 'billy', to: 'bob', kind: 'text', text: attack, client_id: 'a', at: 1 },
      { id: 2, from: 'billy', to: 'bob', kind: 'puzzle', puzzle: sent.id, client_id: 'b', at: 2 }] }) });
  await tick();
  t.elements.chatButton.onclick();
  await tick();
  assert.equal(t.elements.chat.hidden, false);
  const items = t.elements.chatMessages.children;
  const text = items.flatMap(li => li.children).find(child => child.className === 'chat-text');
  assert.equal(text.textContent, attack);
  assert.equal(items.some(li => JSON.stringify(li).includes('markup')), false, 'nothing in the chat is built from HTML');
  const card = items.flatMap(li => li.children).find(child => child.className === 'chat-card');
  assert.equal(card.children[1].children[1].textContent, 'from Billy · Not started');
  card.onclick();
  assert.equal(t.elements.game.hidden, false);
  t.elements.menu.onclick();
  assert.equal(t.elements.chat.hidden, false, 'back to the chat');
  assert.ok(t.calls.some(c => c.path === '/api/messages/read' && c.body.up_to === 2), 'read up to the newest');
  t.elements.chatText.value = 'hello';
  t.elements.chatForm.onsubmit({ preventDefault() {} });
  await tick();
  assert.equal(t.calls.find(c => c.method === 'POST' && c.path === '/api/messages').body.text, 'hello');
});

test('puzzles sent to you show in Free play, and only your own can be picked to send', async () => {
  const mine = { ...sent, id: 'custom-mine1', title: 'Mine' };
  const t = await mount({ stored: { ...signedIn, 'little-jewel:bob:custom-puzzles': JSON.stringify([mine]) },
    server: fakeServer({ library: [{ puzzle: sent.id, art: sent, from: 'billy', rev: 3, removed: false }] }) });
  await tick();
  t.elements.freePlay.onclick();
  assert.equal(t.elements.sentList.children.length, 1);
  assert.match(t.elements.sentList.children[0].markup, /from Billy/);
  assert.match(t.elements.sentList.children[0].markup, /From &#60;b&#62;her/, 'titles are escaped');
  assert.equal(t.elements.puzzleList.children.length, 1);
  t.elements.chatButton.onclick();
  t.elements.chatPuzzle.onclick();
  assert.equal(t.elements.pickList.children.length, 1, 'only the puzzle you made');
  t.elements.pickCreate.onclick();
  assert.ok(t.elements.createForm, 'Create puzzle opens the create pop-up');
  assert.equal(t.elements.modal.open, true);
});

test('signing in offers this browser’s guest progress, and moves it once', async () => {
  const solved = { board: [0, 1, 0, 1], shelf: Array(24).fill(-1), moves: 4, savedAt: 1 };
  const t = await mount({ saved: solved, server: (method, path, body) => path === '/api/login'
    ? [200, { name: 'billy', token: 'tok', friends: ['bob'] }] : fakeServer()(method, path, body) });
  t.elements.accountButton.onclick();
  t.elements.signInName.value = 'billy'; t.elements.password.value = 'pw';
  const done = t.elements.signInForm.onsubmit({ preventDefault() {}, target: t.elements.signInForm });
  await tick();
  assert.match(t.elements.modalContent.markup, /Add this browser’s progress \(1 puzzle\) to Billy\?/);
  t.elements.askYes.onclick(); t.elements.modal.onclose();
  await done;
  assert.equal(t.saves['interaction-test'], undefined, 'the guest copy is gone');
  assert.equal(JSON.parse(t.store['little-jewel:billy:sorting-v2:interaction-test']).moves, 4);
  assert.ok(t.calls.some(c => c.method === 'PUT' && c.body.saves[0].puzzle === 'interaction-test'), 'and sent to the server');
  assert.equal(t.elements.accountButton.textContent, 'Billy');
});

test('a browser forgets the old shared password and the old shared-copy marker', async () => {
  const t = await mount({ stored: { 'little-jewel:generator-password': 'old', 'little-jewel:shared-v91': '{"saves":{}}' } });
  assert.equal(t.store['little-jewel:generator-password'], undefined);
  assert.equal(t.store['little-jewel:shared-v91'], undefined);
});

test('signing out removes the account’s copy from this browser', async () => {
  const t = await mount({ stored: { ...signedIn, 'little-jewel:bob:sorting-v2:interaction-test': '{}' }, server: fakeServer() });
  await tick();
  t.elements.accountButton.onclick();
  await t.elements.signOutHere.onclick();
  assert.equal(t.store['little-jewel:account'], undefined);
  assert.equal(t.elements.accountButton.textContent, 'Sign in');
  assert.equal(t.elements.chatButton.hidden, true);
  assert.ok(t.calls.some(c => c.path === '/api/logout'));
});

test('on an iPhone, the Add to Home Screen hint shows once, and never in the Home Screen app', async () => {
  const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', standalone: false };
  const first = await mount({ navigator: iphone });
  assert.equal(first.elements.modal.open, true);
  assert.match(first.elements.modalContent.markup, /Add to Home Screen/);
  const again = await mount({ navigator: iphone, stored: { ...first.store } });
  assert.notEqual(again.elements.modal.open, true, 'only once');
  const app = await mount({ navigator: { ...iphone, standalone: true } });
  assert.notEqual(app.elements.modal.open, true, 'not when already on the Home Screen');
  const desktop = await mount({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 } });
  assert.notEqual(desktop.elements.modal.open, true, 'not on a computer');
});

// The create pop-up, from the start screen: idea → four versions → Play now, Save or Try again.
function painter(jobs = { n: 0 }, variants) {
  const server = fakeServer();
  return (method, path, body) => {
    if (path === '/api/jobs' && method === 'POST') { jobs.n++; jobs.prompt = body.prompt; return [202, { id: `j${jobs.n}` }]; }
    if (path.startsWith('/api/jobs/')) return [200, { status: 'done', subject: 'a red ball', images: variants ? variants.map(v => `data:${v}`) : ['data:a', 'data:b'], variants, seconds: 5 }];
    if (path === '/api/puzzles') return [201, { ok: true }];
    return server(method, path, body);
  };
}
async function createFromHome(t, idea = 'a red ball') {
  delete t.elements.candidates;
  t.elements.createHome.onclick();
  t.elements.prompt.value = idea;
  t.elements.createForm.onsubmit({ preventDefault() {} });
  for (let i = 0; i < 300 && !t.elements.candidates?.children.length; i++) await tick(10);
  assert.ok(t.elements.candidates.children.length >= 2, 'one version per picture');
}
const made = t => JSON.parse(t.store['little-jewel:bob:custom-puzzles'] || '[]');

test('a guest who taps Create puzzle on the start screen is asked to sign in first', async () => {
  const t = await mount();
  t.elements.createHome.onclick();
  assert.ok(t.elements.signInForm);
  assert.match(t.elements.modalContent.markup, /Creating puzzles needs an account/);
});

test('Create puzzle: the picked version is saved only on Play now, and opens', async () => {
  const jobs = { n: 0 }, t = await mount({ stored: signedIn, server: painter(jobs) });
  await tick();
  await createFromHome(t);
  assert.equal(jobs.prompt, 'a red ball');
  t.elements.candidates.children[0].onclick();
  assert.match(t.elements.modalContent.markup, /Play now.*Save to Free play.*Try again/);
  assert.doesNotMatch(t.elements.modalContent.markup, /Send to/, 'no sending from here');
  assert.equal(made(t).length, 0, 'not saved until a choice is made');
  t.elements.playMade.onclick(); t.elements.modal.onclose();
  assert.equal(made(t).length, 1);
  assert.equal(made(t)[0].title, 'A red ball');
  assert.equal(t.elements.game.hidden, false, 'the new puzzle is on the board');
  assert.equal(t.elements.puzzleName.textContent, 'A red ball');
});

test('Create puzzle: Save to Free play keeps it there; closing the pop-up keeps it too', async () => {
  const t = await mount({ stored: signedIn, server: painter() });
  await tick();
  await createFromHome(t);
  t.elements.candidates.children[1].onclick();
  t.elements.keepMade.onclick();
  assert.equal(made(t).length, 1);
  assert.equal(t.elements.puzzleList.children.length, 1, 'Free play opens, showing it');
  t.elements.modal.close(); t.elements.modal.onclose();
  assert.equal(made(t).length, 1, 'saved once');
  await createFromHome(t, 'a blue cup');
  t.elements.candidates.children[0].onclick();
  t.elements.modal.onclose();
  assert.equal(made(t).length, 1, 'a late close event from an earlier pop-up is ignored while this one is open');
  t.elements.modal.close(); t.elements.modal.onclose();
  assert.equal(made(t).length, 2, 'closed with ×, still kept');
  assert.equal(t.elements.home.hidden, false);
});

test('Create puzzle: Try again throws the version away and paints the same idea again', async () => {
  const jobs = { n: 0 }, t = await mount({ stored: signedIn, server: painter(jobs) });
  await tick();
  await createFromHome(t);
  t.elements.candidates.children[0].onclick();
  t.elements.againMade.onclick();
  assert.match(t.elements.modalContent.markup, /id="prompt"[^>]*value="a red ball"/, 'the idea stays in the box');
  for (let i = 0; i < 300 && jobs.n < 2; i++) await tick(10);
  assert.equal(jobs.n, 2);
  t.elements.modal.close(); t.elements.modal.onclose();
  assert.equal(made(t).length, 0, 'nothing was kept');
});

test('Create puzzle test: picks say whether they came from the artist (top) or the words as typed (bottom)', async () => {
  const events = [];
  const t = await mount({ stored: signedIn, server: painter({ n: 0 }, ['today', 'today', 'typed', 'typed']), catseye: (name, data) => events.push([name, data]) });
  await tick();
  await createFromHome(t);
  assert.equal(t.elements.candidates.children.length, 4);
  t.elements.candidates.children[2].onclick();
  t.elements.keepMade.onclick();
  const pick = events.find(([name]) => name === 'llm_pick')[1];
  assert.equal(pick.variant, 'typed');
  assert.equal(pick.option, 3);
  assert.equal(events.find(([name]) => name === 'made_puzzle')[1].variant, 'typed');
  await createFromHome(t, 'a blue cup');
  t.elements.candidates.children[0].onclick();
  assert.equal(events.filter(([name]) => name === 'llm_pick')[1][1].variant, 'today');
});
