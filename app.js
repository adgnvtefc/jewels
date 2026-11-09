import { createPuzzle, select, transfer, correctCount, restore, shelfAction, continueSelection, expandShelf, MAX_SHELF_SIZE, SHELF_SIZE } from './game.js';
import { builtInPuzzles, customPuzzles, addCustom, removeCustom, progress, thumbnail, readSave, writeSave, snapshot, mergeSaves, storeSnapshot, packSaves, unpackSaves, useProfile, withProfile, clearProfile, forget, jewelsHome, syncMeta } from './library.js';
import { currentAccount, online, friendName, displayName, takeOldPassword, whenSignedOut, signIn, signOut } from './account.js';
import { createMaker } from './create.js';
import { syncAccount, unsent } from './sync.js';
import { createChat } from './chat.js';
const $ = id => document.getElementById(id);
// Analytics (catseye, embedded in index.html); a no-op when the embed is absent, as in tests.
const track = (name, data) => globalThis.catseye?.(name, data);
// The site lives on https. Browsers keep http and https saves apart, so a visit to the
// http address hands its saves to the https one in the link (never sent to a server) and leaves.
const SITE = 'momoswebsiteofthehour.com';
if (location.protocol === 'http:' && location.hostname === SITE) {
  const saved = snapshot(), carry = Object.keys(saved.saves).length || saved.custom.length ? `#carry=${await packSaves(saved)}` : '';
  location.replace(`https://${SITE}${location.pathname}${location.search}${carry}`);
  await new Promise(() => {});
}
let builtIns;
try { builtIns = await builtInPuzzles(); }
catch { $('instruction').textContent = 'The artwork could not load. Please refresh.'; throw new Error('Artwork unavailable'); }
// Bonus puzzles live in Free play, apart from the numbered levels; the game works without them.
let bonus = [];
try { bonus = await builtInPuzzles('bonus.json'); } catch {}
const shipped = () => [...builtIns, ...bonus];
// Saves carried over from the http address are a guest's; signing in offers to add them.
if ((location.hash || '').startsWith('#carry=')) {
  try { const carried = await unpackSaves(location.hash.slice(7)); withProfile(null, () => storeSnapshot(mergeSaves(snapshot(), carried, shipped()))); } catch {}
  history.replaceState(null, '', location.pathname + location.search);
}
// Before accounts, everyone with the password shared one copy of the saves, now Anushka's.
// A browser that had the password remembers which of its saves were that copy, so they
// are offered to Anushka at sign-in but not to anyone else.
const SHARED = 'little-jewel:shared-v91', SHARED_OWNER = 'anushka';
if (takeOldPassword()) {
  const old = withProfile(null, snapshot);
  try { localStorage.setItem(SHARED, JSON.stringify({ saves: Object.fromEntries(Object.entries(old.saves).map(([id, s]) => [id, s.savedAt ?? null])), custom: old.custom.map(a => a.id) })); } catch {}
}
useProfile(currentAccount()?.name);
const library = () => [...shipped(), ...customPuzzles()];
let art, state, selection, total = 0, level = null, returnTo = null;
let busy = false, zoom = 1, ox = 0, oy = 0, size = 0;
let cursor = 0, keyboard = false;
const pointers = new Map();
let gesture = null, startPoint = null, moved = false;
const canvas = $('board'), ctx = canvas.getContext('2d');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const shelfButtons = [];
let arrivals = new Set();

function message(text) { $('instruction').textContent = text; }
function save() {
  try { writeSave(art.id, { board: state.board, shelf: state.shelf, moves: state.moves, selectedColor: selection?.color ?? null, savedAt: Date.now() }); }
  catch { message('Saving unavailable in this browser'); }
  syncSoon();
}

// Signed in, progress and puzzles also live on the server, so every browser, address and
// Home Screen copy shows the same. This browser's copy stays the fallback offline.
// A guest's progress stays in this browser only.
let syncing = null, syncTimer = null;
function syncSoon(ms = 4000) { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, ms); }
function syncNow() {
  if (!online()) return Promise.resolve(false);
  return syncing ??= (async () => {
    try {
      const replaced = await syncAccount();
      // Another device got further on the puzzle on screen: pick up from there.
      if (!$('game').hidden && replaced.includes(art.id) && !busy) {
        openPuzzle(art, level, returnTo);
        message('Picked up from your other device.');
      }
      if (!$('home').hidden && !$('modal').open) goHome();
      chat.refresh();
      return true;
    } catch { return false; } finally { syncing = null; }
  })();
}
document.addEventListener?.('visibilitychange', () => { if (document.visibilityState === 'hidden') syncNow(); else syncSoon(0); });
function syncShelfButtons() {
  while(shelfButtons.length > state.shelf.length) shelfButtons.pop().remove();
  while(shelfButtons.length < state.shelf.length) {
    const i=shelfButtons.length, button=document.createElement('button');
    button.className='shelf-slot'; button.onclick=()=>tapShelf(i);
    $('shelf').append(button); shelfButtons.push(button);
  }
}
$('shelf').onclick = e => {
  if (e.target === $('shelf') && selection?.kind === 'board') move('shelf', 0);
};
function update() {
  syncShelfButtons();
  const free = state.shelf.filter(c => c < 0).length;
  $('shelf').classList.toggle('ready', selection?.kind === 'board' && free > 0);
  shelfButtons.forEach((b, i) => {
    const c = state.shelf[i];
    b.classList.toggle('occupied', c >= 0);
    b.classList.toggle('selected', selection?.kind === 'shelf' && selection.color === c);
    b.style.setProperty('--color', c >= 0 ? art.colors[c] : 'transparent');
    b.innerHTML = c >= 0 && !arrivals.has(`shelf:${i}`) ? '<span class="shelf-jewel"></span>' : '<span class="socket"></span>';
    b.setAttribute('aria-label', c >= 0 ? `Shelf slot ${i + 1}, jewel ${art.colors[c]}. Select this color group.` : `Shelf slot ${i + 1}, empty. Store selected jewels.`);
    b.setAttribute('aria-pressed', String(selection?.kind === 'shelf' && selection.color === c));
  });
  $('addShelf').disabled = busy || state.shelf.length >= MAX_SHELF_SIZE;
  const percent = Math.floor(correctCount(art, state) / total * 100);
  $('progressFill').style.width = `${percent}%`;
  $('progressText').textContent = `${percent}%`;
  $('progress').setAttribute('aria-valuenow', String(percent));
  $('moveCount').textContent = `${state.moves} ${state.moves === 1 ? 'move' : 'moves'}`;
  save(); draw();
}
// Visual states follow the reference: recessed socket, raised loose jewel,
// lifted selection, and a low-relief jewel seated in its matching tile.
function octagon(x, y, width) {
  const cut=width*.24;
  ctx.beginPath();ctx.moveTo(x+cut,y);ctx.lineTo(x+width-cut,y);
  ctx.lineTo(x+width,y+cut);ctx.lineTo(x+width,y+width-cut);
  ctx.lineTo(x+width-cut,y+width);ctx.lineTo(x+cut,y+width);
  ctx.lineTo(x,y+width-cut);ctx.lineTo(x,y+cut);ctx.closePath();
}
function facet(points, fill) {
  ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();ctx.fillStyle=fill;ctx.fill();
}
function jewel(x,y,cell,color,picked=false,seated=false) {
  const w=cell*(seated?.72:.66), x0=x+(cell-w)/2;
  const y0=y+(cell-w)/2-(picked?cell*.13:seated?0:cell*.035);
  const depth=cell*(picked?.13:seated?.015:.07), bevel=w*(seated?.13:.20);
  if(!seated){
    ctx.save();ctx.shadowColor='#142a294a';ctx.shadowBlur=cell*(picked?.13:.05);ctx.shadowOffsetY=cell*(picked?.13:.055);
    octagon(x0,y0+depth,w);ctx.fillStyle=color;ctx.fill();ctx.restore();
    octagon(x0,y0+depth,w);ctx.fillStyle='#00000045';ctx.fill();
  }
  octagon(x0,y0,w);ctx.fillStyle=color;ctx.fill();ctx.save();ctx.clip();
  facet([[x0,y0],[x0+w,y0],[x0+w-bevel,y0+bevel],[x0+bevel,y0+bevel]],seated?'#ffffff24':'#ffffff70');
  facet([[x0,y0],[x0+bevel,y0+bevel],[x0+bevel,y0+w-bevel],[x0,y0+w]],seated?'#ffffff0c':'#ffffff22');
  facet([[x0,y0+w],[x0+bevel,y0+w-bevel],[x0+w-bevel,y0+w-bevel],[x0+w,y0+w]],seated?'#00000016':'#00000033');
  facet([[x0+w,y0],[x0+w,y0+w],[x0+w-bevel,y0+w-bevel],[x0+w-bevel,y0+bevel]],seated?'#0000000c':'#00000018');
  ctx.restore();
  octagon(x0,y0,w);ctx.strokeStyle=seated?'#ffffff28':picked?'#ffffffc0':'#142a2938';ctx.lineWidth=Math.max(.5,cell*.025);ctx.stroke();
}
function socket(x,y,cell,color,highlight=false) {
  const w=cell*.72,x0=x+(cell-w)/2,y0=y+(cell-w)/2;
  octagon(x0,y0,w);ctx.fillStyle=color;ctx.fill();ctx.save();ctx.clip();
  // Dark upper lip and pale lower lip make the empty space read as a well.
  const shade=ctx.createLinearGradient(0,y0,0,y0+w);
  shade.addColorStop(0,'#00000038');shade.addColorStop(.22,'#00000010');shade.addColorStop(.76,'#00000008');shade.addColorStop(1,'#ffffff35');
  ctx.fillStyle=shade;ctx.fillRect(x0,y0,w,w);ctx.restore();
  octagon(x0,y0,w);ctx.strokeStyle=highlight?'#ffffffd9':'#00000012';ctx.lineWidth=highlight?Math.max(1,cell*.065):Math.max(.5,cell*.02);ctx.stroke();
}
// Glitter: three tiny white stars pop around a jewel, one after another, when it lands
// in its right spot on the picture. Not for the shelf, and not with reduced motion.
const SPARKLE_MS = 450;
let sparkles = [], sparkling = false;
function sparkle(i) {
  if (reducedMotion || !art || state.board[i] !== art.pixels[i]) return;
  sparkles.push({ i, t0: Date.now(), seed: Math.random() * Math.PI * 2 });
  if (!sparkling) { sparkling = true; nextFrame(sparkleTick); }
}
// Sparkles live on their own transparent canvas over the board, so a sparkle frame
// repaints a few tiny stars instead of all 1,024 jewels.
const sparkleCanvas = $('sparkleLayer'), sctx = sparkleCanvas.getContext('2d');
function sparkleTick() {
  const now = Date.now();
  sparkles = sparkles.filter(s => now - s.t0 < SPARKLE_MS);
  drawSparkles();
  if (sparkles.length) nextFrame(sparkleTick); else sparkling = false;
}
function sparkleStar(cx, cy, r) {
  sctx.beginPath();
  for (let k = 0; k < 8; k++) { const rr = k % 2 ? r * .28 : r, an = k * Math.PI / 4; sctx.lineTo(cx + Math.sin(an) * rr, cy - Math.cos(an) * rr); }
  sctx.closePath(); sctx.fill();
}
function drawSparkles() {
  const dpr = window.devicePixelRatio || 1, cell = size / (art?.width || 1) * zoom;
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0); sctx.clearRect(0, 0, size, size);
  if (!sparkles.length || !art) return;
  sctx.translate(ox, oy);
  const now = Date.now();
  sctx.fillStyle = '#fff';
  for (const s of sparkles) {
    const p = (now - s.t0) / SPARKLE_MS, cx = (s.i % art.width + .5) * cell, cy = (Math.floor(s.i / art.width) + .5) * cell;
    for (let k = 0; k < 3; k++) {
      const q = (p - k * .2) / .6, an = s.seed + k * 2.1;
      if (q > 0 && q < 1) sparkleStar(cx + Math.cos(an) * cell * .55, cy + Math.sin(an) * cell * .55, cell * .3 * Math.sin(Math.PI * q));
    }
  }
}
function outlineCell(x,y,cell) {
  // A restrained focus ring is reserved for keyboard navigation.
  ctx.strokeStyle='#fff';ctx.lineWidth=Math.max(1,cell*.045);ctx.setLineDash([cell*.12,cell*.08]);
  octagon(x+cell*.08,y+cell*.08,cell*.84);ctx.stroke();ctx.setLineDash([]);
}
function draw() {
  if(!size||!art)return;
  const dpr=window.devicePixelRatio||1,cell=size/art.width*zoom;
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,size,size);
  ctx.save();ctx.translate(ox,oy);
  const picked=new Set(selection?.kind==='board'?selection.cells:[]),loose=[];
  art.pixels.forEach((color,i)=>{
    if(color<0)return;
    const x=i%art.width*cell,y=Math.floor(i/art.width)*cell;
    if(x+ox>size||y+oy>size||x+ox+cell<0||y+oy+cell<0)return;
    const target=art.colors[color],foreground=arrivals.has(`board:${i}`)?-1:state.board[i];
    // Leave a continuous, fully saturated target-color surround on every tile.
    ctx.fillStyle=target;ctx.fillRect(x+.3,y+.3,cell-.6,cell-.6);
    if(foreground===color)jewel(x,y,cell,target,false,true);
    else {
      socket(x,y,cell,target,foreground<0&&selection?.color===color);
      if(foreground>=0)loose.push({x,y,i,color:art.colors[foreground]});
    }
  });
  // Raised jewels draw above sockets, including neighbors when lifted.
  loose.filter(g=>!picked.has(g.i)).forEach(g=>jewel(g.x,g.y,cell,g.color));
  loose.filter(g=>picked.has(g.i)).forEach(g=>jewel(g.x,g.y,cell,g.color,true));
  const focus=keyboard?cursor:-1;
  if(focus>=0)outlineCell(focus%art.width*cell,Math.floor(focus/art.width)*cell,cell);
  ctx.restore();
}
function constrain() { ox = Math.min(0, Math.max(size - size * zoom, ox)); oy = Math.min(0, Math.max(size - size * zoom, oy)); }
function resize() {
  const old = size; size = $('viewport').clientWidth;
  const dpr = window.devicePixelRatio || 1; canvas.width = sparkleCanvas.width = Math.round(size * dpr); canvas.height = sparkleCanvas.height = Math.round(size * dpr);
  if (old) { ox *= size / old; oy *= size / old; }
  constrain(); draw();
}
new ResizeObserver(resize).observe($('viewport'));
function zoomTo(value, x = size / 2, y = size / 2) {
  const next = Math.max(1, Math.min(5, value)); ox = x - (x - ox) * next / zoom; oy = y - (y - oy) * next / zoom;
  zoom = next; constrain(); draw();
}
function selectGroup(kind, i) {
  const next = select(art, state, kind, i);
  if (!next) return;
  if (selection?.kind === kind && selection.cells.includes(i)) {
    selection = null; message('Tap a jewel group, then choose where it goes.');
  } else {
    selection = next;
    message(kind === 'shelf' ? 'Tap matching empty spaces on the board.' : 'Tap the shelf, or matching empty spaces.');
  }
  update();
  if (selection?.kind === 'shelf') {
    const target=art.pixels.findIndex((c,n)=>c===selection.color&&state.board[n]===-1);
    if(target<0) message('No empty spaces for this color yet. Free a matching space first.');
    else message('Shelf jewels selected. Tap a matching empty socket.');
  }
}
function tapBoard(i) {
  if (busy || i < 0 || art.pixels[i] < 0) return;
  if (state.board[i] >= 0 && state.board[i] === art.pixels[i]) {
    message('This jewel is already home and cannot be moved.');
    return;
  }
  if (state.board[i] >= 0) selectGroup('board', i);
  else if (selection) move('board', i);
  else message('Select a jewel group before choosing an empty space.');
}
function tapShelf(i) {
  if (busy) return;
  const action = shelfAction(state, selection, i);
  if (action === 'select') selectGroup('shelf', i);
  else if (action === 'store') move('shelf', i);
  else message('Select jewels on the board, then tap here to store them.');
}
// The shelf scrolls. Before jewels fly onto it, it scrolls (in SHELF_SCROLL_MS, while the
// jewels wait to take off) to show the first slot they fill, and flights aim where slots
// will be once it has (shelfScroll). A slot still out of view is reached at the shelf's
// edge, where the jewel fades in or out, never in midair.
const SHELF_SCROLL_MS = 220;
let shelfScroll = 0, shelfWait = 0;
function scrollShelf(shelf, to) {
  const from = shelf.scrollTop, start = Date.now();
  const step = () => {
    const p = Math.min(1, (Date.now() - start) / SHELF_SCROLL_MS);
    shelf.scrollTop = from + (to - from) * (1 - (1 - p) ** 3);
    if (p < 1) nextFrame(step);
  };
  step();
}
function revealShelf(transfers) {
  shelfScroll = 0; shelfWait = 0;
  const slots = transfers.filter(t => t.to.kind === 'shelf').map(t => t.to.index);
  if (!slots.length) return;
  const shelf = $('shelf'), view = shelf.getBoundingClientRect();
  const first = shelfButtons[Math.min(...slots)].getBoundingClientRect(), last = shelfButtons[Math.max(...slots)].getBoundingClientRect();
  let top = shelf.scrollTop;
  if (first.top < view.top + 4) top += first.top - view.top - 8;
  else if (last.bottom > view.bottom - 4) top += Math.min(last.bottom - view.bottom + 8, first.top - view.top - 8);
  top = Math.max(0, Math.min(top, shelf.scrollHeight - shelf.clientHeight));
  if (Math.abs(top - shelf.scrollTop) < 1) return;
  shelfScroll = shelf.scrollTop - top; shelfWait = SHELF_SCROLL_MS;
  scrollShelf(shelf, top);
}
function screenPoint(location) {
  if (location.kind === 'shelf') {
    const slot = shelfButtons[location.index], view = $('shelf').getBoundingClientRect();
    const r = (slot.firstElementChild || slot).getBoundingClientRect(), y = r.y + r.height / 2 + shelfScroll;
    const low = view.top + r.height / 2, high = view.bottom - r.height / 2;
    return { x: r.x + r.width / 2, y: Math.min(Math.max(y, low), high), size: r.width, hidden: y < low - 1 || y > high + 1 };
  }
  const r = canvas.getBoundingClientRect(), cell = size / art.width * zoom;
  return { x: r.x + ox + (location.index % art.width + .5) * cell, y: r.y + oy + (Math.floor(location.index / art.width) + .5) * cell, size: cell * .72 };
}
// Each jewel reappears in its new place in the same frame its flying copy is removed,
// as soon as that copy lands, so nothing blinks out between flight and arrival.
const nextFrame = globalThis.requestAnimationFrame?.bind(globalThis) ?? (f => setTimeout(f, 16));
let landing = [];
function land(key, el) {
  return new Promise(resolve => {
    if (!landing.length) nextFrame(() => {
      const batch = landing; landing = [];
      let board = false;
      for (const [key] of batch) {
        arrivals.delete(key);
        if (key.startsWith('board:')) { board = true; sparkle(Number(key.slice(6))); continue; }
        const i = Number(key.slice(6));
        if (state.shelf[i] >= 0 && shelfButtons[i]) shelfButtons[i].innerHTML = '<span class="shelf-jewel"></span>';
      }
      if (board) draw();
      for (const [, el, done] of batch) { el.remove(); done(); }
    });
    landing.push([key, el, resolve]);
  });
}
async function animate(transfers) {
  await Promise.all(transfers.map(async (t, n) => {
    const a = screenPoint(t.from), b = screenPoint(t.to), el = document.createElement('span');
    el.className = 'flying-jewel'; el.style.cssText = `left:${a.x}px;top:${a.y}px;width:${a.size}px;height:${a.size}px;background:${art.colors[t.color]}`;
    document.body.append(el);
    try {
      // fill: both keeps a jewel waiting its turn centred where it started, and a landed one in place until it is swapped.
      await el.animate([
        { transform: 'translate(-50%,-50%) scale(1)', opacity: a.hidden ? 0 : 1 },
        { transform: `translate(calc(-50% + ${(b.x-a.x)*.5}px),calc(-50% + ${(b.y-a.y)*.5-(t.from.kind==='shelf'&&t.to.kind==='shelf'?0:35)}px)) scale(1.2)`, opacity: 1, offset: .5 },
        { transform: `translate(calc(-50% + ${b.x-a.x}px),calc(-50% + ${b.y-a.y}px)) scale(${b.size/a.size})`, opacity: b.hidden ? 0 : 1 }
      ], { duration: 330, delay: shelfWait + Math.min(n * 13, 200), easing: 'ease-in-out', fill: 'both' }).finished;
      await land(`${t.to.kind}:${t.to.index}`, el);
    } catch { el.remove(); }
  }));
}
async function move(kind, index) {
  if (selection?.kind === 'color') { message('This color is complete. Choose another color.'); return; }
  const result = transfer(art, state, selection, kind, index);
  if (result.error) { message(result.error); return; }
  // Up to 64 jewels fly; any others simply appear in place.
  busy = true; const motion=reducedMotion?[]:[...result.transfers,...result.shelfShifts].slice(0,64);
  arrivals = new Set(motion.map(t=>`${t.to.kind}:${t.to.index}`));
  state = result.state; selection = continueSelection(art,state,selection); save(); update();
  message(`${result.transfers.length} ${result.transfers.length === 1 ? 'jewel' : 'jewels'} ${kind === 'shelf' ? 'on the shelf. Now make room for their color.' : 'back where they belong.'}`);
  revealShelf(motion);
  try { await animate(motion); } finally {
    shelfScroll = 0; shelfWait = 0;
    arrivals.clear(); busy = false; update();
    // Jewels past the first 64 don't fly; they sparkle as they appear.
    const flown = new Set(motion.map(t => `${t.to.kind}:${t.to.index}`));
    for (const t of result.transfers) if (t.to.kind === 'board' && !flown.has(`board:${t.to.index}`)) sparkle(t.to.index);
  }
  if (correctCount(art, state) === total) {
    track('level_complete', { puzzle: art.id, title: art.title, custom: !builtIns.some(a => a.id === art.id), moves: state.moves, colors: art.colors.length, jewels: total });
    syncSoon(0);
    const heading = art.id === 'love-garden-v1' ? 'Made with love.' : esc(art.title);
    const eyebrow = level === null ? 'EVERY JEWEL, BACK HOME' : `LEVEL ${level + 1} COMPLETE`;
    // However the dialog closes, a finished puzzle returns to the start screen.
    show(`<p class="eyebrow">${eyebrow}</p><h2>${heading}</h2><p>You restored the picture in ${state.moves} moves.</p><img src="${thumbnail(art, 8)}" alt="Your completed artwork"><button class="primary" id="keep">${returnTo === 'chat' ? 'Back to chat' : 'Back to start'}</button>`, leaveGame);
    $('keep').onclick = () => $('modal').close();
  }
}
function point(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function cellAt(p) {
  const c = size / art.width * zoom, x = Math.floor((p.x - ox) / c), y = Math.floor((p.y - oy) / c);
  return x >= 0 && y >= 0 && x < art.width && y < art.height ? y * art.width + x : -1;
}
canvas.onpointerdown = e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  keyboard = false; canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, point(e));
  if (pointers.size === 1) { startPoint = { ...point(e), ox, oy }; moved = false; }
  if (pointers.size === 2) {
    moved = true; const [a, b] = [...pointers.values()];
    gesture = { distance: Math.hypot(a.x-b.x, a.y-b.y), zoom, ox, oy, mid: { x: (a.x+b.x)/2, y: (a.y+b.y)/2 } };
  }
};
canvas.onpointermove = e => {
  if (!pointers.has(e.pointerId)) return;
  const p = point(e); pointers.set(e.pointerId, p);
  if (pointers.size >= 2 && gesture) {
    const [a,b] = [...pointers.values()], mid = { x:(a.x+b.x)/2, y:(a.y+b.y)/2 };
    zoom = Math.max(1, Math.min(5, gesture.zoom * Math.hypot(a.x-b.x,a.y-b.y) / Math.max(1,gesture.distance)));
    ox = mid.x - (gesture.mid.x-gesture.ox)*zoom/gesture.zoom; oy = mid.y-(gesture.mid.y-gesture.oy)*zoom/gesture.zoom;
    constrain(); draw();
  } else if (!gesture && startPoint && Math.hypot(p.x-startPoint.x,p.y-startPoint.y)>6) {
    moved = true; ox = startPoint.ox + p.x-startPoint.x; oy = startPoint.oy+p.y-startPoint.y; constrain(); draw();
  }
};
function release(e) {
  if (!pointers.has(e.pointerId)) return;
  if (!moved && !gesture && e.type !== 'pointercancel') tapBoard(cellAt(point(e)));
  pointers.delete(e.pointerId);
  if (!pointers.size) { gesture = null; startPoint = null; }
}
canvas.onpointerup = release; canvas.onpointercancel = release;
canvas.addEventListener('wheel', e => { e.preventDefault(); const p=point(e); zoomTo(zoom*(e.deltaY<0?1.15:.87),p.x,p.y); }, { passive:false });
canvas.onkeydown = e => {
  const directions = { ArrowLeft:-1, ArrowRight:1, ArrowUp:-art.width, ArrowDown:art.width };
  if (e.key in directions) {
    e.preventDefault(); keyboard = true; cursor = Math.max(0,Math.min(art.pixels.length-1,cursor+directions[e.key]));
    const cell=size/art.width*zoom; ox=size/2-(cursor%art.width+.5)*cell; oy=size/2-(Math.floor(cursor/art.width)+.5)*cell; constrain(); draw();
  }
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); tapBoard(cursor); }
  if (e.key === 'Escape') { selection=null; update(); }
};
let afterClose = null;
function show(content, then = null) { afterClose=then; $('modalContent').innerHTML=content; if (!$('modal').open) $('modal').showModal(); }
// The close event comes a moment after close(); if the dialog has reopened by then with
// new content, that event is stale and the new content's handler waits for its own close.
$('modal').onclose = () => { if ($('modal').open) return; const next=afterClose; afterClose=null; next?.(); };
$('close').onclick = () => $('modal').close();
$('modal').onclick = e => { if(e.target===$('modal')){const r=$('modal').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('modal').close();} };
$('addShelf').onclick=()=>{
  if(busy||state.shelf.length>=MAX_SHELF_SIZE)return;
  state=expandShelf(state);
  save();update();message('Eight more spaces. Make yourself comfortable.');
};
const esc = text => String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

// Three screens: the start screen (home), the board (game) and the chat. Reloading always starts at home.
function showScreen(name) { for (const id of ['home', 'game', 'chat']) $(id).hidden = id !== name; }
function goHome() {
  showScreen('home'); returnTo = null; chat.close();
  const next = nextLevel();
  $('levels').innerHTML = builtIns.map((puzzle, n) => {
    const done = progress(puzzle) === 1;
    const label = `Level ${n + 1}${done ? ', complete' : n === next ? ', next' : ''}`;
    return `<li class="level-pip${done ? ' done' : n === next ? ' current' : ''}" aria-label="${label}">${done ? `<img alt="" src="${thumbnail(puzzle)}">` : ''}</li>`;
  }).join('');
  $('startGame').disabled = next < 0;
  $('startLevel').textContent = next < 0 ? 'All levels complete' : `Level ${next + 1} of ${builtIns.length}`;
  $('bonusTip').hidden = bonus.every(puzzle => bonusSeen().includes(puzzle.id));
  renderAccount();
}
// The corner button says who is signed in; the Chat button shows unread messages.
function renderAccount() {
  const account = currentAccount();
  $('accountButton').textContent = !account ? 'Sign in' : account.token ? displayName(account.name) : 'Sign in again';
  $('accountButton').classList.toggle('needs-sign-in', Boolean(account && !account.token));
  $('chatButton').hidden = !online() || !friendName();
  $('chatLabel').textContent = `Chat with ${displayName(friendName())}`;
  showUnread(chat.unread());
}
function showUnread(count) {
  $('unreadBadge').hidden = !count;
  $('unreadBadge').textContent = count > 99 ? '99+' : String(count);
  document.title = count ? `(${count}) Pixel Game` : 'Pixel Game';
}
// A puzzle opened from the chat returns to the chat.
function leaveGame() { if (returnTo === 'chat' && online()) openChat(); else goHome(); }
// A pop-up under Free play points at the bonus puzzles until Free play has been opened
// with them in it, and again whenever new ones arrive. Remembered in this browser only.
const BONUS_SEEN = 'little-jewel:bonus-seen';
function bonusSeen() { try { return JSON.parse(localStorage.getItem(BONUS_SEEN)) || []; } catch { return []; } }
function seeBonus() {
  try { localStorage.setItem(BONUS_SEEN, JSON.stringify([...new Set([...bonusSeen(), ...bonus.map(puzzle => puzzle.id)])])); } catch {}
  $('bonusTip').hidden = true;
}
// Levels are the built-in puzzles, in order; the next one is the first not yet finished.
const nextLevel = () => builtIns.findIndex(puzzle => progress(puzzle) !== 1);
$('startGame').onclick = () => { const next = nextLevel(); if (next >= 0) openPuzzle(builtIns[next], next); };
$('menu').onclick = () => { if (!busy) leaveGame(); };

function openPuzzle(next, levelIndex = null, from = null) {
  art = next; level = levelIndex; returnTo = from; total = art.pixels.filter(c => c >= 0).length; sparkles = []; drawSparkles();
  showScreen('game');
  const saved = readSave(art.id);
  state = restore(art, saved) || createPuzzle(art);
  selection = Number.isInteger(saved?.selectedColor) && saved.selectedColor >= 0 && saved.selectedColor < art.colors.length
    ? continueSelection(art,state,{kind:'color',color:saved.selectedColor,cells:[]}) : null;
  cursor = 0; keyboard = false; zoom = 1; ox = oy = 0;
  constrain(); update();
  $('puzzleName').textContent = `${level === null ? '' : `Level ${level + 1} · `}${art.title}`;
  message(`${level === null ? '' : `Level ${level + 1}: `}${art.title}. Tap a jewel group, then the shelf.`);
}

// Free play: the bonus puzzles, puzzles sent to you, pictures you created, and the way to make more.
function puzzleCard(puzzle, onPick = () => { $('modal').close(); openPuzzle(puzzle); }) {
  const done = progress(puzzle), card = document.createElement('div');
  const from = puzzle.from ? `from ${esc(displayName(puzzle.from))} · ` : '';
  card.className = 'puzzle-card';
  card.innerHTML = `<button class="puzzle-pick"><img alt="" src="${thumbnail(puzzle)}"><span class="puzzle-title">${esc(puzzle.title)}</span><span class="puzzle-progress">${from}${done === null ? 'New' : done === 1 ? 'Complete' : `${Math.floor(done * 100)}%`}</span></button>`;
  card.querySelector('.puzzle-pick').onclick = onPick;
  return card;
}
function removable(puzzle) {
  const card = puzzleCard(puzzle);
  const remove = document.createElement('button');
  remove.className = 'puzzle-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${puzzle.title}`);
  remove.onclick = () => {
    if (!confirm(puzzle.from ? `Remove “${puzzle.title}” and your progress on it? It stays in your chat.` : `Remove “${puzzle.title}” and its progress?`)) return;
    removeCustom(puzzle.id); syncSoon(0); freePlay();
  };
  card.append(remove);
  return card;
}
function freePlay() {
  const all = customPuzzles(), sent = all.filter(a => a.from), mine = all.filter(a => !a.from);
  show(`<p class="eyebrow">FREE PLAY</p>${bonus.length ? '<h2>Bonus</h2><div class="puzzle-list" id="bonusList"></div>' : ''}${sent.length ? '<h2>Sent to you</h2><div class="puzzle-list" id="sentList"></div>' : ''}<h2>Your puzzles</h2>${mine.length ? '<div class="puzzle-list" id="puzzleList"></div>' : '<p>Nothing here yet. Describe a picture and it becomes a puzzle.</p>'}<button class="primary" id="createOwn">✦ Create your own</button>`);
  if (bonus.length) seeBonus();
  for (const puzzle of bonus) $('bonusList').append(puzzleCard(puzzle));
  for (const puzzle of sent) $('sentList').append(removable(puzzle));
  for (const puzzle of mine) $('puzzleList').append(removable(puzzle));
  $('createOwn').onclick = maker.start;
}
$('freePlay').onclick = freePlay;
$('createHome').onclick = () => maker.start();
$('bonusTip').onclick = freePlay;

// Gallery: every finished picture, levels first, then the bonus ones, then your own.
function gallery() {
  const done = library().filter(puzzle => progress(puzzle) === 1);
  const name = puzzle => { const n = builtIns.indexOf(puzzle); return n < 0 ? esc(puzzle.title) : `Level ${n + 1}`; };
  show(`<p class="eyebrow">GALLERY</p><h2>Finished pictures</h2>${done.length
    ? `<div class="puzzle-list">${done.map(puzzle => `<figure class="gallery-item"><img alt="${esc(puzzle.title)}" src="${thumbnail(puzzle)}"><figcaption>${name(puzzle)}</figcaption></figure>`).join('')}</div>`
    : '<p>Finish a puzzle and it will hang here.</p>'}`);
}
$('gallery').onclick = gallery;

// A yes/no question in the dialog; resolves true for yes.
function ask(question, yes, no) {
  let answer = false;
  return new Promise(resolve => {
    show(`<h2>${esc(question)}</h2><button class="primary" id="askYes">${esc(yes)}</button><button class="home-button" id="askNo">${esc(no)}</button>`, () => resolve(answer));
    $('askYes').onclick = () => { answer = true; $('modal').close(); };
    $('askNo').onclick = () => $('modal').close();
  });
}

// Accounts are invite-only and added on the Mac. A sign-in that ran out keeps the name
// (and this browser's copy of that account's progress) and asks only for the password.
function signInPrompt({ note = '', then = null } = {}) {
  const again = currentAccount();
  show(`<p class="eyebrow">${again ? 'SIGN IN AGAIN' : 'SIGN IN'}</p><h2>${again ? esc(displayName(again.name)) : 'Welcome back'}</h2><p id="signInNote">${esc(note || (again ? 'Please sign in again. Your progress here is safe.' : 'Accounts are invite-only for now.'))}</p><form id="signInForm" class="unlock sign-in"><input id="signInName" autocomplete="username" autocapitalize="none" spellcheck="false" aria-label="Name" placeholder="Name" required value="${again ? esc(again.name) : ''}"${again ? ' readonly' : ''}><input id="password" type="password" autocomplete="current-password" aria-label="Password" placeholder="Password" required><button class="primary" type="submit">Sign in</button></form>${again ? '<button class="home-button" id="forgetAccount">Sign out instead</button>' : ''}`);
  (again ? $('password') : $('signInName')).focus();
  if (again) $('forgetAccount').onclick = () => signOutFlow(false);
  $('signInForm').onsubmit = async e => {
    e.preventDefault();
    const button = e.target.querySelector('button'); button.disabled = true;
    try {
      await signIn($('signInName').value, $('password').value);
      track('login', { ok: true });
    } catch (error) {
      track('login', { ok: false, status: error.status });
      $('signInNote').textContent = error.message; button.disabled = false; $('password').select();
      return;
    }
    await startAccount();
    if ($('modal').open) $('modal').close();
    goHome();
    then?.();
  };
}
async function startAccount() {
  useProfile(currentAccount().name);
  chat.reset();
  await syncNow();
  await offerGuestProgress();
}
// This browser's guest progress can move into the account, once, if the player says so.
// The old shared copy (see SHARED) is offered only to its owner.
async function offerGuestProgress() {
  const name = currentAccount()?.name, guest = withProfile(null, snapshot);
  let shared = null;
  try { shared = name === SHARED_OWNER ? null : JSON.parse(localStorage.getItem(SHARED)); } catch {}
  const old = (id, save) => Boolean(shared?.saves && id in shared.saves && shared.saves[id] === (save.savedAt ?? null));
  const saves = Object.entries(guest.saves).filter(([id, save]) => !old(id, save));
  const custom = guest.custom.filter(a => !shared?.custom?.includes(a.id));
  const ids = [...new Set([...saves.map(([id]) => id), ...custom.map(a => a.id)])];
  if (!ids.length) return;
  if (!await ask(`Add this browser’s progress (${ids.length} puzzle${ids.length === 1 ? '' : 's'}) to ${displayName(name)}?`, 'Add it', 'Not now')) return;
  for (const puzzle of custom) if (!customPuzzles().some(a => a.id === puzzle.id)) addCustom(puzzle);
  const arts = new Map([...shipped(), ...customPuzzles()].map(a => [a.id, a]));
  for (const [id, save] of saves) {
    const mine = readSave(id);
    if (!mine || jewelsHome(arts.get(id), save) > jewelsHome(arts.get(id), mine)) writeSave(id, save);
  }
  withProfile(null, () => forget(ids));
  if (name === SHARED_OWNER) try { localStorage.removeItem(SHARED); } catch {}
  track('guest_progress_added', { puzzles: ids.length });
  await syncNow();
}

function accountMenu() {
  const account = currentAccount();
  if (!account?.token) return signInPrompt();
  show(`<p class="eyebrow">SIGNED IN</p><h2>${esc(displayName(account.name))}</h2><p>${unsent() ? 'Some progress is still on its way to the server.' : 'Your progress is saved on the server.'}</p><button class="home-button" id="signOutHere">Sign out</button><button class="home-button" id="signOutAll">Sign out everywhere</button>`);
  $('signOutHere').onclick = () => signOutFlow(false);
  $('signOutAll').onclick = () => signOutFlow(true);
}
// Signing out sends what it can, then removes the account's copy from this browser.
async function signOutFlow(everywhere) {
  const account = currentAccount();
  if (!account) return;
  if (online()) await syncNow();
  if (unsent() && !confirm('Some progress hasn’t reached the server yet. Sign out and remove it from this browser anyway?')) return;
  await signOut(everywhere);
  chat.stop();
  clearProfile(account.name);
  useProfile(null);
  track('logout', { everywhere });
  if ($('modal').open) $('modal').close();
  goHome();
}
$('accountButton').onclick = accountMenu;

// The chat with your friend, on its own screen.
function openChat() {
  if (!online()) return goHome();
  showScreen('chat'); returnTo = null;
  $('chatStatus').textContent = '';
  chat.open();
}
$('chatButton').onclick = openChat;
$('chatBack').onclick = goHome;
// A puzzle tapped in the chat opens; one removed from Free play comes back first.
function openFromChat(puzzle, maker) {
  let known = library().find(a => a.id === puzzle.id);
  if (!known) {
    known = maker && maker !== currentAccount()?.name ? { ...puzzle, from: maker } : { ...puzzle };
    addCustom(known); syncSoon(0);
  }
  chat.close();
  openPuzzle(known, builtIns.includes(known) ? builtIns.indexOf(known) : null, 'chat');
}
// Only puzzles you made can be sent. The server needs the puzzle before the message.
async function sendPuzzle(puzzle, note = text => { $('chatStatus').textContent = text; }) {
  if (syncMeta().uploads.includes(puzzle.id)) await syncNow();
  if (syncMeta().uploads.includes(puzzle.id)) { note('Couldn’t reach the server. Try again in a moment.'); return false; }
  track('puzzle_sent', { puzzle: puzzle.id });
  await chat.sendPuzzle(puzzle.id);
  return true;
}
$('chatPuzzle').onclick = () => {
  const mine = customPuzzles().filter(a => !a.from);
  show(`<p class="eyebrow">SEND A PUZZLE</p><h2>Your puzzles</h2>${mine.length ? '<div class="puzzle-list" id="pickList"></div>' : '<p>Nothing here yet. Create one, then send it.</p>'}<button class="primary" id="pickCreate">✦ Create puzzle</button>`);
  for (const puzzle of mine) $('pickList').append(puzzleCard(puzzle, () => { $('modal').close(); sendPuzzle(puzzle); }));
  // A puzzle made from here lands in this list; tap 🧩 again to send it.
  $('pickCreate').onclick = maker.start;
};
const chat = createChat({
  $, thumbnail, progress,
  findArt: id => library().find(a => a.id === id),
  openArt: openFromChat,
  onUnread: showUnread,
  onPuzzleNews: () => syncSoon(0),
  say: text => { $('chatStatus').textContent = text; },
});
// The server stopped accepting this browser's sign-in: keep everything, and ask again.
whenSignedOut(() => { chat.stop(); if (!$('chat').hidden) goHome(); else renderAccount(); });
// On phones, keep the message box above the on-screen keyboard.
window.visualViewport?.addEventListener('resize', () => document.documentElement?.style.setProperty('--viewport-height', `${window.visualViewport.height}px`));
// Pinching zooms the board (pointer events above), never the page: Safari ignores
// maximum-scale, so its own pinch gestures are turned down here.
for (const type of ['gesturestart', 'gesturechange']) document.addEventListener?.(type, e => e.preventDefault(), { passive: false });

// Making a puzzle: the same pop-up from the start screen, Free play and the chat (create.js).
const maker = createMaker({
  $, show, esc, thumbnail, track,
  keep: puzzle => { if (customPuzzles().some(a => a.id === puzzle.id)) return true; if (!addCustom(puzzle)) return false; syncSoon(0); return true; },
  play: puzzle => openPuzzle(puzzle, null, $('chat').hidden ? null : 'chat'),
  freePlay,
  signIn: (note, then) => signInPrompt({ note, then }),
});

// iPhone and iPad can't show a web page fullscreen; added to the Home Screen, the game
// opens from its own icon in its own window, with no address bar. Suggested once.
const HOME_SCREEN_HINT = 'little-jewel:home-screen-hint';
function homeScreenHint() {
  const nav = globalThis.navigator;
  const apple = /iPhone|iPad|iPod/.test(nav?.userAgent || '') || (nav?.platform === 'MacIntel' && nav?.maxTouchPoints > 1);
  const installed = nav?.standalone === true || matchMedia('(display-mode: standalone)').matches;
  let seen = true;
  try { seen = Boolean(localStorage.getItem(HOME_SCREEN_HINT)); } catch {}
  if (!apple || installed || seen) return;
  try { localStorage.setItem(HOME_SCREEN_HINT, '1'); } catch {}
  track('home_screen_hint');
  show(`<p class="eyebrow">PLAY IT LIKE AN APP</p><h2>Add to Home Screen</h2><p>Tap the Share button (the square with an arrow), then <strong>Add to Home Screen</strong>. The game then opens full screen from its own icon, with no address bar.</p><p>Progress you made without signing in stays here in the browser. Sign in on the Home Screen version to bring yours along.</p><button class="primary" id="hintOk">Got it</button>`);
  $('hintOk').onclick = () => $('modal').close();
}

if (online()) chat.reset();
goHome();
homeScreenHint();
syncNow();
