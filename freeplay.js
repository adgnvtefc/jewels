// Free play: the bonus puzzles, puzzles sent to you, pictures you made, and the ways to make
// more (Create your own, the gauntlet). Also the puzzle cards other pop-ups list puzzles with,
// and the "Play the bonus ones here!" pop-up under the start screen's Free play button.
import { esc } from './dialog.js';
import { displayName, online, accountPrefs, updatePrefs } from './account.js';

// A pop-up under Free play points at the bonus puzzles until Free play has been opened
// with them in it, and again whenever new ones arrive. Signed in, it's remembered with the
// account on the server (bonus_seen), so it follows the account to every browser; a guest's
// is remembered in this browser.
const BONUS_SEEN = 'little-jewel:bonus-seen';
function browserSeen() { try { return JSON.parse(localStorage.getItem(BONUS_SEEN)) || []; } catch { return []; } }
const bonusSeen = () => online() ? accountPrefs().bonus_seen || [] : browserSeen();

// deps: { $, show, thumbnail, progress, bonus: [puzzles], all() → your puzzles and sent ones,
//         remove(id), play(puzzle), create(), gauntlet() }
export function createFreePlay(deps) {
  const { $, show } = deps;

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
      deps.remove(puzzle.id); open();
    };
    element.append(remove);
    return element;
  }
  function seeBonus() {
    const ids = deps.bonus.map(puzzle => puzzle.id), all = [...new Set([...bonusSeen(), ...ids])];
    if (online()) updatePrefs({ bonus_seen: ids }, { bonus_seen: all }).catch(() => {});
    else try { localStorage.setItem(BONUS_SEEN, JSON.stringify(all)); } catch {}
    $('bonusTip').hidden = true;
  }
  // Signed in: what this browser saw as a guest counts for the account too.
  function adoptBrowserSeen() {
    const mine = accountPrefs().bonus_seen || [], extra = browserSeen().filter(id => !mine.includes(id));
    if (online() && extra.length) return updatePrefs({ bonus_seen: extra }, { bonus_seen: [...mine, ...extra] }).catch(() => {});
  }

  function open() {
    const all = deps.all(), sent = all.filter(a => a.from), mine = all.filter(a => !a.from);
    show(`<p class="eyebrow">FREE PLAY</p>${deps.bonus.length ? '<h2>Bonus</h2><div class="puzzle-list" id="bonusList"></div>' : ''}${sent.length ? '<h2>Sent to you</h2><div class="puzzle-list" id="sentList"></div>' : ''}<h2>Your puzzles</h2>${mine.length ? '<div class="puzzle-list" id="puzzleList"></div>' : '<p>Nothing here yet. Describe a picture and it becomes a puzzle.</p>'}<button class="primary" id="createOwn">✦ Create your own</button><button class="home-button" id="gauntletStart">⚔ Gauntlet: 5 surprise puzzles</button>`);
    if (deps.bonus.length) seeBonus();
    for (const puzzle of deps.bonus) $('bonusList').append(card(puzzle));
    for (const puzzle of sent) $('sentList').append(removable(puzzle));
    for (const puzzle of mine) $('puzzleList').append(removable(puzzle));
    $('createOwn').onclick = () => deps.create();
    $('gauntletStart').onclick = () => deps.gauntlet();
  }

  return { open, card, adoptBrowserSeen, bonusWaiting: () => deps.bonus.some(puzzle => !bonusSeen().includes(puzzle.id)) };
}
