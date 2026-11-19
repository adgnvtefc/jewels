// The account pop-ups: signing in (and in again), offering a guest's progress to the account,
// and signing out. Accounts are invite-only and added on the Mac. A sign-in that ran out keeps
// the name (and this browser's copy of that account's progress) and asks only for the password.
import { currentAccount, displayName, signIn, signOut } from './account.js';
import { customPuzzles, addCustom, readSave, writeSave, snapshot, useProfile, withProfile, clearProfile, forget, jewelsHome } from './library.js';
import { unsent } from './sync.js';
import { esc } from './dialog.js';

// deps: { $, show, ask, track, syncNow() → Promise, refresh() → Promise (the account from the server),
//         chat: { reset, stop }, home(), shipped() → built-in puzzles }
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

  // The corner button: who is signed in, or the sign-in pop-up.
  function menu() {
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

  return { menu, signIn: signInPrompt };
}
