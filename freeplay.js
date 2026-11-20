// Free play, on its own screen: four tabs (Your puzzles, Bonus, Gauntlet, Sent to you), each a
// grid of puzzle cards. Your puzzles has Create your own; Gauntlet has New gauntlet and your
// gauntlets (gauntlet.js). Also the puzzle cards other pop-ups list puzzles with.
// The screen's markup lives here; index.html only has its empty <main id="freePlayScreen">.
import { esc } from './dialog.js';
import { displayName, online, friendName, accountPrefs, updatePrefs } from './account.js';

const TABS = [['yours', 'Your puzzles'], ['bonus', 'Bonus'], ['gauntlet', 'Gauntlet'], ['sent', 'Sent to you']];

// A dot on the Bonus tab marks bonus puzzles not seen yet, until that tab is opened. Signed in,
// it's remembered with the account on the server (bonus_seen), so it follows the account to
// every browser; a guest's is remembered in this browser.
const BONUS_SEEN = 'little-jewel:bonus-seen';
function browserSeen() { try { return JSON.parse(localStorage.getItem(BONUS_SEEN)) || []; } catch { return []; } }
const bonusSeen = () => online() ? accountPrefs().bonus_seen || [] : browserSeen();

// deps: { $, showScreen(id), home(), thumbnail, progress, bonus: [puzzles], all() → your puzzles and sent ones,
//         remove(id), play(puzzle), create(), gauntlet(), inGauntlet(puzzle),
//         gauntletSection() → element, or null with no gauntlets (gauntlet.js) }
export function createFreePlay(deps) {
  const { $ } = deps;
  let tab = 'yours';
  $('freePlayScreen').innerHTML = `<header class="chat-top"><button id="freePlayBack" class="chat-back" aria-label="Back to the start screen">‹ Back</button><h1>Free play</h1></header>
    <nav class="tabs" role="tablist" aria-label="Free play">${TABS.map(([key, name]) => `<button role="tab" id="${key}Tab" aria-controls="freePlayBody">${name}${key === 'bonus' ? '<span class="tab-dot" id="bonusDot" aria-label="new" hidden></span>' : ''}</button>`).join('')}</nav>
    <div class="screen-body" id="freePlayBody" role="tabpanel"></div>`;
  for (const [key] of TABS) $(`${key}Tab`).onclick = () => render(key);
  $('freePlayBack').onclick = () => deps.home();

  // A puzzle as a card: picture, title, and how far along it is.
  function card(puzzle, onPick = () => { $('modal').close(); deps.play(puzzle); }) {
    const done = deps.progress(puzzle), element = document.createElement('div');
    const from = puzzle.from ? `from ${esc(displayName(puzzle.from))} · ` : '';
    element.className = 'puzzle-card';
    element.innerHTML = `<button class="puzzle-pick"><img alt="" src="${deps.thumbnail(puzzle)}"><span class="puzzle-title">${esc(puzzle.title)}</span><span class="puzzle-progress">${from}${done === null ? 'New' : done === 1 ? 'Complete' : `${Math.floor(done * 100)}%`}</span></button>`;
    element.querySelector('.puzzle-pick').onclick = onPick;
    return element;
  }
  function removable(puzzle) {
    const element = card(puzzle), remove = document.createElement('button');
    remove.className = 'puzzle-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${puzzle.title}`);
    remove.onclick = () => {
      if (!confirm(puzzle.from ? `Remove “${puzzle.title}” and your progress on it? It stays in your chat.` : `Remove “${puzzle.title}” and its progress?`)) return;
      deps.remove(puzzle.id); render(tab);
    };
    element.append(remove);
    return element;
  }
  const bonusWaiting = () => deps.bonus.some(puzzle => !bonusSeen().includes(puzzle.id));
  function seeBonus() {
    const ids = deps.bonus.map(puzzle => puzzle.id), all = [...new Set([...bonusSeen(), ...ids])];
    if (online()) updatePrefs({ bonus_seen: ids }, { bonus_seen: all }).catch(() => {});
    else try { localStorage.setItem(BONUS_SEEN, JSON.stringify(all)); } catch {}
  }
  // Signed in: what this browser saw as a guest counts for the account too.
  function adoptBrowserSeen() {
    const mine = accountPrefs().bonus_seen || [], extra = browserSeen().filter(id => !mine.includes(id));
    if (online() && extra.length) return updatePrefs({ bonus_seen: extra }, { bonus_seen: [...mine, ...extra] }).catch(() => {});
  }

  // One tab's cards; the other tabs are remembered as they were.
  function render(which) {
    tab = which;
    for (const [key] of TABS) $(`${key}Tab`).setAttribute('aria-selected', String(key === tab));
    const body = $('freePlayBody'), list = id => `<div class="puzzle-list" id="${id}"></div>`;
    const all = deps.all();
    if (tab === 'yours') {
      const mine = all.filter(a => !a.from && !deps.inGauntlet(a));
      body.innerHTML = `<button class="primary" id="createOwn">✦ Create your own</button>${mine.length ? list('puzzleList') : '<p>Nothing here yet. Describe a picture and it becomes a puzzle.</p>'}`;
      for (const puzzle of mine) $('puzzleList').append(removable(puzzle));
      $('createOwn').onclick = () => deps.create();
    } else if (tab === 'bonus') {
      if (bonusWaiting()) seeBonus();
      body.innerHTML = deps.bonus.length ? list('bonusList') : '<p>No bonus puzzles right now.</p>';
      for (const puzzle of deps.bonus) $('bonusList').append(card(puzzle));
    } else if (tab === 'gauntlet') {
      const section = deps.gauntletSection();
      body.innerHTML = `<button class="primary" id="gauntletStart">⚔ New gauntlet</button>${section ? '<div id="gauntletSection"></div>' : '<p>Five surprise puzzles, each painted from a random handful of words, played one after another.</p>'}`;
      if (section) $('gauntletSection').append(section);
      $('gauntletStart').onclick = () => deps.gauntlet();
    } else {
      const sent = all.filter(a => a.from), friend = friendName();
      body.innerHTML = sent.length ? list('sentList') : `<p>Puzzles ${friend ? esc(displayName(friend)) : 'a friend'} sends you in the chat land here.</p>`;
      for (const puzzle of sent) $('sentList').append(removable(puzzle));
    }
    $('bonusDot').hidden = !bonusWaiting();
    body.scrollTop = 0;
  }

  // Opens on the tab it was last on, or the one asked for.
  function open(which = tab) {
    deps.showScreen('freePlayScreen');
    render(which);
  }

  return { open, card, adoptBrowserSeen, isOpen: () => !$('freePlayScreen').hidden };
}
