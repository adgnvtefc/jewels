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
async function mount() {
  const art = { id: 'interaction-test', width: 2, height: 2,
    colors: ['#0088ff', '#ffee00'], pixels: [0, 1, 0, 1] };
  let saved = { board: [1, 0, 1, 0], shelf: Array(24).fill(-1), moves: 0 };
  const ctx = new Proxy({}, {
    get(target, name) {
      if (name === 'createLinearGradient') return () => ({ addColorStop() {} });
      return target[name] ?? (() => {});
    },
  });
  let elements;
  const element = () => ({
    children: [], style: { setProperty() {} }, classList: { toggle() {} },
    setAttribute() {}, setPointerCapture() {}, addEventListener() {}, focus() {}, select() {},
    querySelector(selector) { return (this.found ??= {})[selector] ??= element(); },
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
    + ['./convert.js', './library.js', './generator.js'].map(inline).join('\n')
    + readFileSync(new URL('./app.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '');
  const store = {}, sorting = 'little-jewel:sorting-v2:';
  const app = await runInNewContext(`(async () => {
    ${source}
    return { view: () => ({zoom, ox, oy}), isBusy: () => busy };
  })()`, {
    game, console, window: { devicePixelRatio: 1 },
    document: { getElementById: id => elements[id] ?? null, createElement: element, body: element() },
    fetch: async url => ({ ok: true, json: async () => url.endsWith('puzzles.json') ? ['test.json'] : art }),
    localStorage: {
      getItem: key => key.startsWith(sorting) ? JSON.stringify(saved) : store[key] ?? null,
      setItem: (key, value) => { if (key.startsWith(sorting)) saved = JSON.parse(value); else store[key] = value; },
      removeItem: key => { delete store[key]; },
    },
    location: { search: '', hostname: 'example.test' }, URLSearchParams,
    matchMedia: () => ({ matches: false }),
    ResizeObserver: class { constructor(callback) { this.callback = callback; } observe() { this.callback(); } },
  });
  const pointer = (id, x, y, type) => ({ pointerId: id, pointerType: 'touch', clientX: x, clientY: y, type });
  const board = elements.board;
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); assert.equal(app.isBusy(), false); };
  const tap = async (x, y) => {
    board.onpointerdown(pointer(1, x, y, 'pointerdown'));
    board.onpointerup(pointer(1, x, y, 'pointerup'));
    await settle();
  };
  return { app, elements, board, pointer, tap, settle, saved: () => saved, store };
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
  assert.ok(t.elements.unlockForm, 'without a saved password, the password form opens');
  t.elements.modal.close();
  t.elements.startGame.onclick();
  assert.equal(t.elements.game.hidden, false);
  t.elements.menu.onclick();
  assert.equal(t.elements.home.hidden, false);
});
