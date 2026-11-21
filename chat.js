// The chat screen: messages with your friend, sent puzzles, and "finished" notices.
// Messages are always shown as text (textContent), never as HTML. New ones are fetched
// every few seconds while the chat is open, once a minute otherwise, and never while the
// page is hidden. The latest 200 are kept in this browser, so the chat opens instantly.
import { api, online, currentAccount, friendName, displayName } from './account.js';

const KEEP = 200, OPEN_EVERY = 3000, CLOSED_EVERY = 60000;
const clientId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

// deps: { $, thumbnail, progress, findArt(id), openArt(art, maker), onUnread(count), onPuzzleNews(), say(text) }
export function createChat(deps) {
  const { $ } = deps;
  let messages = [], arts = {}, start = false, pending = [], unreadCount = 0;
  let timer = null, opened = false, loadingOlder = false, readUpTo = 0;
  const cacheKey = () => `little-jewel:${currentAccount()?.name}:chat`;

  function load() {
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey())) || {};
      messages = Array.isArray(cached.messages) ? cached.messages : [];
      arts = cached.arts && typeof cached.arts === 'object' ? cached.arts : {};
      start = cached.start === true && messages.length < KEEP;
    } catch { messages = []; arts = {}; start = false; }
    pending = []; unreadCount = 0; readUpTo = 0;
  }
  function store() {
    const recent = messages.slice(-KEEP), used = new Set(recent.map(m => m.puzzle));
    const keptArts = Object.fromEntries(Object.entries(arts).filter(([id]) => used.has(id)));
    try { localStorage.setItem(cacheKey(), JSON.stringify({ messages: recent, arts: keptArts, start: start && messages.length <= KEEP })); } catch {}
  }
  function absorb(reply, older = false) {
    Object.assign(arts, reply.puzzles || {});
    const known = new Set(messages.map(m => m.id));
    const fresh = (reply.messages || []).filter(m => !known.has(m.id));
    // A sent puzzle or a finished one changes Free play and progress: fetch those too.
    if (fresh.some(m => m.kind !== 'text')) deps.onPuzzleNews?.();
    messages = older ? [...fresh, ...messages] : [...messages, ...fresh];
    messages.sort((a, b) => a.id - b.id);
    pending = pending.filter(p => !messages.some(m => m.client_id === p.client_id && m.from === currentAccount()?.name));
    if (typeof reply.unread === 'number') setUnread(reply.unread);
    return fresh.length;
  }
  function setUnread(count) { unreadCount = count; deps.onUnread(count); }

  // Fetch what's new; render and mark read if the chat is on screen.
  async function poll() {
    if (!online()) return;
    const last = messages.at(-1)?.id;
    const reply = await api.messages(last ? `after=${last}` : '');
    if (!last) start = reply.start === true;
    if (last && reply.messages?.length >= KEEP) { messages = []; start = false; }  // a big gap: start over from the newest
    const fresh = absorb(reply);
    if (fresh || !last) store();
    if (opened) { if (fresh) render(); markRead(); }
  }
  function schedule(now = false) {
    clearTimeout(timer); timer = null;
    if (!online() || document.visibilityState === 'hidden') return;
    timer = setTimeout(async () => { try { await poll(); } catch {} schedule(); }, now ? 0 : opened ? OPEN_EVERY : CLOSED_EVERY);
  }
  document.addEventListener?.('visibilitychange', () => schedule(true));

  async function markRead() {
    const me = currentAccount()?.name, friend = friendName();
    const last = messages.filter(m => m.to === me).at(-1)?.id || 0;
    if (!friend || last <= readUpTo || document.visibilityState === 'hidden') return;
    readUpTo = last;
    try { setUnread((await api.markRead(friend, last)).unread); } catch {}
  }

  async function loadOlder() {
    if (start || loadingOlder || !messages.length || !online()) return;
    loadingOlder = true;
    const list = $('chatMessages'), from = list.scrollHeight - list.scrollTop;
    try {
      const reply = await api.messages(`before=${messages[0].id}`);
      start = reply.start === true;
      absorb(reply, true);
      render(false);
      list.scrollTop = list.scrollHeight - from;
    } catch {} finally { loadingOlder = false; }
  }

  const time = at => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = at => new Date(at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }
  function puzzleButton(art, maker, className, lines) {
    const button = node('button', className);
    const image = node('img'); image.alt = ''; image.src = deps.thumbnail(art);
    button.append(image);
    const words = node('span', 'chat-card-words');
    for (const [cls, text] of lines) words.append(node('span', cls, text));
    button.append(words);
    button.onclick = () => deps.openArt(art, maker);
    return button;
  }
  function bubble(message) {
    const me = currentAccount()?.name, mine = message.from === me;
    const item = node('li', `chat-message ${message.kind === 'finished' ? 'chat-note' : mine ? 'mine' : 'theirs'}`);
    const art = message.puzzle && (deps.findArt(message.puzzle) || arts[message.puzzle]);
    if (message.kind === 'text') {
      item.append(node('p', 'chat-text', message.text));
    } else if (message.kind === 'puzzle' && art) {
      const finished = messages.find(m => m.kind === 'finished' && m.puzzle === message.puzzle && m.from === message.to);
      const done = deps.progress(art);
      const status = mine
        ? finished ? `${displayName(message.to)} finished it${finished.moves ? ` in ${finished.moves} moves` : ''}` : 'Sent'
        : done === null ? 'Not started' : done === 1 ? 'Finished' : `${Math.floor(done * 100)}%`;
      item.append(puzzleButton(art, message.from, 'chat-card', [['chat-card-title', art.title], ['chat-card-sub', mine ? status : `from ${displayName(message.from)} · ${status}`]]));
    } else if (message.kind === 'finished' && art) {
      const who = mine ? 'You' : displayName(message.from);
      item.append(puzzleButton(art, message.to, 'chat-finished', [['chat-card-title', `${who} finished ${art.title}${message.moves ? ` in ${message.moves} moves` : ''}`]]));
    } else {
      item.append(node('p', 'chat-text chat-missing', 'A puzzle that is no longer here.'));
    }
    if (message.status) {
      const state = node(message.status === 'failed' ? 'button' : 'span', 'chat-status', message.status === 'failed' ? 'Not sent · Retry' : 'Sending…');
      if (message.status === 'failed') state.onclick = () => deliver(message);
      item.append(state);
    }
    return item;
  }
  function render(stick = true) {
    const list = $('chatMessages');
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const items = [];
    items.push(node('li', 'chat-day', start ? (messages.length || pending.length ? 'The start of your chat' : `Say hi to ${displayName(friendName())}!`) : 'Scroll up for older messages'));
    let previous = null;
    for (const message of [...messages, ...pending]) {
      const at = message.at || Date.now();
      if (!previous || day(previous) !== day(at)) items.push(node('li', 'chat-day', day(at)));
      else if (at - previous > 10 * 60 * 1000) items.push(node('li', 'chat-day', time(at)));
      previous = at;
      items.push(bubble(message));
    }
    list.replaceChildren(...items);
    if (stick && (atBottom || !opened)) list.scrollTop = list.scrollHeight;
  }

  async function deliver(message) {
    message.status = 'sending'; render();
    try {
      const reply = await api.send({ to: friendName(), client_id: message.client_id, ...(message.kind === 'text' ? { text: message.text } : { puzzle: message.puzzle }) });
      if (reply.art) arts[reply.art.id] = reply.art;
      pending = pending.filter(p => p !== message);
      absorb({ messages: [reply.message] });
      store();
    } catch (error) {
      message.status = 'failed';
      if (error.status === 400 || error.status === 403) { pending = pending.filter(p => p !== message); deps.say?.(error.message); }
    }
    render();
  }
  function queue(fields) {
    const message = { ...fields, from: currentAccount()?.name, to: friendName(), client_id: clientId(), at: Date.now(), status: 'sending' };
    pending.push(message);
    return deliver(message);
  }

  $('chatForm').onsubmit = e => {
    e.preventDefault();
    const text = $('chatText').value.trim();
    if (!text || !friendName()) return;
    $('chatText').value = '';
    queue({ kind: 'text', text });
  };
  $('chatText').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('chatForm').requestSubmit(); } };
  $('chatMessages').onscroll = () => { if ($('chatMessages').scrollTop < 60) loadOlder(); };
  const glide = glideWithKeyboard($);

  return {
    // Signed in (or out): start over with this account's cached chat.
    reset() { load(); setUnread(0); schedule(true); },
    stop() { clearTimeout(timer); timer = null; opened = false; setUnread(0); },
    open() {
      opened = true;
      $('chatTitle').textContent = displayName(friendName());
      render(); $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
      markRead(); schedule(true);
    },
    close() { glide.reset(); if (!opened) return; opened = false; schedule(); },
    refresh() { if (opened) render(false); },
    sendPuzzle(puzzleId) { return queue({ kind: 'puzzle', puzzle: puzzleId }); },
    unread: () => unreadCount,
  };
}

// The on-screen keyboard. On a phone it covers the bottom of the screen; left alone, Safari
// scrolls the page late and in a jerk to show the message box. Instead, as the box is tapped,
// the whole chat slides up by the keyboard's height, timed like the keyboard so the two rise
// together (as in a native chat app), and Safari is kept from scrolling. The header goes off the
// top while typing; the newest message stays just above the box. Closing the keyboard slides it
// back. The keyboard's height is a guess the first time, then measured and remembered.
const KEYBOARD_HEIGHT = 'little-jewel:keyboard-height';
const GLIDE = 'transform 320ms cubic-bezier(0.38, 0.7, 0.125, 1) 60ms';  // the keyboard's own pace
function glideWithKeyboard($) {
  const view = globalThis.visualViewport, chat = $('chat'), box = $('chatText');
  if (!view) return { reset() {} };
  let keyboard = 0, target = 0, check = null;
  try { keyboard = Number(localStorage.getItem(KEYBOARD_HEIGHT)) || 0; } catch {}
  keyboard ||= Math.round(screen.height * 0.38);
  // The chat's lift, less anything Safari scrolled anyway, so the two always add up to the
  // keyboard's height and nothing jumps.
  function place(animate = true) {
    const lift = Math.max(0, target - scrollY - view.offsetTop);
    chat.style.transition = animate ? GLIDE : 'none';
    chat.style.transform = lift ? `translateY(${-lift}px)` : '';
  }
  function lift(px) {
    target = px; place();
    clearTimeout(check);
    // No keyboard came up (a hardware keyboard, say): settle back down.
    if (px) check = setTimeout(() => { if (innerHeight - view.height - view.offsetTop < 100) { target = 0; place(); } }, 900);
  }
  // A tap on the box: lift the chat and focus the box ourselves, so Safari doesn't scroll it
  // into view. Only touch does this; a mouse or a tab key focuses as usual, with no lift.
  box.addEventListener('touchend', e => {
    if (document.activeElement === box || chat.hidden) return;
    e.preventDefault();
    lift(keyboard);
    box.focus({ preventScroll: true });
  }, { passive: false });
  box.addEventListener('blur', () => lift(0));
  // Once the keyboard is up its real height is known: match it, and remember it.
  view.addEventListener('resize', () => {
    const measured = Math.round(innerHeight - view.height - view.offsetTop);
    if (document.activeElement !== box || !target || measured < 100 || measured > screen.height * 0.6) return;
    clearTimeout(check);
    if (measured !== keyboard) { keyboard = measured; try { localStorage.setItem(KEYBOARD_HEIGHT, String(measured)); } catch {} }
    lift(measured);
  });
  addEventListener('scroll', () => { if (target) place(false); });
  view.addEventListener('scroll', () => { if (target) place(false); });
  return { reset() { clearTimeout(check); target = 0; chat.style.transition = 'none'; chat.style.transform = ''; } };
}
