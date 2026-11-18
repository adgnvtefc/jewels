// Settings, on their own screen (signed in only): Chat notifications, which chat events text
// you, saved on the server per account. The screen's markup lives here; index.html only
// has its empty <main id="settings">.
import { api, online } from './account.js';

const NOTIFY = { notifyMessages: 'messages', notifyPuzzles: 'puzzles', notifyFinished: 'finished' };  // checkbox -> setting

// deps: { $, track, showScreen(name), home() }
export function createSettings(deps) {
  const { $ } = deps;
  $('settings').innerHTML = `<header class="chat-top"><button id="settingsBack" class="chat-back" aria-label="Back to the start screen">‹ Back</button><h1>Settings</h1></header>
    <section class="settings-section" aria-labelledby="notifyTitle">
      <h2 id="notifyTitle">Chat notifications</h2>
      <p>Get a text when one of these is still unread 10 minutes later.</p>
      <label class="setting"><input type="checkbox" id="notifyMessages" disabled> New messages</label>
      <label class="setting"><input type="checkbox" id="notifyPuzzles" disabled> New puzzles</label>
      <label class="setting"><input type="checkbox" id="notifyFinished" disabled> A puzzle you sent is finished</label>
      <p id="settingsStatus" class="settings-status" role="status"></p>
    </section>`;
  const boxes = () => Object.entries(NOTIFY).map(([id, setting]) => [$(id), setting]);
  const say = text => { $('settingsStatus').textContent = text; };
  function showSettings(settings) { for (const [box, setting] of boxes()) { box.checked = settings[setting]; box.disabled = false; } }

  async function open() {
    if (!online()) return deps.home();
    deps.showScreen('settings');
    for (const [box] of boxes()) box.disabled = true;
    say('Loading…');
    try { showSettings(await api.notifications()); say(''); }
    catch (error) { say(error.message || 'Couldn’t load your settings.'); }
  }
  for (const [box, setting] of boxes()) box.onchange = async () => {
    const change = { [setting]: box.checked };
    box.disabled = true;
    try { showSettings(await api.setNotifications(change)); say('Saved.'); deps.track('notify_setting', change); }
    catch (error) { box.checked = !box.checked; box.disabled = false; say(error.message || 'Couldn’t save that. Try again.'); }
  };
  $('settingsBack').onclick = () => deps.home();
  return { open };
}
