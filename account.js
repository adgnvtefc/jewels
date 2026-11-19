// Signing in, and every call to the server on the Mac (server/). The browser keeps a
// sign-in token, never the password. A token the server no longer accepts is dropped,
// but the name stays, so the game keeps that account's progress and asks to sign in again.

// The server's public HTTPS address: Tailscale Funnel to the Mac. Pages served from
// localhost use the local server. ?server= may point only at a server on this machine,
// so a link can never send a token (or the saves) anywhere else.
const PUBLIC_SERVER = 'https://hanmos-mac-studio.tail6c4683.ts.net';
const SERVER = 'little-jewel:generator-url', ACCOUNT = 'little-jewel:account';
const OLD_PASSWORD = 'little-jewel:generator-password';

const getItem = key => { try { return localStorage.getItem(key); } catch { return null; } };
const setItem = (key, value) => { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {} };

const onThisMachine = url => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url || '');
const override = new URLSearchParams(location.search).get('server')?.replace(/\/+$/, '');
if (onThisMachine(override)) setItem(SERVER, override);
const local = ['localhost', '127.0.0.1'].includes(location.hostname);
export const serverUrl = () => (onThisMachine(getItem(SERVER)) && getItem(SERVER)) || (local ? 'http://localhost:8787' : PUBLIC_SERVER);

// {name, token, friends, id, prefs}, or null for a guest. token is null when the account must sign
// in again. id and prefs come from the server (signIn, refreshAccount).
export function currentAccount() {
  try {
    const account = JSON.parse(getItem(ACCOUNT));
    return account && /^[a-z0-9]{1,20}$/.test(account.name) ? account : null;
  } catch { return null; }
}
export const online = () => Boolean(currentAccount()?.token);
export const friendName = () => currentAccount()?.friends?.[0] ?? null;
export const displayName = name => name ? name[0].toUpperCase() + name.slice(1) : '';

// The shared password from before accounts: true once (and forgotten) if this browser had it.
export function takeOldPassword() {
  if (getItem(OLD_PASSWORD) == null) return false;
  setItem(OLD_PASSWORD, null);
  return true;
}

export class ServerError extends Error {
  constructor(message, status = 0, body = {}) { super(message); this.status = status; this.body = body; }
}

let onSignedOut = () => {};
export function whenSignedOut(callback) { onSignedOut = callback; }

export async function request(path, { method = 'GET', body } = {}) {
  const account = currentAccount();
  let response;
  try {
    response = await fetch(serverUrl() + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...(account?.token ? { Authorization: `Bearer ${account.token}` } : {}) },
    });
  } catch { throw new ServerError('The server is offline right now.'); }
  const reply = await response.json().catch(() => ({}));
  if (response.status === 401 && account?.token && path !== '/api/login') {
    setItem(ACCOUNT, JSON.stringify({ ...account, token: null }));
    onSignedOut();
  }
  if (!response.ok) throw new ServerError(reply.error || 'Something went wrong.', response.status, reply);
  return reply;
}

export async function signIn(name, password) {
  const reply = await request('/api/login', { method: 'POST', body: { name, password } });
  setItem(ACCOUNT, JSON.stringify({ name: reply.name, token: reply.token, friends: reply.friends || [], id: reply.id }));
  return reply;
}

// Who the server says this account is: its id, friends and settings, kept with the account.
export async function refreshAccount() {
  if (!online()) return null;
  const me = await request('/api/me'), account = currentAccount();
  if (account?.name !== me.name) return null;  // signed out or switched meanwhile
  setItem(ACCOUNT, JSON.stringify({ ...account, id: me.id, friends: me.friends || [], prefs: me.prefs || {} }));
  return currentAccount();
}
// The account's settings (server/prefs.py). A change is kept here at once and sent to the server,
// which merges it (bonus_seen only ever grows) and answers with all of them.
export const accountPrefs = () => currentAccount()?.prefs || {};
export async function updatePrefs(change, local = change) {
  const account = currentAccount();
  if (!account?.token) return null;
  setItem(ACCOUNT, JSON.stringify({ ...account, prefs: { ...account.prefs, ...local } }));
  const prefs = await request('/api/prefs', { method: 'PUT', body: change });
  const now = currentAccount();
  if (now?.name === account.name) setItem(ACCOUNT, JSON.stringify({ ...now, prefs }));
  return prefs;
}

// Ends the session on the server (all of them with `everywhere`) and forgets the account here.
export async function signOut(everywhere = false) {
  if (online()) await request('/api/logout', { method: 'POST', body: { everywhere } }).catch(() => {});
  setItem(ACCOUNT, null);
}

export const api = {
  me: () => request('/api/me'),
  changes: since => request(`/api/saves?since=${since}`),
  putSaves: saves => request('/api/saves', { method: 'PUT', body: { saves } }),
  addPuzzle: art => request('/api/puzzles', { method: 'POST', body: { art } }),
  removePuzzle: id => request(`/api/puzzles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  messages: (query = '') => request(`/api/messages${query ? `?${query}` : ''}`),
  send: message => request('/api/messages', { method: 'POST', body: message }),
  markRead: (friend, upTo) => request('/api/messages/read', { method: 'POST', body: { friend, up_to: upTo } }),
  notifications: () => request('/api/notifications'),
  setNotifications: change => request('/api/notifications', { method: 'PUT', body: change }),
};
