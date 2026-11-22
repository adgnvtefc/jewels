import { builtInPuzzles, customPuzzles, addCustom, removeCustom, progress, thumbnail, readSave, snapshot, mergeSaves, storeSnapshot, packSaves, unpackSaves, useProfile, withProfile, syncMeta } from './library.js';
import { currentAccount, online, friendName, displayName, takeOldPassword, whenSignedOut, refreshAccount } from './account.js';
import { createMaker } from './create.js';
import { createGauntlet } from './gauntlet.js';
import { syncAccount } from './sync.js';
import { createChat } from './chat.js';
import { createDialog, esc } from './dialog.js';
import { createSettings } from './settings.js';
import { createFreePlay } from './freeplay.js';
import { createGallery } from './gallery.js';
import { createAccountUI } from './account-ui.js';
import { createBoard } from './board.js';
const $ = id => document.getElementById(id);
const { show, ask } = createDialog($);
// Analytics (catseye, embedded in index.html); a no-op when the embed is absent, as in tests.
// Signed in, every event carries the account's id (never its name), so events can be told
// apart by account; a guest's carry none.
const track = (name, data) => {
  const id = online() ? currentAccount()?.id : null;
  globalThis.catseye?.(name, id ? { ...data, account: id } : data);
};
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
// Before accounts, one shared password unlocked the game; its saves now live in account 1
// on the server. A browser that still has that password forgets it, along with the marker
// older versions kept of which saves were the shared copy.
takeOldPassword();
try { localStorage.removeItem('little-jewel:shared-v91'); } catch {}
useProfile(currentAccount()?.name);
const library = () => [...shipped(), ...customPuzzles()];
// The puzzle on screen (board.js).
const board = createBoard({ $, showScreen, saved: () => syncSoon(), finished: finishPuzzle, leave: leaveGame });
// Opens a puzzle, labelled as a level or a gauntlet's puzzle; `from` is where it returns to.
function openPuzzle(puzzle, level = null, from = null) {
  board.open(puzzle, { level, from, label: level !== null ? `Level ${level + 1}` : from === 'gauntlet' ? gauntlet.label(puzzle) : null });
}
// A finished puzzle: the gauntlet's next one, or the picture and the way back.
function finishPuzzle(art, moves, { level, from }) {
  track('level_complete', { puzzle: art.id, title: art.title, custom: !builtIns.some(a => a.id === art.id), moves, colors: art.colors.length, jewels: art.pixels.filter(c => c >= 0).length });
  syncSoon(0);
  if (from === 'gauntlet') return gauntlet.finished(art);
  const heading = art.id === 'love-garden-v1' ? 'Made with love.' : esc(art.title);
  const eyebrow = level === null ? 'EVERY JEWEL, BACK HOME' : `LEVEL ${level + 1} COMPLETE`;
  // However the dialog closes, a finished puzzle returns to where it was opened from.
  show(`<p class="eyebrow">${eyebrow}</p><h2>${heading}</h2><p>You restored the picture in ${moves} moves.</p><img src="${thumbnail(art, 8)}" alt="Your completed artwork"><button class="primary" id="keep">${from === 'chat' ? 'Back to chat' : from === 'freeplay' ? 'Back to Free play' : 'Back to start'}</button>`, () => leaveGame(from));
  $('keep').onclick = () => $('modal').close();
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
      const shown = board.current();
      if (!$('game').hidden && shown && replaced.includes(shown.art.id) && !board.isBusy()) {
        board.open(shown.art, shown);
        board.say('Picked up from your other device.');
      }
      if (!$('home').hidden && !$('modal').open) goHome();
      chat.refresh();
      return true;
    } catch { return false; } finally { syncing = null; }
  })();
}
document.addEventListener?.('visibilitychange', () => { if (document.visibilityState === 'hidden') syncNow(); else syncSoon(0); });

// The screens: the start screen (home), the board (game), the chat, Free play, the gallery and
// settings. Reloading always starts at home.
const SCREENS = ['home', 'game', 'chat', 'freePlayScreen', 'galleryScreen', 'settings'];
function showScreen(name) {
  for (const id of SCREENS) $(id).hidden = id !== name;
  if (name !== 'home') accountUI.closeMenu();
}
function goHome() {
  showScreen('home'); chat.close();
  const next = nextLevel();
  $('levels').innerHTML = builtIns.map((puzzle, n) => {
    const done = progress(puzzle) === 1;
    const label = `Level ${n + 1}${done ? ', complete' : n === next ? ', next' : ''}`;
    return `<li class="level-pip${done ? ' done' : n === next ? ' current' : ''}" aria-label="${label}">${done ? `<img alt="" src="${thumbnail(puzzle)}">` : ''}</li>`;
  }).join('');
  $('startGame').disabled = next < 0;
  $('startLevel').textContent = next < 0 ? 'All levels complete' : `Level ${next + 1} of ${builtIns.length}`;
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
// A puzzle returns to where it was opened: the chat, or Free play (a gauntlet's to its tab).
function leaveGame(from) {
  if (from === 'chat' && online()) openChat();
  else if (from === 'freeplay' || from === 'gauntlet') freePlay.open(from === 'gauntlet' ? 'gauntlet' : undefined);
  else goHome();
}
// Levels are the built-in puzzles, in order; the next one is the first not yet finished.
const nextLevel = () => builtIns.findIndex(puzzle => progress(puzzle) !== 1);
$('startGame').onclick = () => { const next = nextLevel(); if (next >= 0) openPuzzle(builtIns[next], next); };


// Free play and the gallery, each on its own screen (freeplay.js, gallery.js).
const freePlay = createFreePlay({
  $, showScreen, home: () => goHome(), thumbnail, progress, bonus, all: customPuzzles,
  remove: id => { removeCustom(id); syncSoon(0); },
  play: puzzle => openPuzzle(puzzle, null, 'freeplay'),
  create: () => maker.start(),
  gauntlet: () => gauntlet.start(),
  inGauntlet: puzzle => gauntlet.isMember(puzzle),
  gauntletSection: () => gauntlet.section(),
});
$('freePlay').onclick = () => freePlay.open();
$('createHome').onclick = () => maker.start();
const gallery = createGallery({ $, show, showScreen, home: () => goHome(), track, thumbnail, progress, levels: builtIns, library });
$('gallery').onclick = () => gallery.open();

// Signing in and out (account-ui.js).
const accountUI = createAccountUI({ $, show, ask, track, syncNow, refresh: () => refreshAccountState(), chat: { reset: () => chat.reset(), stop: () => chat.stop() }, home: () => goHome(), settings: () => settings.open(), shipped });
const signInPrompt = options => accountUI.signIn(options);
$('accountButton').onclick = () => accountUI.menu();

// The chat with your friend, on its own screen.
function openChat() {
  if (!online()) return goHome();
  showScreen('chat');
  $('chatStatus').textContent = '';
  chat.open();
}
$('chatButton').onclick = openChat;
$('chatBack').onclick = goHome;

// Settings, on their own screen, from the name menu (settings.js).
const settings = createSettings({ $, track, showScreen, home: () => goHome() });
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
  const mine = customPuzzles().filter(a => !a.from && gauntlet.revealed(a));  // never a gauntlet puzzle still hidden
  show(`<p class="eyebrow">SEND A PUZZLE</p><h2>Your puzzles</h2><button class="primary" id="pickCreate">✦ Create puzzle</button>${mine.length ? '<div class="puzzle-list" id="pickList"></div>' : '<p>Nothing here yet. Create one, then send it.</p>'}`);
  for (const puzzle of mine) $('pickList').append(freePlay.card(puzzle, () => { $('modal').close(); sendPuzzle(puzzle); }));
  // A puzzle made from here can go straight to the chat (Send to chat), or wait in this list.
  $('pickCreate').onclick = () => maker.start({ send: puzzle => sendPuzzle(puzzle) });
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
// Pinching zooms the board (pointer events above), never the page: Safari ignores
// maximum-scale, so its own pinch gestures are turned down here.
for (const type of ['gesturestart', 'gesturechange']) document.addEventListener?.(type, e => e.preventDefault(), { passive: false });

// Making a puzzle: the same pop-up from the start screen, Free play and the chat (create.js).
// Keep a newly made puzzle in Free play and send it to the server.
const keepMade = puzzle => { if (customPuzzles().some(a => a.id === puzzle.id)) return true; if (!addCustom(puzzle)) return false; syncSoon(0); return true; };
const maker = createMaker({
  $, show, esc, thumbnail, track,
  keep: keepMade,
  play: puzzle => openPuzzle(puzzle, null, !$('chat').hidden ? 'chat' : freePlay.isOpen() ? 'freeplay' : null),
  freePlay: () => { $('modal').close(); freePlay.open('yours'); },
  signIn: (note, then) => signInPrompt({ note, then }),
});

// The gauntlet: five word-soup puzzles in a row, from Free play (gauntlet.js).
const gauntlet = createGauntlet({
  $, show, esc, thumbnail, track,
  all: customPuzzles,
  done: puzzle => progress(puzzle) === 1,
  card: (puzzle, onPick) => freePlay.card(puzzle, onPick),
  movesOf: puzzle => readSave(puzzle.id)?.moves || 0,
  keep: keepMade,
  play: puzzle => openPuzzle(puzzle, null, 'gauntlet'),
  signIn: (note, then) => signInPrompt({ note, then }),
  back: () => freePlay.open('gauntlet'),
});

// The old Add to Home Screen pop-up is gone; forget whether it was shown.
try { localStorage.removeItem('little-jewel:home-screen-hint'); } catch {}
// Gauntlets are now known from their puzzles' ids; the old per-browser record isn't needed.
try { for (let i = localStorage.length - 1; i >= 0; i--) { const key = localStorage.key(i); if (key?.endsWith(':gauntlet')) localStorage.removeItem(key); } } catch {}

// The account as the server knows it (id, friends, settings), on every load and sign-in.
async function refreshAccountState() {
  try { await refreshAccount(); await freePlay.adoptBrowserSeen(); } catch { return; }
  if (!$('home').hidden && !$('modal').open) goHome();
}

if (online()) chat.reset();
goHome();
syncNow();
refreshAccountState();
