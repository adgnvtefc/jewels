// The puzzles you can choose: the built-in set listed in assets/puzzles.json,
// plus pictures you created, kept in this browser.
import { restore, correctCount } from './game.js';

const CUSTOM = 'little-jewel:custom-puzzles';
const CURRENT = 'little-jewel:current-puzzle';
export const saveKey = id => `little-jewel:sorting-v2:${id}`;

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

export const customPuzzles = () => read(CUSTOM, []).filter(a => a && Array.isArray(a.pixels) && Array.isArray(a.colors));
export function addCustom(art) { return write(CUSTOM, [art, ...customPuzzles()]); }
export function removeCustom(id) {
  write(CUSTOM, customPuzzles().filter(a => a.id !== id));
  try { localStorage.removeItem(saveKey(id)); } catch {}
}
export const currentId = () => read(CURRENT, null);
export const rememberCurrent = id => write(CURRENT, id);

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
