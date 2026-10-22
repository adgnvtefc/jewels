export const SHELF_SIZE = 24;
export const SHELF_ROW = 8;
export const MAX_SHELF_SIZE = 1024;

// Eight-way adjacency matches jewel paths, including diagonals.
export function region(art, start, accepts) {
  if (!Number.isInteger(start) || start < 0 || start >= art.pixels.length || !accepts(start)) return [];
  const result = [], queue = [start], seen = new Set(queue);
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]; result.push(i);
    const x = i % art.width, y = Math.floor(i / art.width);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy, n = ny * art.width + nx;
      if (nx < 0 || nx >= art.width || ny < 0 || ny >= art.height || seen.has(n) || !accepts(n)) continue;
      seen.add(n); queue.push(n);
    }
  }
  return result;
}

export function createPuzzle(art, seed = 24713) {
  let randomState = seed >>> 0;
  const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 4294967296; };
  const board = [...art.pixels], unused = new Set(art.pixels.flatMap((c, i) => c >= 0 ? [i] : []));
  const swaps = [];
  // Swap intact patches, rather than scattering individual pixels. Each swap
  // has an inverse using the shelf, and the exact color inventory is preserved.
  while (unused.size) {
    const byColor = art.colors.map(() => []);
    for (const i of unused) byColor[art.pixels[i]].push(i);
    const colors = byColor.map((a, c) => ({ c, n: a.length })).filter(a => a.n).sort((a, b) => b.n - a.n);
    if (colors.length < 2) break;
    const aColor = colors[0].c, bColor = colors[1 + Math.floor(random() * (colors.length - 1))].c;
    const patch = c => { const cells = byColor[c], start = cells[Math.floor(random() * cells.length)]; return region(art, start, i => unused.has(i) && art.pixels[i] === c); };
    const a = patch(aColor), b = patch(bColor), length = Math.min(12, a.length, b.length);
    const left = a.slice(0, length), right = b.slice(0, length);
    left.forEach(i => { board[i] = bColor; unused.delete(i); });
    right.forEach(i => { board[i] = aColor; unused.delete(i); });
    swaps.push({ left, right });
  }
  return { board, shelf: Array(SHELF_SIZE).fill(-1), moves: 0, swaps };
}

export function select(art, state, kind, index) {
  const color = state[kind]?.[index];
  if (!Number.isInteger(color) || color < 0) return null;
  // Jewels at home are fixed, including those already matched at the start.
  if (kind === 'board' && art.pixels[index] === color) return null;
  const cells = kind === 'board'
    ? region(art, index, i => state.board[i] === color && art.pixels[i] !== color)
    : state.shelf.flatMap((c, i) => c === color ? [i] : []);
  return { kind, index, color, cells };
}

export function transfer(art, state, selection, destination, index = 0) {
  if (!selection || !['board', 'shelf'].includes(destination)) return { error: 'Select a jewel group first.' };
  // Recompute selection so stale UI selections cannot duplicate jewels.
  const source = select(art, state, selection.kind, selection.index);
  if (!source || source.color !== selection.color) return { error: 'Select that group again.' };
  if (source.kind === destination && destination === 'shelf') return { error: 'Choose matching empty spaces on the board.' };
  let targets;
  if (destination === 'shelf') {
    targets = state.shelf.flatMap((c, i) => c < 0 ? [i] : []);
    if (!targets.length) return { error: 'Shelf full. Place a stored group, or undo a move.' };
  } else {
    if (!Number.isInteger(index) || index < 0 || index >= art.pixels.length || state.board[index] !== -1) return { error: 'Choose an empty space.' };
    if (art.pixels[index] !== source.color) return { error: 'Match the jewel color to the empty space.' };
    targets = region(art, index, i => state.board[i] === -1 && art.pixels[i] === source.color);
  }
  const count = Math.min(source.cells.length, targets.length);
  const next = { board: [...state.board], shelf: [...state.shelf], moves: state.moves + 1 };
  const transfers = source.cells.slice(0, count).map((from, n) => {
    next[source.kind][from] = -1;
    next[destination][targets[n]] = source.color;
    return { from: { kind: source.kind, index: from }, to: { kind: destination, index: targets[n] }, color: source.color };
  });
  const incoming = new Set(transfers.filter(t => t.to.kind === 'shelf').map(t => t.to.index));
  const packed = compactShelf(next.shelf);
  const shelfShifts = packed.shifts.filter(t => !incoming.has(t.from.index));
  for (const t of transfers) if (t.to.kind === 'shelf') t.to.index = packed.positions.get(t.to.index);
  next.shelf = packed.shelf;
  return { state: next, transfers, shelfShifts };
}

export function correctCount(art, state) {
  return art.pixels.reduce((n, c, i) => n + (c >= 0 && state.board[i] === c ? 1 : 0), 0);
}

export function restore(art, saved) {
  if (!saved || !Array.isArray(saved.board) || !Array.isArray(saved.shelf) || saved.board.length !== art.pixels.length || saved.shelf.length < SHELF_SIZE || saved.shelf.length > MAX_SHELF_SIZE || saved.shelf.length % SHELF_ROW !== 0) return null;
  const inventory = art.colors.map(() => 0), expected = art.colors.map(() => 0);
  for (const c of art.pixels) if (c >= 0) expected[c]++;
  for (const c of [...saved.board, ...saved.shelf]) {
    if (!Number.isInteger(c) || c < -1 || c >= art.colors.length) return null;
    if (c >= 0) inventory[c]++;
  }
  if (inventory.some((n, i) => n !== expected[i]) || art.pixels.some((c, i) => c < 0 && saved.board[i] !== -1)) return null;
  return { board: [...saved.board], shelf: compactShelf(saved.shelf).shelf, moves: Number.isSafeInteger(saved.moves) && saved.moves >= 0 ? saved.moves : 0 };
}

export function findHint(art, state) {
  // Prefer a transfer that places jewels. Never make the move for the player.
  const candidates = [], seen = new Set();
  for (const kind of ['shelf', 'board']) {
    for (let i = 0; i < state[kind].length; i++) {
      if (state[kind][i] < 0 || seen.has(`${kind}:${i}`) || (kind === 'board' && state.board[i] === art.pixels[i])) continue;
      const selection = select(art, state, kind, i);
      selection.cells.forEach(n => seen.add(`${kind}:${n}`));
      const target = art.pixels.findIndex((c, n) => c === selection.color && state.board[n] === -1);
      if (target >= 0) candidates.push({ selection, destination: 'board', index: target });
    }
  }
  if (candidates.length) return candidates[0];
  if (state.shelf.includes(-1)) {
    const i = state.board.findIndex((c, n) => c >= 0 && c !== art.pixels[n]);
    if (i >= 0) return { selection: select(art, state, 'board', i), destination: 'shelf', index: state.shelf.indexOf(-1) };
  }
  return null;
}

// Occupied shelf slots always select their stored jewels, even when a board
// group was selected previously. Only empty slots are deposit targets.
export function shelfAction(state, selection, index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.shelf.length) return 'none';
  if (state.shelf[index] >= 0) return 'select';
  return selection?.kind === 'board' ? 'store' : 'none';
}

export function compactShelf(shelf) {
  const packed = Array(shelf.length).fill(-1), shifts = [], positions = new Map();
  let next = 0;
  shelf.forEach((color, index) => {
    if (color < 0) return;
    packed[next] = color; positions.set(index, next);
    if (index !== next) shifts.push({ from: { kind: 'shelf', index }, to: { kind: 'shelf', index: next }, color });
    next++;
  });
  return { shelf: packed, shifts, positions };
}

export function expandShelf(state) {
  return { ...state, shelf: [...state.shelf, ...Array(Math.min(SHELF_ROW, MAX_SHELF_SIZE - state.shelf.length)).fill(-1)] };
}

// Preserve the color, but refresh its source after moves and shelf compaction.
export function continueSelection(art, state, previous) {
  if (!previous) return null;
  const color = previous.color;
  if (previous.kind === 'board') {
    const remaining = previous.cells.find(i => state.board[i] === color && art.pixels[i] !== color);
    if (remaining !== undefined) return select(art, state, 'board', remaining);
  }
  const shelfIndex = state.shelf.indexOf(color);
  if (shelfIndex >= 0) return select(art, state, 'shelf', shelfIndex);
  const boardIndex = state.board.findIndex((c, i) => c === color && art.pixels[i] !== color);
  if (boardIndex >= 0) return select(art, state, 'board', boardIndex);
  return { kind: 'color', color, index: -1, cells: [] };
}
