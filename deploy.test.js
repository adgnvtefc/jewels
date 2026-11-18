// The site is deployed by copying a fixed list of files (.github/workflows/pages.yml). A
// module missing from that list breaks the live game while every other test passes, so
// this follows everything index.html loads, and every module those import, and checks
// that each one is copied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');

export function deployed(workflow) {
  const files = new Set(), folders = new Set();
  for (const [, args] of workflow.matchAll(/^\s*cp (.+)$/gm)) {
    const parts = args.trim().split(/\s+/).slice(0, -1);  // the last one is the destination
    if (parts[0] === '-r') parts.slice(1).forEach(p => folders.add(p.replace(/\/$/, '')));
    else parts.forEach(p => files.add(p));
  }
  return { files, folders };
}

export function needed(page) {
  const local = path => !/^[a-z]+:/i.test(path) && !path.startsWith('//') && !path.startsWith('#');
  const found = new Set(), queue = [...page.matchAll(/\s(?:src|href)="([^"]+)"/g)].map(m => m[1]).filter(local);
  while (queue.length) {
    const file = queue.shift().replace(/^\.\//, '').split(/[?#]/)[0];
    if (found.has(file)) continue;
    found.add(file);
    if (file.endsWith('.js')) for (const [, path] of read(file).matchAll(/^\s*import\b[^'"]*['"](\.\/[^'"]+)['"]/gm)) queue.push(path);
  }
  return [...found];
}

test('every file the page loads, and every module those import, is deployed', () => {
  const { files, folders } = deployed(read('.github/workflows/pages.yml'));
  const loads = needed(read('index.html'));
  for (const file of ['app.js', 'style.css', 'create.js', 'gauntlet.js', 'game.js']) assert.ok(loads.includes(file), `found ${file}`);
  const missing = loads.filter(file => !files.has(file) && !folders.has(file.split('/')[0]));
  assert.deepEqual(missing, [], 'add these to the cp line in .github/workflows/pages.yml');
  assert.ok(files.has('index.html'), 'and the page itself');
});

test('the check notices a module left off the list', () => {
  const { files } = deployed('  cp index.html style.css app.js dist/\n  cp -r assets dist/');
  assert.ok(needed(read('index.html')).some(file => !files.has(file) && !file.startsWith('assets/')));
});
