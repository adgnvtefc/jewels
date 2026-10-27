import test from 'node:test';
import assert from 'node:assert/strict';
import { createPuzzle, transfer, select, SHELF_SIZE } from './game.js';
import { snapshot, mergeSaves, storeSnapshot, removeCustom, addCustom, packSaves, unpackSaves, saveKey, progress } from './library.js';

// A Map-backed localStorage, as a browser exposes it.
const fakeStorage = () => {
  const data = new Map();
  return { get length() { return data.size; }, key: i => [...data.keys()][i] ?? null,
    getItem: k => data.has(k) ? data.get(k) : null, setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) };
};
const art = { id: 'tiny', title: 'Tiny', width: 4, height: 2, colors: ['#00f', '#ff0'], pixels: [0, 0, 1, 1, 0, 0, 1, 1] };
const mine = { id: 'custom-a', title: 'Mine', width: 4, height: 2, colors: ['#00f', '#ff0'], pixels: [0, 0, 1, 1, 0, 0, 1, 1] };
const start = { board: [1, 1, 0, 0, 1, 1, 0, 0], shelf: Array(SHELF_SIZE).fill(-1), moves: 0 };
const solved = { board: [0, 0, 1, 1, 0, 0, 1, 1], shelf: Array(SHELF_SIZE).fill(-1), moves: 3 };

test('merging keeps the furthest progress, then the most recent save', () => {
  const a = { saves: { tiny: { ...solved, savedAt: 1 } } }, b = { saves: { tiny: { ...start, savedAt: 9 } } };
  assert.equal(mergeSaves(a, b, [art]).saves.tiny.moves, 3, 'finished beats newer but behind');
  assert.equal(mergeSaves(b, a, [art]).saves.tiny.moves, 3);
  const c = { saves: { tiny: { ...start, moves: 7, savedAt: 10 } } };
  assert.equal(mergeSaves(b, c, [art]).saves.tiny.moves, 7, 'equal progress: newest wins');
  assert.equal(mergeSaves(b, a, [art], new Set(['tiny'])).saves.tiny.moves, 0, 'the puzzle being played keeps its own copy');
});

test('merging unions created puzzles and honours removals from either side', () => {
  const other = { id: 'custom-b', title: 'Theirs', width: 1, height: 1, colors: ['#000'], pixels: [0] };
  const merged = mergeSaves({ custom: [mine], saves: { 'custom-a': start } }, { custom: [mine, other], removed: ['custom-a'] }, [art]);
  assert.deepEqual(merged.custom.map(a => a.id), ['custom-b']);
  assert.deepEqual(merged.removed, ['custom-a']);
  assert.equal(merged.saves['custom-a'], undefined);
});

test('snapshot and storeSnapshot round-trip through localStorage, including removals', () => {
  globalThis.localStorage = fakeStorage();
  addCustom(mine);
  localStorage.setItem(saveKey('tiny'), JSON.stringify(solved));
  localStorage.setItem('little-jewel:generator-password', 'secret');
  const snap = snapshot();
  assert.deepEqual(Object.keys(snap.saves), ['tiny']);
  assert.ok(!JSON.stringify(snap).includes('secret'), 'the password never leaves with the saves');
  globalThis.localStorage = fakeStorage();
  storeSnapshot(snap);
  assert.equal(progress(art), 1);
  removeCustom('custom-a');
  assert.deepEqual(snapshot().removed, ['custom-a']);
  assert.deepEqual(snapshot().custom, []);
});

test('saves pack into link-safe text and unpack unchanged', async () => {
  const s = createPuzzle(art), moved = transfer(art, s, select(art, s, 'board', 0), 'shelf').state;
  const snap = { saves: { tiny: moved }, custom: [mine], removed: [] };
  const text = await packSaves(snap);
  assert.match(text, /^[zj][A-Za-z0-9_-]+$/);
  assert.deepEqual(await unpackSaves(text), snap);
  await assert.rejects(unpackSaves('zNOT-A-SAVE'));
});
