// Turns any picture into puzzle art: crop to a square, shrink to a small grid,
// reduce to a few colors, then clear specks that would become lone jewels.
// Works on raw RGBA bytes so it runs the same in the browser and in tests.

const linear = c => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

// OKLab distances track perceived color difference far better than RGB.
function oklab([r, g, b]) {
  r = linear(r); g = linear(g); b = linear(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const hex = rgb => '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

// Area-average a centered square crop down to size × size, compositing
// transparency over white.
export function downscale(rgba, width, height, size) {
  const side = Math.min(width, height), x0 = Math.floor((width - side) / 2), y0 = Math.floor((height - side) / 2);
  const cells = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx0 = x0 + Math.floor(x * side / size), sx1 = Math.max(sx0 + 1, x0 + Math.floor((x + 1) * side / size));
    const sy0 = y0 + Math.floor(y * side / size), sy1 = Math.max(sy0 + 1, y0 + Math.floor((y + 1) * side / size));
    const sum = [0, 0, 0];
    for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
      const p = (sy * width + sx) * 4, a = rgba[p + 3] / 255;
      for (let c = 0; c < 3; c++) sum[c] += rgba[p + c] * a + 255 * (1 - a);
    }
    const n = (sx1 - sx0) * (sy1 - sy0);
    cells.push(sum.map(v => v / n));
  }
  return cells;
}

// k-means in OKLab. Farthest-first seeding is deterministic and keeps small
// accent colors (eyes, highlights) that random seeding tends to lose.
function quantize(labs, k) {
  const mean = [0, 1, 2].map(c => labs.reduce((s, p) => s + p[c], 0) / labs.length);
  const centers = [];
  const nearest = labs.map(() => Infinity);
  let seed = mean;
  for (let n = 0; n < k; n++) {
    labs.forEach((p, i) => { nearest[i] = Math.min(nearest[i], distance(p, seed)); });
    const far = nearest.indexOf(Math.max(...nearest));
    if (nearest[far] < 1e-6) break;
    seed = labs[far];
    centers.push([...seed]);
  }
  let labels = labs.map(() => 0);
  for (let iteration = 0; iteration < 24; iteration++) {
    const next = labs.map(p => centers.reduce((best, c, j) => distance(p, c) < distance(p, centers[best]) ? j : best, 0));
    const changed = next.some((l, i) => l !== labels[i]);
    labels = next;
    centers.forEach((c, j) => {
      const members = labs.filter((_, i) => labels[i] === j);
      if (members.length) for (let d = 0; d < 3; d++) c[d] = members.reduce((s, p) => s + p[d], 0) / members.length;
    });
    if (!changed && iteration) break;
  }
  return { labels, centers };
}

// Fold colors that look alike into the more common one.
function mergeSimilar(labels, centers, threshold) {
  for (;;) {
    const counts = centers.map((_, j) => labels.filter(l => l === j).length);
    let pair = null, best = threshold;
    for (let a = 0; a < centers.length; a++) for (let b = a + 1; b < centers.length; b++) {
      if (!counts[a] || !counts[b]) continue;
      const d = distance(centers[a], centers[b]);
      if (d < best) { best = d; pair = counts[a] >= counts[b] ? [b, a] : [a, b]; }
    }
    if (!pair) return labels;
    labels = labels.map(l => l === pair[0] ? pair[1] : l);
  }
}

// A pixel with no same-colored neighbor (diagonals count, as in play) takes
// the most common neighboring color. With centers, a lone pixel that differs from that
// color by at least keepAbove stays: an eye or a seed, not a speck.
function despeckle(labels, size, centers = null, keepAbove = Infinity) {
  const next = [...labels];
  for (let i = 0; i < labels.length; i++) {
    const x = i % size, y = Math.floor(i / size), around = new Map();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if ((dx || dy) && nx >= 0 && nx < size && ny >= 0 && ny < size) {
        const l = labels[ny * size + nx];
        around.set(l, (around.get(l) || 0) + 1);
      }
    }
    if (!around.has(labels[i])) {
      const replacement = [...around].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
      if (!centers || distance(centers[labels[i]], centers[replacement]) < keepAbove) next[i] = replacement;
    }
  }
  return next;
}

// Anti-aliased edges: a pixel whose color lies between two different colors near it (grey
// between a black outline and white) is the soft edge of a line, not a color of its own.
// It joins the closer of the two. A pixel deep inside one color has nothing to blend between.
function removeBlends(labels, size, centers, eps, minSpan, radius = 2) {
  const next = [...labels];
  for (let i = 0; i < labels.length; i++) {
    const j = labels[i], x = i % size, y = Math.floor(i / size), near = new Set();
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < size && ny < size && labels[ny * size + nx] !== j) near.add(labels[ny * size + nx]);
    }
    if (near.size < 2) continue;
    const others = [...near];
    let best = null, bestExcess = Infinity;
    for (let a = 0; a < others.length; a++) for (let b = a + 1; b < others.length; b++) {
      const ca = centers[others[a]], cb = centers[others[b]], span = distance(ca, cb);
      if (span < minSpan) continue;
      const excess = (distance(ca, centers[j]) + distance(centers[j], cb) - span) / span;
      if (excess <= eps && excess < bestExcess) {
        bestExcess = excess; best = distance(ca, centers[j]) <= distance(cb, centers[j]) ? others[a] : others[b];
      }
    }
    if (best !== null) next[i] = best;
  }
  return next;
}

// Small separate blobs inside the subject that clearly differ from what surrounds them:
// eyes, seeds, spots, flakes. Blobs touching the background are silhouette, not features.
function findFeatures(labels, from, centers, bg, minArea, maxArea, minContrast) {
  const seen = new Uint8Array(labels.length), found = [];
  for (let start = 0; start < labels.length; start++) {
    if (seen[start] || labels[start] === bg) continue;
    const l = labels[start], cells = [start], around = new Map();
    seen[start] = 1;
    let touchesBg = false;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k], x = i % from, y = Math.floor(i / from);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= from || ny >= from) continue;
        const j = ny * from + nx, m = labels[j];
        if (m === l) { if (!seen[j]) { seen[j] = 1; cells.push(j); } }
        else { if (m === bg) touchesBg = true; around.set(m, (around.get(m) || 0) + 1); }
      }
    }
    if (touchesBg || cells.length < minArea || cells.length > maxArea || !around.size) continue;
    const surround = [...around].sort((a, b) => b[1] - a[1])[0][0];
    if (distance(centers[l], centers[surround]) < minContrast) continue;
    const xs = cells.map(i => i % from), ys = cells.map(i => Math.floor(i / from));
    found.push({ l, cx: xs.reduce((a, b) => a + b) / cells.length, cy: ys.reduce((a, b) => a + b) / cells.length,
                 x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
  }
  return found;
}

// A feature that lost every square it covers gets one jewel at its centre.
function stampFeatures(out, size, features, box) {
  const cellX = v => Math.floor((v - box.x0) * size / box.side), cellY = v => Math.floor((v - box.y0) * size / box.side);
  for (const f of features) {
    const ax = Math.max(0, cellX(f.x0)), bx = Math.min(size - 1, cellX(f.x1)), ay = Math.max(0, cellY(f.y0)), by = Math.min(size - 1, cellY(f.y1));
    let present = false;
    for (let y = ay; y <= by && !present; y++) for (let x = ax; x <= bx; x++) if (out[y * size + x] === f.l) { present = true; break; }
    const x = cellX(f.cx + 0.5), y = cellY(f.cy + 0.5);
    if (!present && x >= 0 && y >= 0 && x < size && y < size) out[y * size + x] = f.l;
  }
}

// When one color forms most of the subject's edge (an outline), its second layer goes back
// to the color inside: thick borders become one jewel wide. Lines inside the subject stay.
function thinOutline(out, size, bg) {
  const n4 = i => { const x = i % size, y = Math.floor(i / size); return [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [x + dx, y + dy]).filter(([a, b]) => a >= 0 && b >= 0 && a < size && b < size).map(([a, b]) => b * size + a); };
  const touchesBg = i => n4(i).some(j => out[j] === bg);
  const edge = new Map();
  out.forEach((l, i) => { if (l !== bg && touchesBg(i)) edge.set(l, (edge.get(l) || 0) + 1); });
  if (!edge.size) return out;
  const [line, count] = [...edge].sort((a, b) => b[1] - a[1])[0], total = [...edge.values()].reduce((a, b) => a + b, 0);
  if (count < total / 2) return out;
  const next = [...out];
  out.forEach((l, i) => {
    if (l !== line || touchesBg(i)) return;
    if (!n4(i).some(j => out[j] === line && touchesBg(j))) return;   // only the layer just inside the outer edge
    const inside = new Map(), x = i % size, y = Math.floor(i / size);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const m = out[ny * size + nx];
      if (m !== line && m !== bg) inside.set(m, (inside.get(m) || 0) + 1);
    }
    if (inside.size) next[i] = [...inside].sort((a, b) => b[1] - a[1])[0][0];
  });
  return next;
}

// The color filling most of the border is the background.
function background(labels, size) {
  const counts = new Map();
  labels.forEach((l, i) => {
    const x = i % size, y = Math.floor(i / size);
    if (x === 0 || y === 0 || x === size - 1 || y === size - 1) counts.set(l, (counts.get(l) || 0) + 1);
  });
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

// Shrink a label grid by majority vote, so edges keep real palette colors
// instead of averaging into halos. With fit, the square around the subject
// (plus a small margin) fills the grid. Ties go to the subject.
function cropBox(labels, from, fit) {
  const bg = background(labels, from);
  let x0 = 0, y0 = 0, side = from;
  if (fit) {
    let minX = from, minY = from, maxX = -1, maxY = -1;
    labels.forEach((l, i) => {
      if (l === bg) return;
      const x = i % from, y = Math.floor(i / from);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    });
    if (maxX >= 0) {
      side = Math.ceil(Math.max(maxX - minX + 1, maxY - minY + 1) * 17 / 16);
      x0 = Math.floor((minX + maxX + 1 - side) / 2); y0 = Math.floor((minY + maxY + 1 - side) / 2);
    }
  }
  return { bg, x0, y0, side };
}

function vote(labels, from, size, fit) {
  const { bg, x0, y0, side } = cropBox(labels, from, fit);
  const out = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const counts = new Map();
    const sx0 = x0 + Math.floor(x * side / size), sx1 = Math.max(sx0 + 1, x0 + Math.floor((x + 1) * side / size));
    const sy0 = y0 + Math.floor(y * side / size), sy1 = Math.max(sy0 + 1, y0 + Math.floor((y + 1) * side / size));
    for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
      const l = sx < 0 || sy < 0 || sx >= from || sy >= from ? bg : labels[sy * from + sx];
      counts.set(l, (counts.get(l) || 0) + (l === bg ? 1 : 1.01));
    }
    out.push([...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]);
  }
  return out;
}

// The lighter, feature-keeping conversion, as compared in the Create puzzle test.
export const LIGHTER = { unblend: true, clean: 'soft', thin: true, keepFeatures: true };

// Options for keeping small features (all off by default):
//   unblend: soft line edges join the colors on either side, so they don't become colors
//   thin: a thick outline around the subject becomes one jewel wide
//   keepFeatures: a small blob that clearly differs from its surroundings (an eye, a seed)
//     keeps at least one jewel
//   clean: 'soft' clears lone specks but keeps lone pixels that differ by keepAbove or more
export function convertImage(rgba, width, height, { size = 32, colors = 12, merge = 0.045, clean = true, fit = true, detail = 4, id = 'custom', title = 'Custom',
  unblend = false, blendEps = 0.08, blendSpan = 0.2, thin = false, keepFeatures = false, featureMin = 3, featureMax = 80, featureContrast = 0.2, keepAbove = 0.2 } = {}) {
  // Choose the palette at detail × the final size, then vote down to it.
  const from = size * detail, fine = downscale(rgba, width, height, from);
  let { labels, centers } = quantize(fine.map(oklab), colors);
  labels = mergeSimilar(labels, centers, merge);
  const groups = new Map();
  labels.forEach((l, i) => { if (!groups.has(l)) groups.set(l, []); groups.get(l).push(fine[i]); });
  // After the groups, so a color's shade is the average of its own pixels, not of the edges it absorbs.
  if (unblend) labels = removeBlends(labels, from, centers, blendEps, blendSpan);
  const fineLabels = labels;
  labels = detail === 1 && !fit ? labels : vote(labels, from, size, fit);
  if (thin) labels = thinOutline(labels, size, background(labels, size));
  if (keepFeatures) {
    const box = cropBox(fineLabels, from, fit);
    stampFeatures(labels, size, findFeatures(fineLabels, from, centers, box.bg, featureMin, featureMax, featureContrast), box);
  }
  if (clean === 'soft') labels = despeckle(labels, size, centers, keepAbove);
  else if (clean) labels = despeckle(labels, size);
  // Renumber by frequency and color each group with its members' average.
  const used = [...new Set(labels)].map(j => ({ j, n: labels.filter(l => l === j).length, members: groups.get(j) }))
    .sort((a, b) => b.n - a.n || a.j - b.j);
  const index = new Map(used.map((u, n) => [u.j, n]));
  const palette = used.map(u => hex([0, 1, 2].map(c => u.members.reduce((s, p) => s + p[c], 0) / u.members.length)));
  return { id, title, width: size, height: size, colors: palette, pixels: labels.map(l => index.get(l)) };
}
