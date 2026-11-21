// The board: the puzzle on screen. Drawing (jewels, sockets, sparkles and ripples on their own
// layer), pinch, pan and taps, the shelf, moves and their animations, and saving progress.
// Everything about which puzzle, where it came from and what happens when it's finished is
// the caller's (app.js), through deps.
import { createPuzzle, select, transfer, correctCount, restore, shelfAction, continueSelection, expandShelf, MAX_SHELF_SIZE } from './game.js';
import { readSave, writeSave } from './library.js';

// deps: { $, showScreen(name), saved() (after each save), finished(art, moves, { level, from }), leave(from) }
export function createBoard(deps) {
  const { $ } = deps;
  let art, state, selection, total = 0, level = null, returnTo = null, label = null;
  let busy = false, finishing = false, zoom = 1, ox = 0, oy = 0, size = 0;
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
    deps.saved();
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
    $('bigFinish').hidden = !finishing && !onlyShelfLeft();
    $('bigFinish').disabled = finishing;
    const percent = Math.floor(correctCount(art, state) / total * 100);
    $('progressFill').style.width = `${percent}%`;
    $('progressText').textContent = `${percent}%`;
    $('progress').setAttribute('aria-valuenow', String(percent));
    $('moveCount').textContent = `${state.moves} ${state.moves === 1 ? 'move' : 'moves'}`;
    save(); draw();
  }
  // Visual states follow the reference: recessed socket, raised loose jewel,
  // lifted selection, and a low-relief jewel seated in its matching tile.
  function octagon(x, y, width, c = ctx) {
    const cut=width*.24;
    c.beginPath();c.moveTo(x+cut,y);c.lineTo(x+width-cut,y);
    c.lineTo(x+width,y+cut);c.lineTo(x+width,y+width-cut);
    c.lineTo(x+width-cut,y+width);c.lineTo(x+cut,y+width);
    c.lineTo(x,y+width-cut);c.lineTo(x,y+cut);c.closePath();
  }
  function facet(points, fill, c = ctx) {
    c.beginPath();points.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.closePath();c.fillStyle=fill;c.fill();
  }
  function jewel(x,y,cell,color,picked=false,seated=false,c=ctx) {
    const w=cell*(seated?.72:.66), x0=x+(cell-w)/2;
    const y0=y+(cell-w)/2-(picked?cell*.13:seated?0:cell*.035);
    const depth=cell*(picked?.13:seated?.015:.07), bevel=w*(seated?.13:.20);
    if(!seated){
      c.save();c.shadowColor='#142a294a';c.shadowBlur=cell*(picked?.13:.05);c.shadowOffsetY=cell*(picked?.13:.055);
      octagon(x0,y0+depth,w,c);c.fillStyle=color;c.fill();c.restore();
      octagon(x0,y0+depth,w,c);c.fillStyle='#00000045';c.fill();
    }
    octagon(x0,y0,w,c);c.fillStyle=color;c.fill();c.save();c.clip();
    facet([[x0,y0],[x0+w,y0],[x0+w-bevel,y0+bevel],[x0+bevel,y0+bevel]],seated?'#ffffff24':'#ffffff70',c);
    facet([[x0,y0],[x0+bevel,y0+bevel],[x0+bevel,y0+w-bevel],[x0,y0+w]],seated?'#ffffff0c':'#ffffff22',c);
    facet([[x0,y0+w],[x0+bevel,y0+w-bevel],[x0+w-bevel,y0+w-bevel],[x0+w,y0+w]],seated?'#00000016':'#00000033',c);
    facet([[x0+w,y0],[x0+w,y0+w],[x0+w-bevel,y0+w-bevel],[x0+w-bevel,y0+bevel]],seated?'#0000000c':'#00000018',c);
    c.restore();
    octagon(x0,y0,w,c);c.strokeStyle=seated?'#ffffff28':picked?'#ffffffc0':'#142a2938';c.lineWidth=Math.max(.5,cell*.025);c.stroke();
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
  // A ripple when a color is finished: starting at the last jewel placed, each jewel of
  // that color swells and brightens for a moment, spreading outward across the color.
  const RIPPLE_SPREAD_MS = 600, RIPPLE_PULSE_MS = 320;
  let sparkles = [], ripples = [], overlayRunning = false;
  function startOverlay() { if (!overlayRunning) { overlayRunning = true; nextFrame(overlayTick); } }
  function sparkle(i) {
    if (reducedMotion || !art || state.board[i] !== art.pixels[i]) return;
    sparkles.push({ i, t0: Date.now(), seed: Math.random() * Math.PI * 2 });
    startOverlay();
  }
  function ripple(color, origin) {
    if (reducedMotion || !art) return;
    const W = art.width, cells = [];
    art.pixels.forEach((c, i) => { if (c === color) cells.push(i); });
    const away = i => Math.hypot(i % W - origin % W, Math.floor(i / W) - Math.floor(origin / W));
    const far = Math.max(1, ...cells.map(away));
    ripples.push({ sprite: rippleSprite(art.colors[color]), t0: Date.now(), cells: cells.map(i => ({ i, delay: away(i) / far * RIPPLE_SPREAD_MS })) });
    startOverlay();
  }
  // The jewel and its white flash are drawn once per ripple and then stamped, so even a
  // background of 800 jewels costs little per frame on a phone.
  function rippleSprite(color) {
    const dpr = window.devicePixelRatio || 1, cell = size / art.width * zoom, px = Math.max(1, Math.ceil(cell * dpr));
    const make = paint => { const c = document.createElement('canvas'); c.width = c.height = px; const g = c.getContext('2d'); g.scale(px / cell, px / cell); paint(g); return c; };
    const w = cell * .72;
    return {
      jewel: make(g => jewel(0, 0, cell, color, false, true, g)),
      flash: make(g => { octagon((cell - w) / 2, (cell - w) / 2, w, g); g.fillStyle = '#fff'; g.fill(); }),
    };
  }
  // Sparkles and ripples live on their own transparent canvas over the board, so a frame
  // repaints only what is moving instead of all 1,024 jewels.
  const sparkleCanvas = $('sparkleLayer'), sctx = sparkleCanvas.getContext('2d');
  function overlayTick() {
    const now = Date.now();
    sparkles = sparkles.filter(s => now - s.t0 < SPARKLE_MS);
    ripples = ripples.filter(r => now - r.t0 < RIPPLE_SPREAD_MS + RIPPLE_PULSE_MS);
    drawOverlay();
    if (sparkles.length || ripples.length) nextFrame(overlayTick); else overlayRunning = false;
  }
  function sparkleStar(cx, cy, r) {
    sctx.beginPath();
    for (let k = 0; k < 8; k++) { const rr = k % 2 ? r * .28 : r, an = k * Math.PI / 4; sctx.lineTo(cx + Math.sin(an) * rr, cy - Math.cos(an) * rr); }
    sctx.closePath(); sctx.fill();
  }
  function drawOverlay() {
    const dpr = window.devicePixelRatio || 1, cell = size / (art?.width || 1) * zoom;
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0); sctx.clearRect(0, 0, size, size);
    if ((!sparkles.length && !ripples.length) || !art) return;
    sctx.translate(ox, oy);
    const now = Date.now();
    for (const r of ripples) for (const { i, delay } of r.cells) {
      const k = (now - r.t0 - delay) / RIPPLE_PULSE_MS;
      if (k <= 0 || k >= 1) continue;
      const x = i % art.width * cell, y = Math.floor(i / art.width) * cell;
      if (x + ox > size || y + oy > size || x + ox + cell < 0 || y + oy + cell < 0) continue;  // off screen when zoomed
      const a = Math.sin(Math.PI * k), s = cell * (1 + .3 * a), sx = x + (cell - s) / 2, sy = y + (cell - s) / 2;
      sctx.drawImage(r.sprite.jewel, sx, sy, s, s);
      sctx.globalAlpha = .4 * a; sctx.drawImage(r.sprite.flash, sx, sy, s, s); sctx.globalAlpha = 1;
    }
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
    if (busy || finishing || i < 0 || art.pixels[i] < 0) return;
    if (state.board[i] >= 0 && state.board[i] === art.pixels[i]) {
      message('This jewel is already home and cannot be moved.');
      return;
    }
    if (state.board[i] >= 0) selectGroup('board', i);
    else if (selection) move('board', i);
    else message('Select a jewel group before choosing an empty space.');
  }
  function tapShelf(i) {
    if (busy || finishing) return;
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
  async function animate(transfers, stagger = 13, maxDelay = 200) {
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
        ], { duration: 330, delay: shelfWait + Math.min(n * stagger, maxDelay), easing: 'ease-in-out', fill: 'both' }).finished;
        await land(`${t.to.kind}:${t.to.index}`, el);
      } catch { el.remove(); }
    }));
  }
  // The end of a puzzle: every jewel not yet home is on the shelf, all of one color, with
  // nothing misplaced on the board, so all that's left is putting them in. BIG FINISH does it in one sweep: the
  // groups are placed as if tapped one by one (each counts as a move), and every jewel flies
  // from its shelf slot to its spot in turn, top of the picture to bottom, in about two seconds.
  // Each color ripples as its last jewel lands.
  const SWEEP_MS = 2000;
  function onlyShelfLeft() {
    const colors = new Set(state.shelf.filter(c => c >= 0));
    return colors.size === 1 && state.board.every((c, i) => c < 0 || c === art.pixels[i]);
  }
  async function bigFinish() {
    if (busy || finishing || !onlyShelfLeft()) return;
    finishing = true; busy = true; selection = null;
    const finishedBefore = finishedColors();
    // Place every group on a copy, keeping track of which slot on screen each shelf jewel is in
    // (the shelf closes up after each placement, but the screen still shows the first layout).
    let next = state, slots = state.shelf.map((_, i) => i), last = null;
    const flights = [];
    while (next.shelf.some(c => c >= 0)) {
      const color = next.shelf.find(c => c >= 0);
      const empty = art.pixels.flatMap((c, i) => c === color && next.board[i] === -1 ? [i] : []);
      if (!empty.length) break;
      const away = i => last === null ? i : Math.hypot(i % art.width - last % art.width, Math.floor(i / art.width) - Math.floor(last / art.width));
      const target = empty.reduce((best, i) => away(i) < away(best) ? i : best);
      const result = transfer(art, next, select(art, next, 'shelf', next.shelf.indexOf(color)), 'board', target);
      if (result.error) break;
      for (const t of result.transfers) flights.push({ ...t, from: { kind: 'shelf', index: slots[t.from.index] } });
      const gone = new Set(result.transfers.map(t => t.from.index));
      slots = slots.filter((_, i) => next.shelf[i] >= 0 && !gone.has(i));
      next = result.state; last = target;
    }
    // Top of the picture to bottom.
    flights.sort((a, b) => a.to.index - b.to.index);
    const stagger = Math.max(8, Math.min(60, SWEEP_MS / flights.length));
    const motion = reducedMotion ? [] : flights.slice(0, 240);
    // Each color ripples when its last jewel lands.
    flights.forEach((t, n) => { t.lands = n * stagger + 330; });
    const ripplesAt = [...new Set(flights.map(t => t.color))].map(color => flights.findLast(t => t.color === color));
    arrivals = new Set(motion.map(t => `board:${t.to.index}`));
    state = next; save(); update();
    message('Every jewel, back where it belongs.');
    for (const t of ripplesAt) setTimeout(() => { if (!finishedBefore.has(t.color)) ripple(t.color, t.to.index); }, reducedMotion ? 0 : t.lands);
    try { await animate(motion, stagger, SWEEP_MS); } finally {
      arrivals.clear(); busy = false; update();
      const flown = new Set(motion.map(t => t.to.index));
      for (const t of flights) if (!flown.has(t.to.index)) sparkle(t.to.index);
    }
    await new Promise(resolve => setTimeout(resolve, reducedMotion ? 0 : 500));  // let the last ripple play
    // The button stays until the finish pop-up covers the screen.
    finishing = false;
    if (correctCount(art, state) === total) deps.finished(art, state.moves, { level, from: returnTo });
    else update();
  }
  $('bigFinish').onclick = bigFinish;
  // Colors with every jewel home.
  function finishedColors() {
    const left = new Set();
    art.pixels.forEach((c, i) => { if (c >= 0 && state.board[i] !== c) left.add(c); });
    return new Set(art.colors.map((_, c) => c).filter(c => !left.has(c) && art.pixels.includes(c)));
  }
  async function move(kind, index) {
    if (selection?.kind === 'color') { message('This color is complete. Choose another color.'); return; }
    const result = transfer(art, state, selection, kind, index);
    if (result.error) { message(result.error); return; }
    const finishedBefore = finishedColors();
    // Up to 64 jewels fly; any others simply appear in place.
    busy = true; const motion=reducedMotion?[]:[...result.transfers,...result.shelfShifts].slice(0,64);
    arrivals = new Set(motion.map(t=>`${t.to.kind}:${t.to.index}`));
    state = result.state; selection = continueSelection(art,state,selection,kind === 'board' ? index : null); save(); update();
    message(`${result.transfers.length} ${result.transfers.length === 1 ? 'jewel' : 'jewels'} ${kind === 'shelf' ? 'on the shelf. Now make room for their color.' : 'back where they belong.'}`);
    revealShelf(motion);
    try { await animate(motion); } finally {
      shelfScroll = 0; shelfWait = 0;
      arrivals.clear(); busy = false; update();
      // Jewels past the first 64 don't fly; they sparkle as they appear.
      const flown = new Set(motion.map(t => `${t.to.kind}:${t.to.index}`));
      for (const t of result.transfers) if (t.to.kind === 'board' && !flown.has(`board:${t.to.index}`)) sparkle(t.to.index);
      // A color whose last jewel just landed ripples out from that jewel.
      for (const color of finishedColors()) if (!finishedBefore.has(color)) {
        const last = result.transfers.findLast(t => t.to.kind === 'board' && t.color === color);
        if (last) ripple(color, last.to.index);
      }
    }
    if (correctCount(art, state) === total) deps.finished(art, state.moves, { level, from: returnTo });
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
  $('addShelf').onclick=()=>{
    if(busy||state.shelf.length>=MAX_SHELF_SIZE)return;
    state=expandShelf(state);
    save();update();message('Eight more spaces. Make yourself comfortable.');
  };
  // Shows a puzzle: its saved progress, or a fresh scramble. `label` ("Level 3",
  // "Gauntlet 2 of 5") goes before its title; `from` is where Menu and the finish go back to.
  function open(next, { level: levelIndex = null, from = null, label: where = null } = {}) {
    art = next; level = levelIndex; returnTo = from; label = where; total = art.pixels.filter(c => c >= 0).length; sparkles = []; ripples = []; drawOverlay();
    deps.showScreen('game');
    const saved = readSave(art.id);
    state = restore(art, saved) || createPuzzle(art);
    selection = Number.isInteger(saved?.selectedColor) && saved.selectedColor >= 0 && saved.selectedColor < art.colors.length
      ? continueSelection(art,state,{kind:'color',color:saved.selectedColor,cells:[]}) : null;
    cursor = 0; keyboard = false; zoom = 1; ox = oy = 0;
    constrain(); update();
    $('puzzleName').textContent = `${where ? `${where} · ` : ''}${art.title}`;
    message(`${where ? `${where}: ` : ''}${art.title}. Tap a jewel group, then the shelf.`);
  }
  $('menu').onclick = () => { if (!busy && !finishing) deps.leave(returnTo); };

  return {
    open,
    // The puzzle on screen, and how it was opened (to open it again just the same).
    current: () => art ? { art, level, from: returnTo, label } : null,
    isBusy: () => busy,
    say: message,
    // For tests: the camera, and what the overlay is showing.
    inspect: () => ({ view: { zoom, ox, oy }, sparkles: sparkles.map(s => s.i),
      ripples: ripples.map(r => ({ cells: r.cells.map(c => c.i), from: r.cells.find(c => c.delay === 0).i })) }),
  };
}
