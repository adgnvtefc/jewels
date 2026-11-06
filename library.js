// The puzzles you can choose: the built-in set listed in assets/puzzles.json, the bonus
// ones in assets/bonus.json, plus pictures you made or were sent, kept in this browser.
//
// Progress is kept per profile: a guest's under `little-jewel:…` (the keys used before
// accounts), a signed-in account's under `little-jewel:<name>:…`. For an account, every
// change is also noted for the next sync with the server (sync.js).
import { restore, correctCount } from './game.js';

const ROOT = 'little-jewel:';
let prefix = ROOT, profileName = null;
const keys = () => ({ save: `${prefix}sorting-v2:`, custom: `${prefix}custom-puzzles`, removed: `${prefix}removed-puzzles`, sync: `${prefix}sync` });
export const saveKey = id => keys().save + id;
export const profile = () => profileName;
export function useProfile(name) { profileName = name || null; prefix = name ? `${ROOT}${name}:` : ROOT; }
export function withProfile(name, work) {
  const before = profileName;
  useProfile(name);
  try { return work(); } finally { useProfile(before); }
}

const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };
const drop = key => { try { localStorage.removeItem(key); } catch {} };
const list = value => Array.isArray(value) ? value : [];
const without = (items, item) => list(items).filter(x => x !== item);
const storageKeys = () => { const found = []; try { for (let i = 0; i < localStorage.length; i++) found.push(localStorage.key(i)); } catch {} return found; };

export async function builtInPuzzles(file = 'puzzles.json') {
  const files = await (await fetch(`./assets/${file}`)).json();
  return Promise.all(files.map(async name => {
    const response = await fetch(`./assets/${name}`);
    if (!response.ok) throw new Error(`Missing ${name}`);
    return response.json();
  }));
}

// What still has to reach the server for the signed-in account: changed saves, puzzles
// made (or brought back) here, and removals; plus the server revisions last seen.
export function syncMeta() {
  const meta = read(keys().sync, {});
  return { since: Number.isInteger(meta.since) ? meta.since : 0, revs: meta.revs && typeof meta.revs === 'object' ? meta.revs : {},
    dirty: list(meta.dirty), uploads: list(meta.uploads), removals: list(meta.removals) };
}
export const setSyncMeta = meta => write(keys().sync, meta);
const note = (field, id, add = true) => {
  if (!profileName) return;
  const meta = syncMeta();
  meta[field] = add ? [...without(meta[field], id), id] : without(meta[field], id);
  setSyncMeta(meta);
};

export const readSave = id => read(saveKey(id), null);
// `changed` is false for copies that came from the server, which needn't go back.
export function writeSave(id, save, changed = true) {
  const ok = write(saveKey(id), save);
  if (ok && changed) note('dirty', id);
  return ok;
}

const isArt = a => a && typeof a.id === 'string' && Array.isArray(a.pixels) && Array.isArray(a.colors);
export const customPuzzles = () => list(read(keys().custom, [])).filter(isArt);
// A puzzle made here, or one brought back to Free play: added, and sent to the server.
export function addCustom(art) {
  const ok = write(keys().custom, [art, ...customPuzzles().filter(a => a.id !== art.id)]);
  if (ok) { write(keys().removed, without(read(keys().removed, []), art.id)); note('uploads', art.id); note('removals', art.id, false); }
  return ok;
}
// A puzzle the server says this account has (made, or sent by a friend): stored as it is.
export function storeCustom(art) {
  const mine = customPuzzles(), at = mine.findIndex(a => a.id === art.id);
  write(keys().custom, at < 0 ? [art, ...mine] : mine.map(a => a.id === art.id ? art : a));
  write(keys().removed, without(read(keys().removed, []), art.id));
}
// Removals are remembered, so a copy of the saves made elsewhere cannot bring a puzzle back.
export function removeCustom(id, { tell = true } = {}) {
  write(keys().custom, customPuzzles().filter(a => a.id !== id));
  write(keys().removed, [...new Set([...list(read(keys().removed, [])), id])]);
  drop(saveKey(id));
  if (profileName) {
    const meta = syncMeta();
    meta.dirty = without(meta.dirty, id); meta.uploads = without(meta.uploads, id); delete meta.revs[id];
    if (tell) meta.removals = [...without(meta.removals, id), id];
    setSyncMeta(meta);
  }
}

// Drop these puzzles' saves and puzzles from the current profile, telling no one (used
// once a guest's progress has moved into an account).
export function forget(ids) {
  const gone = new Set(ids);
  for (const id of gone) drop(saveKey(id));
  write(keys().custom, customPuzzles().filter(a => !gone.has(a.id)));
}

// Everything worth keeping, as one object: each puzzle's save, your puzzles, and removals.
export function snapshot() {
  const saves = {}, start = keys().save;
  for (const key of storageKeys()) {
    const save = key?.startsWith(start) && read(key, null);
    if (save && typeof save === 'object') saves[key.slice(start.length)] = save;
  }
  return { saves, custom: customPuzzles(), removed: list(read(keys().removed, [])) };
}

// Forget a profile in this browser: an account's whole copy, or the guest's progress.
export function clearProfile(name) {
  const start = name ? `${ROOT}${name}:` : null;
  const guest = [`${ROOT}sorting-v2:`, `${ROOT}custom-puzzles`, `${ROOT}removed-puzzles`];
  for (const key of storageKeys()) if (key && (start ? key.startsWith(start) : guest.some(g => key.startsWith(g)))) drop(key);
}

// Jewels home in a save, or -1 when it does not fit the puzzle (or the puzzle is unknown).
export const jewelsHome = (art, save) => { const state = art && restore(art, save); return state ? correctCount(art, state) : -1; };

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
    const gain = jewelsHome(arts.get(id), b) - jewelsHome(arts.get(id), a);
    saves[id] = gain > 0 || (gain === 0 && (b.savedAt || 0) > (a.savedAt || 0)) ? b : a;
  }
  return { saves, custom, removed };
}

export function storeSnapshot(snap) {
  write(keys().custom, snap.custom);
  write(keys().removed, snap.removed);
  for (const [id, save] of Object.entries(snap.saves)) write(saveKey(id), save);
  for (const id of snap.removed) drop(saveKey(id));
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
  const state = restore(art, readSave(art.id));
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
