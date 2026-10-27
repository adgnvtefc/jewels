// The puzzles you can choose: the built-in set listed in assets/puzzles.json,
// plus pictures you created, kept in this browser.
import { restore, correctCount } from './game.js';

const CUSTOM = 'little-jewel:custom-puzzles', REMOVED = 'little-jewel:removed-puzzles';
const SAVE = 'little-jewel:sorting-v2:';
export const saveKey = id => SAVE + id;

const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };

export async function builtInPuzzles() {
  const files = await (await fetch('./assets/puzzles.json')).json();
  return Promise.all(files.map(async file => {
    const response = await fetch(`./assets/${file}`);
    if (!response.ok) throw new Error(`Missing ${file}`);
    return response.json();
  }));
}

const isArt = a => a && typeof a.id === 'string' && Array.isArray(a.pixels) && Array.isArray(a.colors);
const list = value => Array.isArray(value) ? value : [];
export const customPuzzles = () => list(read(CUSTOM, [])).filter(isArt);
export function addCustom(art) { return write(CUSTOM, [art, ...customPuzzles()]); }
// Removals are remembered, so a copy of the saves made elsewhere cannot bring a puzzle back.
export function removeCustom(id) {
  write(CUSTOM, customPuzzles().filter(a => a.id !== id));
  write(REMOVED, [...new Set([...list(read(REMOVED, [])), id])]);
  try { localStorage.removeItem(saveKey(id)); } catch {}
}

// Everything worth keeping, as one object: each puzzle's save, your puzzles, and removals.
export function snapshot() {
  const saves = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const save = key?.startsWith(SAVE) && read(key, null);
      if (save && typeof save === 'object') saves[key.slice(SAVE.length)] = save;
    }
  } catch {}
  return { saves, custom: customPuzzles(), removed: list(read(REMOVED, [])) };
}

// Jewels home in a save, or -1 when it does not fit the puzzle (or the puzzle is unknown).
const reached = (art, save) => { const state = art && restore(art, save); return state ? correctCount(art, state) : -1; };

// Combine two copies of the saves: the furthest progress on each puzzle (then the most
// recent), every puzzle made in either, and every removal. `keep` names puzzles whose
// own copy must win, such as the one being played right now.
export function mergeSaves(mine, theirs, builtIns = [], keep = new Set()) {
  const removed = [...new Set([...list(mine.removed), ...list(theirs.removed)])].filter(id => typeof id === 'string');
  const gone = new Set(removed), custom = [];
  for (const art of [...list(mine.custom), ...list(theirs.custom)])
    if (isArt(art) && !gone.has(art.id) && !custom.some(c => c.id === art.id)) custom.push(art);
  const arts = new Map([...builtIns, ...custom].map(a => [a.id, a]));
  const ours = mine.saves || {}, other = theirs.saves || {}, saves = {};
  for (const id of new Set([...Object.keys(ours), ...Object.keys(other)])) {
    if (gone.has(id)) continue;
    const [a, b] = [ours[id], other[id]].map(s => s && typeof s === 'object' ? s : null);
    if (!a || !b || keep.has(id)) { saves[id] = a || b; continue; }
    const gain = reached(arts.get(id), b) - reached(arts.get(id), a);
    saves[id] = gain > 0 || (gain === 0 && (b.savedAt || 0) > (a.savedAt || 0)) ? b : a;
  }
  return { saves, custom, removed };
}

export function storeSnapshot(snap) {
  write(CUSTOM, snap.custom);
  write(REMOVED, snap.removed);
  for (const [id, save] of Object.entries(snap.saves)) write(saveKey(id), save);
  for (const id of snap.removed) try { localStorage.removeItem(saveKey(id)); } catch {}
}

// Saves packed into text short enough for a link: compressed where the browser can.
const toText = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const fromText = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
export async function packSaves(snap) {
  const json = new TextEncoder().encode(JSON.stringify(snap));
  return typeof CompressionStream === 'function' ? 'z' + toText(await pipe(json, new CompressionStream('deflate-raw'))) : 'j' + toText(json);
}
export async function unpackSaves(text) {
  const bytes = fromText(text.slice(1));
  const snap = JSON.parse(new TextDecoder().decode(text[0] === 'z' ? await pipe(bytes, new DecompressionStream('deflate-raw')) : bytes));
  if (!snap || typeof snap !== 'object') throw new Error('Not a save');
  return snap;
}

// Fraction of jewels home, or null for a puzzle never opened.
export function progress(art) {
  const state = restore(art, read(saveKey(art.id), null));
  if (!state) return null;
  return correctCount(art, state) / art.pixels.filter(c => c >= 0).length;
}

const thumbnails = new Map();
export function thumbnail(art, scale = 4) {
  const key = `${art.id}@${scale}`;
  if (!thumbnails.has(key)) {
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    canvas.width = art.width * scale; canvas.height = art.height * scale;
    art.pixels.forEach((c, i) => {
      if (c < 0) return;
      ctx.fillStyle = art.colors[c];
      ctx.fillRect(i % art.width * scale, Math.floor(i / art.width) * scale, scale, scale);
    });
    thumbnails.set(key, canvas.toDataURL());
  }
  return thumbnails.get(key);
}
