// The account: the name menu in the corner (Settings, signing out), and the pop-ups for signing
// in (and in again) and offering a guest's progress to the account. Accounts are invite-only and added on the Mac. A sign-in that ran out keeps
// the name (and this browser's copy of that account's progress) and asks only for the password.
import { currentAccount, displayName, signIn, signOut } from './account.js';
import { customPuzzles, addCustom, readSave, writeSave, snapshot, useProfile, withProfile, clearProfile, forget, jewelsHome } from './library.js';
import { unsent } from './sync.js';
import { esc } from './dialog.js';

// deps: { $, show, ask, track, syncNow() → Promise, refresh() → Promise (the account from the server),
//         chat: { reset, stop }, home(), settings(), shipped() → built-in puzzles }
export function createAccountUI(deps) {
  const { $, show } = deps;

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
        deps.track('login', { ok: true });
      } catch (error) {
        deps.track('login', { ok: false, status: error.status });
        $('signInNote').textContent = error.message; button.disabled = false; $('password').select();
        return;
      }
      await startAccount();
      if ($('modal').open) $('modal').close();
      deps.home();
      then?.();
    };
  }
  async function startAccount() {
    useProfile(currentAccount().name);
    deps.chat.reset();
    await deps.refresh();
    await deps.syncNow();
    await offerGuestProgress();
  }
  // This browser's guest progress can move into the account, once, if the player says so.
  async function offerGuestProgress() {
    const name = currentAccount()?.name, guest = withProfile(null, snapshot);
    const saves = Object.entries(guest.saves), custom = guest.custom;
    const ids = [...new Set([...saves.map(([id]) => id), ...custom.map(a => a.id)])];
    if (!ids.length) return;
    if (!await deps.ask(`Add this browser’s progress (${ids.length} puzzle${ids.length === 1 ? '' : 's'}) to ${displayName(name)}?`, 'Add it', 'Not now')) return;
    for (const puzzle of custom) if (!customPuzzles().some(a => a.id === puzzle.id)) addCustom(puzzle);
    const arts = new Map([...deps.shipped(), ...customPuzzles()].map(a => [a.id, a]));
    for (const [id, save] of saves) {
      const mine = readSave(id);
      if (!mine || jewelsHome(arts.get(id), save) > jewelsHome(arts.get(id), mine)) writeSave(id, save);
    }
    withProfile(null, () => forget(ids));
    deps.track('guest_progress_added', { puzzles: ids.length });
    await deps.syncNow();
  }

  // The corner button: signed in, it opens the name menu under it; otherwise the sign-in pop-up.
  function showMenu(open) {
    $('nameMenu').hidden = !open;
    $('accountButton').setAttribute('aria-expanded', String(open));
  }
  function menu() {
    const account = currentAccount();
    if (!account?.token) { showMenu(false); return signInPrompt(); }
    if (!$('nameMenu').hidden) return showMenu(false);
    $('nameMenuNote').textContent = `Signed in as ${displayName(account.name)}${unsent() ? ' · some progress is still on its way to the server' : ''}`;
    showMenu(true);
    $('openSettings').focus();
  }
  showMenu(false);
  $('openSettings').onclick = () => { showMenu(false); deps.settings(); };
  $('signOutHere').onclick = () => signOutFlow(false);
  $('signOutAll').onclick = () => signOutFlow(true);
  // A tap anywhere else, or Escape, closes the menu.
  document.addEventListener?.('click', e => {
    if (!$('nameMenu').hidden && !$('nameMenu').contains(e.target) && !$('accountButton').contains(e.target)) showMenu(false);
  });
  document.addEventListener?.('keydown', e => { if (e.key === 'Escape' && !$('nameMenu').hidden) { showMenu(false); $('accountButton').focus(); } });
  // Signing out sends what it can, then removes the account's copy from this browser.
  async function signOutFlow(everywhere) {
    showMenu(false);
    const account = currentAccount();
    if (!account) return;
    if (account.token) await deps.syncNow();
    if (unsent() && !confirm('Some progress hasn’t reached the server yet. Sign out and remove it from this browser anyway?')) return;
    await signOut(everywhere);
    deps.chat.stop();
    clearProfile(account.name);
    useProfile(null);
    deps.track('logout', { everywhere });
    if ($('modal').open) $('modal').close();
    deps.home();
  }

  return { menu, closeMenu: () => showMenu(false), signIn: signInPrompt };
}
