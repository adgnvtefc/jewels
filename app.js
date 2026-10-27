import { createPuzzle, select, transfer, correctCount, restore, shelfAction, continueSelection, expandShelf, MAX_SHELF_SIZE } from './game.js';
import { builtInPuzzles, customPuzzles, addCustom, removeCustom, progress, thumbnail, saveKey, snapshot, mergeSaves, storeSnapshot, packSaves, unpackSaves } from './library.js';
import { unlocked, unlock, generate, pictureToArt, GeneratorError, fetchSaves, sendSaves } from './generator.js';
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
if ((location.hash || '').startsWith('#carry=')) {
  try { storeSnapshot(mergeSaves(snapshot(), await unpackSaves(location.hash.slice(7)), builtIns)); } catch {}
  history.replaceState(null, '', location.pathname + location.search);
}
const library = () => [...builtIns, ...customPuzzles()];
let art, key, state, selection, total = 0, level = null;
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
  try { localStorage.setItem(key, JSON.stringify({ board: state.board, shelf: state.shelf, moves: state.moves, selectedColor: selection?.color ?? null, savedAt: Date.now() })); }
  catch { message('Saving unavailable in this browser'); }
  syncSoon();
}

// With the password, saves also live on the server, so every browser, address and Home
// Screen copy shows the same progress. This browser's saves stay the fallback offline.
let syncing = null, syncTimer = null;
function syncSoon(ms = 4000) { clearTimeout(syncTimer); syncTimer = setTimeout(syncSaves, ms); }
function syncSaves() {
  if (!unlocked()) return Promise.resolve();
  return syncing ??= (async () => {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const remote = await fetchSaves();
        // The puzzle on screen keeps its own copy; the board never changes under the player.
        const open = $('game').hidden ? new Set() : new Set([art.id]);
        const merged = mergeSaves(snapshot(), remote.data || {}, builtIns, open);
        storeSnapshot(merged);
        try { await sendSaves(merged, remote.version); break; }
        catch (error) { if (error.status !== 409) throw error; }
      }
      if (!$('home').hidden && !$('modal').open) goHome();
    } catch {} finally { syncing = null; }
  })();
}
document.addEventListener?.('visibilitychange', () => { if (document.visibilityState === 'hidden') syncSaves(); });
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
  const dpr = window.devicePixelRatio || 1; canvas.width = Math.round(size * dpr); canvas.height = Math.round(size * dpr);
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
function screenPoint(location) {
  if (location.kind === 'shelf') {
    const slot = shelfButtons[location.index];
    const r = (slot.firstElementChild || slot).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, size: r.width };
  }
  const r = canvas.getBoundingClientRect(), cell = size / art.width * zoom;
  return { x: r.x + ox + (location.index % art.width + .5) * cell, y: r.y + oy + (Math.floor(location.index / art.width) + .5) * cell, size: cell * .72 };
}
async function animate(transfers) {
  if (reducedMotion) return;
  await Promise.all(transfers.slice(0, 64).map(async (t, n) => {
    const a = screenPoint(t.from), b = screenPoint(t.to), el = document.createElement('span');
    el.className = 'flying-jewel'; el.style.cssText = `left:${a.x}px;top:${a.y}px;width:${a.size}px;height:${a.size}px;background:${art.colors[t.color]}`;
    document.body.append(el);
    try {
      await el.animate([
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
        { transform: `translate(calc(-50% + ${(b.x-a.x)*.5}px),calc(-50% + ${(b.y-a.y)*.5-(t.from.kind==='shelf'&&t.to.kind==='shelf'?0:35)}px)) scale(1.2)`, opacity: 1, offset: .5 },
        { transform: `translate(calc(-50% + ${b.x-a.x}px),calc(-50% + ${b.y-a.y}px)) scale(${b.size/a.size})`, opacity: .85 }
      ], { duration: 330, delay: Math.min(n * 13, 200), easing: 'ease-in-out' }).finished;
    } finally { el.remove(); }
  }));
}
async function move(kind, index) {
  if (selection?.kind === 'color') { message('This color is complete. Choose another color.'); return; }
  const result = transfer(art, state, selection, kind, index);
  if (result.error) { message(result.error); return; }
  busy = true; const motion=[...result.transfers,...result.shelfShifts];
  arrivals = new Set(motion.map(t=>`${t.to.kind}:${t.to.index}`));
  state = result.state; selection = continueSelection(art,state,selection); save(); update();
  message(`${result.transfers.length} ${result.transfers.length === 1 ? 'jewel' : 'jewels'} ${kind === 'shelf' ? 'on the shelf. Now make room for their color.' : 'back where they belong.'}`);
  try { await animate(motion); } finally { arrivals.clear(); busy = false; update(); }
  if (correctCount(art, state) === total) {
    track('level_complete', { puzzle: art.id, title: art.title, custom: !builtIns.some(a => a.id === art.id), moves: state.moves, colors: art.colors.length, jewels: total });
    syncSoon(0);
    const heading = art.id === 'love-garden-v1' ? 'Made with love.' : esc(art.title);
    const eyebrow = level === null ? 'EVERY JEWEL, BACK HOME' : `LEVEL ${level + 1} COMPLETE`;
    // However the dialog closes, a finished puzzle returns to the start screen.
    show(`<p class="eyebrow">${eyebrow}</p><h2>${heading}</h2><p>You restored the picture in ${state.moves} moves.</p><img src="${thumbnail(art, 8)}" alt="Your completed artwork"><button class="primary" id="keep">Back to start</button>`, goHome);
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
$('modal').onclose = () => { const next=afterClose; afterClose=null; next?.(); };
$('close').onclick = () => $('modal').close();
$('modal').onclick = e => { if(e.target===$('modal')){const r=$('modal').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('modal').close();} };
$('addShelf').onclick=()=>{
  if(busy||state.shelf.length>=MAX_SHELF_SIZE)return;
  state=expandShelf(state);
  save();update();message('Eight more spaces. Make yourself comfortable.');
};
const esc = text => String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

// Two screens: the start screen (home) and the board (game). Reloading always starts at home.
function goHome() {
  $('game').hidden = true; $('home').hidden = false;
  const next = nextLevel();
  $('levels').innerHTML = builtIns.map((puzzle, n) => {
    const done = progress(puzzle) === 1;
    const label = `Level ${n + 1}${done ? ', complete' : n === next ? ', next' : ''}`;
    return `<li class="level-pip${done ? ' done' : n === next ? ' current' : ''}" aria-label="${label}">${done ? `<img alt="" src="${thumbnail(puzzle)}">` : ''}</li>`;
  }).join('');
  $('startGame').disabled = next < 0;
  $('startLevel').textContent = next < 0 ? 'All levels complete' : `Level ${next + 1} of ${builtIns.length}`;
}
// Levels are the built-in puzzles, in order; the next one is the first not yet finished.
const nextLevel = () => builtIns.findIndex(puzzle => progress(puzzle) !== 1);
$('startGame').onclick = () => { const next = nextLevel(); if (next >= 0) openPuzzle(builtIns[next], next); };
$('menu').onclick = () => { if (!busy) goHome(); };

function openPuzzle(next, levelIndex = null) {
  art = next; level = levelIndex; key = saveKey(art.id); total = art.pixels.filter(c => c >= 0).length;
  $('home').hidden = true; $('game').hidden = false;
  let saved;
  try { saved = JSON.parse(localStorage.getItem(key)); } catch {}
  state = restore(art, saved) || createPuzzle(art);
  selection = Number.isInteger(saved?.selectedColor) && saved.selectedColor >= 0 && saved.selectedColor < art.colors.length
    ? continueSelection(art,state,{kind:'color',color:saved.selectedColor,cells:[]}) : null;
  cursor = 0; keyboard = false; zoom = 1; ox = oy = 0;
  constrain(); update();
  message(`${level === null ? '' : `Level ${level + 1}: `}${art.title}. Tap a jewel group, then the shelf.`);
}

// Free play: pictures you created, and the way to make more.
function freePlay() {
  const mine = customPuzzles();
  show(`<p class="eyebrow">FREE PLAY</p><h2>Your puzzles</h2>${mine.length ? '<div class="puzzle-list" id="puzzleList"></div>' : '<p>Nothing here yet. Describe a picture and it becomes a puzzle.</p>'}<button class="primary" id="createOwn">✦ Create your own</button>`);
  for (const puzzle of mine) {
    const done = progress(puzzle), card = document.createElement('div');
    card.className = 'puzzle-card';
    card.innerHTML = `<button class="puzzle-pick"><img alt="" src="${thumbnail(puzzle)}"><span class="puzzle-title">${esc(puzzle.title)}</span><span class="puzzle-progress">${done === null ? 'New' : done === 1 ? 'Complete' : `${Math.floor(done * 100)}%`}</span></button>`;
    card.querySelector('.puzzle-pick').onclick = () => { $('modal').close(); openPuzzle(puzzle); };
    const remove = document.createElement('button');
    remove.className = 'puzzle-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${puzzle.title}`);
    remove.onclick = () => {
      if (!confirm(`Remove “${puzzle.title}” and its progress?`)) return;
      removeCustom(puzzle.id); freePlay();
    };
    card.append(remove);
    $('puzzleList').append(card);
  }
  $('createOwn').onclick = () => { if (unlocked()) { $('modal').close(); openCreate(); } else passwordPrompt(); };
}
$('freePlay').onclick = freePlay;

// Gallery: every finished picture, levels first, then your own.
function gallery() {
  const done = library().filter(puzzle => progress(puzzle) === 1);
  const name = puzzle => { const n = builtIns.indexOf(puzzle); return n < 0 ? esc(puzzle.title) : `Level ${n + 1}`; };
  show(`<p class="eyebrow">GALLERY</p><h2>Finished pictures</h2>${done.length
    ? `<div class="puzzle-list">${done.map(puzzle => `<figure class="gallery-item"><img alt="${esc(puzzle.title)}" src="${thumbnail(puzzle)}"><figcaption>${name(puzzle)}</figcaption></figure>`).join('')}</div>`
    : '<p>Finish a puzzle and it will hang here.</p>'}`);
}
$('gallery').onclick = gallery;

function passwordPrompt(note = '') {
  show(`<p class="eyebrow">CREATE YOUR OWN</p><h2>Password</h2><p id="unlockNote">${esc(note || 'Making new puzzles needs the password.')}</p><form id="unlockForm" class="unlock"><input id="password" type="password" autocomplete="current-password" aria-label="Password" required><button class="primary" type="submit">Unlock</button></form>`);
  $('password').focus();
  $('unlockForm').onsubmit = async e => {
    e.preventDefault();
    const button = e.target.querySelector('button'); button.disabled = true;
    try { await unlock($('password').value); track('login', { ok: true }); syncSaves(); $('modal').close(); openCreate(); }
    catch (error) { track('login', { ok: false, error: error.message, status: error.status }); $('unlockNote').textContent = error.message; button.disabled = false; $('password').select(); }
  };
}

// The create bar sits at the bottom of the screen; results come back as candidates to pick from.
let creating = false;
function openCreate() {
  $('create').hidden = false; document.body.classList.add('creating');
  $('createStatus').textContent = 'Describe a picture. You’ll get four to choose from.';
  $('prompt').focus();
}
$('createClose').onclick = () => { $('create').hidden = true; document.body.classList.remove('creating'); };
const status = text => { $('createStatus').textContent = text; };
$('create').onsubmit = async e => {
  e.preventDefault();
  const prompt = $('prompt').value.trim();
  if (!prompt || creating) return;
  creating = true; $('createGo').disabled = true; status('Sending your idea…');
  const started = Date.now();
  try {
    const job = await generate(prompt, job => {
      if (job.status === 'queued') status(job.ahead ? `Waiting in line (${job.ahead} ahead)…` : 'Starting…');
      else if (job.status === 'writing') status('Thinking about your idea…');
      else if (job.status === 'painting') status(`Painting “${job.subject}” — ${job.painted} of ${job.total}…`);
    });
    status('Cutting the jewels…');
    const choices = await Promise.all(job.images.map(src => pictureToArt(src, { title: prompt[0].toUpperCase() + prompt.slice(1, 60) })));
    track('llm_generate', { ok: true, prompt, subject: job.subject, agent: job.agent, images: job.images.length, seconds: job.seconds, ms: Date.now() - started });
    status(''); pickCandidate(prompt, choices);
  } catch (error) {
    track('llm_generate', { ok: false, prompt, error: error.message, status: error.status, ms: Date.now() - started });
    if (error instanceof GeneratorError && error.status === 401) { $('createClose').onclick(); passwordPrompt('Please enter the password again.'); }
    else status(error.message || 'Something went wrong.');
  } finally { creating = false; $('createGo').disabled = false; }
};

function pickCandidate(prompt, choices) {
  show(`<p class="eyebrow">CREATE YOUR OWN</p><h2>Pick one</h2><p>${esc(prompt)}</p><div class="candidates" id="candidates"></div><button class="primary" id="again">Try again</button>`);
  choices.forEach((choice, n) => {
    const button = document.createElement('button');
    button.className = 'candidate'; button.setAttribute('aria-label', `Option ${n + 1}, ${choice.colors.length} colors`);
    button.innerHTML = `<img alt="" src="${thumbnail({ ...choice, id: `choice-${Date.now()}-${n}` }, 4)}"><span>${choice.colors.length} colors</span>`;
    button.onclick = () => {
      const puzzle = { ...choice, id: `custom-${Date.now().toString(36)}` };
      if (!addCustom(puzzle)) { status('This browser could not save the puzzle.'); return; }
      track('llm_pick', { prompt, option: n + 1, colors: choice.colors.length });
      $('modal').close(); $('createClose').onclick(); $('prompt').value = '';
      openPuzzle(puzzle);
    };
    $('candidates').append(button);
  });
  $('again').onclick = () => { $('modal').close(); $('create').requestSubmit(); };
}

goHome();
syncSaves();
