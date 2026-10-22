import { createPuzzle, select, transfer, correctCount, restore, findHint, shelfAction, continueSelection, expandShelf, MAX_SHELF_SIZE } from './game.js';
const $ = id => document.getElementById(id);
let art;
try {
  const response = await fetch('./assets/art.json');
  if (!response.ok) throw new Error();
  art = await response.json();
} catch { $('instruction').textContent = 'The artwork could not load. Please refresh.'; throw new Error('Artwork unavailable'); }
const key = `little-jewel:sorting-v2:${art.id}`;
let saved;
try { saved = JSON.parse(localStorage.getItem(key)); } catch {}
let state = restore(art, saved) || createPuzzle(art);
let selection = Number.isInteger(saved?.selectedColor) && saved.selectedColor >= 0 && saved.selectedColor < art.colors.length
  ? continueSelection(art,state,{kind:'color',color:saved.selectedColor,cells:[]}) : null;
let history = [], busy = false, zoom = 2.5, ox = 0, oy = 0, size = 0;
let cursor = 0, keyboard = false, hintTarget = null;
const pointers = new Map();
let gesture = null, startPoint = null, moved = false;
const canvas = $('board'), ctx = canvas.getContext('2d');
const total = art.pixels.filter(c => c >= 0).length;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const shelfButtons = [];
let arrivals = new Set();

function message(text) { $('instruction').textContent = text; }
function save() {
  try { localStorage.setItem(key, JSON.stringify({ board: state.board, shelf: state.shelf, moves: state.moves, selectedColor: selection?.color ?? null })); }
  catch { message('Saving unavailable in this browser'); }
}
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
  const correct = correctCount(art, state);
  const free = state.shelf.filter(c => c < 0).length;
  $('shelf').classList.toggle('ready', selection?.kind === 'board' && free > 0);
  $('shelf').classList.toggle('hinted', hintTarget?.kind === 'shelf');
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
  $('undo').disabled = !history.length || busy;
  $('hint').disabled = correct === total || busy;
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
  // A restrained focus ring is reserved for the keyboard and explicit hints.
  ctx.strokeStyle='#fff';ctx.lineWidth=Math.max(1,cell*.045);ctx.setLineDash([cell*.12,cell*.08]);
  octagon(x+cell*.08,y+cell*.08,cell*.84);ctx.stroke();ctx.setLineDash([]);
}
function draw() {
  if(!size)return;
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
  const focus=hintTarget?.kind==='board'?hintTarget.index:keyboard?cursor:-1;
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
$('zoomIn').onclick = () => zoomTo(zoom * 1.5);
$('zoomOut').onclick = () => zoomTo(zoom / 1.5);
$('fit').onclick = () => { zoom = 1; ox = oy = 0; draw(); };
function selectGroup(kind, i) {
  const next = select(art, state, kind, i);
  if (!next) return;
  if (selection?.kind === kind && selection.cells.includes(i)) {
    selection = null; message('Tap a jewel group, then choose where it goes.');
  } else {
    selection = next;
    message(kind === 'shelf' ? 'Tap matching empty spaces on the board.' : 'Tap the shelf, or matching empty spaces.');
  }
  hintTarget = null; update();
  if (selection?.kind === 'shelf') {
    const target=art.pixels.findIndex((c,n)=>c===selection.color&&state.board[n]===-1);
    if(target<0) message('No empty spaces for this color yet. Free a matching space first.');
    else { focusCell(target); message('Shelf jewels selected. Tap a matching empty socket.'); }
  }
}
function focusCell(i) {
  cursor=i; zoom=Math.max(zoom,2.5); const cell=size/art.width*zoom;
  ox=size/2-(i%art.width+.5)*cell;oy=size/2-(Math.floor(i/art.width)+.5)*cell;constrain();draw();
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
    const r = shelfButtons[location.index].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, size: r.width * .72 };
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
  history.push({ board: [...state.board], shelf: [...state.shelf], moves: state.moves });
  if (history.length > 100) history.shift();
  busy = true; const motion=[...result.transfers,...result.shelfShifts];
  arrivals = new Set(motion.map(t=>`${t.to.kind}:${t.to.index}`));
  state = result.state; selection = continueSelection(art,state,selection); hintTarget = null; save(); update();
  message(`${result.transfers.length} ${result.transfers.length === 1 ? 'jewel' : 'jewels'} ${kind === 'shelf' ? 'on the shelf. Now make room for their color.' : 'back where they belong.'}`);
  try { await animate(motion); } finally { arrivals.clear(); busy = false; update(); }
  if (correctCount(art, state) === total) {
    show(`<p class="eyebrow">EVERY JEWEL, BACK HOME</p><h2>Made with love.</h2><p>You restored the picture in ${state.moves} moves.</p><img src="assets/art.png" alt="Your completed artwork"><button class="primary" id="keep">Enjoy your artwork</button>`);
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
  if (e.key === 'Escape') { selection=null; hintTarget=null; update(); }
};
$('undo').onclick = () => {
  if (busy || !history.length) return;
  state=history.pop(); selection=continueSelection(art,state,selection); hintTarget=null; save(); update(); message('Move undone. Every jewel is back in place.');
};
$('hint').onclick = () => {
  const hint = findHint(art,state);
  if (!hint) { message('No matching spaces available. Undo a move to make room.'); return; }
  selection=hint.selection; hintTarget={ kind:hint.destination, index:hint.index };
  const i=hint.destination==='board'?hint.index:selection.index;
  cursor=i; keyboard=true; zoom=2.5; const cell=size/art.width*zoom; ox=size/2-(i%art.width+.5)*cell; oy=size/2-(Math.floor(i/art.width)+.5)*cell; constrain(); update();
  message(hint.destination==='shelf'?'Store the highlighted group on the shelf.':'Move the selected jewels to the outlined space.');
};
function show(content) { $('modalContent').innerHTML=content; if (!$('modal').open) $('modal').showModal(); }
$('close').onclick = () => $('modal').close();
$('modal').onclick = e => { if(e.target===$('modal')){const r=$('modal').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('modal').close();} };
$('addShelf').onclick=()=>{
  if(busy||state.shelf.length>=MAX_SHELF_SIZE)return;
  state=expandShelf(state);
  // Adding room is permanent for this puzzle, including when undoing a move.
  history=history.map(p=>({...p,shelf:[...p.shelf,...Array(state.shelf.length-p.shelf.length).fill(-1)]}));
  save();update();message('Eight more spaces. Make yourself comfortable.');
};
update();
