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
const art = { id: 'interaction-test', width: 2, height: 2,
  colors: ['#0088ff', '#ffee00'], pixels: [0, 1, 0, 1] };
async function mount({ location = { search: '', hostname: 'example.test' }, history = {}, wait = true, levels = 1, bonus = 0,
  saved: initial = { board: [1, 0, 1, 0], shelf: Array(24).fill(-1), moves: 0 }, stored = {}, server = () => [404, {}], confirm = () => true } = {}) {
  // One save per puzzle; level 1 is `art`, and further levels are copies of it under their own ids.
  const saves = { [art.id]: initial }, saved = () => saves[art.id];
  const ctx = new Proxy({}, {
    get(target, name) {
      if (name === 'createLinearGradient') return () => ({ addColorStop() {} });
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
    + ['./convert.js', './account.js', './library.js', './generator.js', './sync.js', './chat.js'].map(inline).join('\n')
    + readFileSync(new URL('./app.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '');
  const store = { ...stored }, sorting = 'little-jewel:sorting-v2:', calls = [];
  const running = runInNewContext(`(async () => {
    ${source}
    return { view: () => ({zoom, ox, oy}), isBusy: () => busy };
  })()`, {
    game, console, window: { devicePixelRatio: 1 },
    document: { getElementById: id => elements[id] ?? null, createElement: element, body: element(), visibilityState: 'visible', addEventListener() {} },
    confirm,
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
  await t.tap(100, 100); // Yellow jewels.
  await t.tap(300, 100); // Place them on the freed yellow spaces.
  assert.deepEqual(t.saved().board, [-1, 1, -1, 1]);
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

test('Fill and skip finishes levels 1-10, opens level 11 next, and then hides itself', async () => {
  const t = await mount({ levels: 11 });
  assert.equal(t.elements.skipAhead.hidden, false);
  assert.equal(t.elements.startLevel.textContent, 'Level 1 of 11');
  t.elements.skipAhead.onclick();
  for (const id of ['interaction-test', ...Array.from({ length: 9 }, (_, n) => `level-${n + 2}`)]) assert.deepEqual(t.saves[id].board, art.pixels, id);
  assert.equal(t.saves['level-11'], undefined, 'level 11 is left to play');
  assert.equal(t.elements.startLevel.textContent, 'Level 11 of 11');
  assert.equal(t.elements.skipAhead.hidden, true);
  t.elements.gallery.onclick();
  assert.equal((t.elements.modalContent.markup.match(/gallery-item/g) || []).length, 10);
});

test('with ten levels or fewer there is nothing to skip to', async () => {
  const t = await mount();
  assert.equal(t.elements.skipAhead.hidden, true);
  assert.equal(t.elements.bonusTip.hidden, true, 'no bonus puzzles, no pop-up');
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

// A signed-in browser: hanmo, friends with anushka, talking to a fake server.
const tick = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
const sent = { id: 'custom-sent1', title: 'From <b>her</b>', width: 2, height: 2, colors: ['#0088ff', '#ffee00'], pixels: [0, 1, 0, 1] };
const signedIn = { 'little-jewel:account': JSON.stringify({ name: 'hanmo', token: 'tok', friends: ['anushka'] }) };
function fakeServer({ messages = [], library = [], unread = 0 } = {}) {
  return (method, path, body) => {
    if (path.startsWith('/api/saves') && method === 'GET') return [200, { rev: 5, saves: [], library }];
    if (path === '/api/saves') return [200, { rev: 6, results: Object.fromEntries(body.saves.map(s => [s.puzzle, { rev: 6 }])), rejected: [] }];
    if (path.startsWith('/api/messages?') || path === '/api/messages') return method === 'GET'
      ? [200, { messages, puzzles: { [sent.id]: sent }, unread, start: true }]
      : [201, { message: { id: 99, from: 'hanmo', to: 'anushka', kind: body.text ? 'text' : 'puzzle', text: body.text, puzzle: body.puzzle, client_id: body.client_id, at: 1 } }];
    if (path === '/api/messages/read') return [200, { unread: 0 }];
    if (path === '/api/logout') return [200, { ok: true }];
    return [404, {}];
  };
}

test('signed in: the corner shows the name, progress is the account’s own, and it syncs', async () => {
  const t = await mount({ stored: signedIn, server: fakeServer({ unread: 2 }) });
  await tick();
  assert.equal(t.elements.accountButton.textContent, 'Hanmo');
  assert.equal(t.elements.chatButton.hidden, false);
  assert.equal(t.elements.chatLabel.textContent, 'Chat with Anushka');
  assert.equal(t.elements.unreadBadge.textContent, '2');
  t.elements.startGame.onclick();
  await t.tap(300, 100);
  t.elements.shelf.children[0].onclick();
  await t.settle();
  assert.equal(t.saves['interaction-test'].moves, 0, 'the guest save is untouched');
  assert.equal(JSON.parse(t.store['little-jewel:hanmo:sorting-v2:interaction-test']).moves, 1);
  assert.deepEqual(JSON.parse(t.store['little-jewel:hanmo:sync']).dirty, ['interaction-test'], 'noted for the next sync');
});

test('chat shows messages as text, never HTML, and a sent puzzle opens on tap; Menu returns to the chat', async () => {
  const attack = '<img src=x onerror=alert(1)>';
  const t = await mount({ stored: signedIn, server: fakeServer({
    library: [{ puzzle: sent.id, art: sent, from: 'anushka', rev: 3, removed: false }],
    messages: [{ id: 1, from: 'anushka', to: 'hanmo', kind: 'text', text: attack, client_id: 'a', at: 1 },
      { id: 2, from: 'anushka', to: 'hanmo', kind: 'puzzle', puzzle: sent.id, client_id: 'b', at: 2 }] }) });
  await tick();
  t.elements.chatButton.onclick();
  await tick();
  assert.equal(t.elements.chat.hidden, false);
  const items = t.elements.chatMessages.children;
  const text = items.flatMap(li => li.children).find(child => child.className === 'chat-text');
  assert.equal(text.textContent, attack);
  assert.equal(items.some(li => JSON.stringify(li).includes('markup')), false, 'nothing in the chat is built from HTML');
  const card = items.flatMap(li => li.children).find(child => child.className === 'chat-card');
  assert.equal(card.children[1].children[1].textContent, 'from Anushka · Not started');
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
  const t = await mount({ stored: { ...signedIn, 'little-jewel:hanmo:custom-puzzles': JSON.stringify([mine]) },
    server: fakeServer({ library: [{ puzzle: sent.id, art: sent, from: 'anushka', rev: 3, removed: false }] }) });
  await tick();
  t.elements.freePlay.onclick();
  assert.equal(t.elements.sentList.children.length, 1);
  assert.match(t.elements.sentList.children[0].markup, /from Anushka/);
  assert.match(t.elements.sentList.children[0].markup, /From &#60;b&#62;her/, 'titles are escaped');
  assert.equal(t.elements.puzzleList.children.length, 1);
  t.elements.chatButton.onclick();
  t.elements.chatPuzzle.onclick();
  assert.equal(t.elements.pickList.children.length, 1, 'only the puzzle you made');
  t.elements.pickCreate.onclick();
  assert.equal(t.elements.create.hidden, false, 'Create puzzle opens the create bar');
  assert.equal(t.elements.modal.open, false);
});

test('signing in offers this browser’s guest progress, and moves it once', async () => {
  const solved = { board: [0, 1, 0, 1], shelf: Array(24).fill(-1), moves: 4, savedAt: 1 };
  const t = await mount({ saved: solved, server: (method, path, body) => path === '/api/login'
    ? [200, { name: 'anushka', token: 'tok', friends: ['hanmo'] }] : fakeServer()(method, path, body) });
  t.elements.accountButton.onclick();
  t.elements.signInName.value = 'anushka'; t.elements.password.value = 'pw';
  const done = t.elements.signInForm.onsubmit({ preventDefault() {}, target: t.elements.signInForm });
  await tick();
  assert.match(t.elements.modalContent.markup, /Add this browser’s progress \(1 puzzle\) to Anushka\?/);
  t.elements.askYes.onclick(); t.elements.modal.onclose();
  await done;
  assert.equal(t.saves['interaction-test'], undefined, 'the guest copy is gone');
  assert.equal(JSON.parse(t.store['little-jewel:anushka:sorting-v2:interaction-test']).moves, 4);
  assert.ok(t.calls.some(c => c.method === 'PUT' && c.body.saves[0].puzzle === 'interaction-test'), 'and sent to the server');
  assert.equal(t.elements.accountButton.textContent, 'Anushka');
});

test('the old shared password is forgotten, and its saves are not offered to anyone but Anushka', async () => {
  const solved = { board: [0, 1, 0, 1], shelf: Array(24).fill(-1), moves: 4, savedAt: 7 };
  const t = await mount({ saved: solved, stored: { 'little-jewel:generator-password': 'old' }, server: (method, path, body) => path === '/api/login'
    ? [200, { name: 'hanmo', token: 'tok', friends: ['anushka'] }] : fakeServer()(method, path, body) });
  assert.equal(t.store['little-jewel:generator-password'], undefined);
  t.elements.accountButton.onclick();
  t.elements.signInName.value = 'hanmo'; t.elements.password.value = 'pw';
  await t.elements.signInForm.onsubmit({ preventDefault() {}, target: t.elements.signInForm });
  assert.doesNotMatch(t.elements.modalContent.markup || '', /Add this browser/);
  assert.equal(t.saves['interaction-test'].moves, 4, 'still there as guest progress');
  assert.equal(t.store['little-jewel:hanmo:sorting-v2:interaction-test'], undefined);
});

test('signing out removes the account’s copy from this browser', async () => {
  const t = await mount({ stored: { ...signedIn, 'little-jewel:hanmo:sorting-v2:interaction-test': '{}' }, server: fakeServer() });
  await tick();
  t.elements.accountButton.onclick();
  await t.elements.signOutHere.onclick();
  assert.equal(t.store['little-jewel:account'], undefined);
  assert.equal(t.elements.accountButton.textContent, 'Sign in');
  assert.equal(t.elements.chatButton.hidden, true);
  assert.ok(t.calls.some(c => c.path === '/api/logout'));
});
