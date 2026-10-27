// Talks to the picture generator running on the Mac (server/). The server checks
// the password, so it never appears in this public code; once accepted, it is
// remembered in this browser.
import { convertImage } from './convert.js';

// The generator's public HTTPS address: Tailscale Funnel to the Mac. Pages served
// from localhost use the local server. ?server= may point only at a server on this
// machine, so a link can never send the password (or the saves) anywhere else.
const PUBLIC_SERVER = 'https://hanmos-mac-studio.tail6c4683.ts.net';
const SERVER = 'little-jewel:generator-url', PASSWORD = 'little-jewel:generator-password';

const get = key => { try { return localStorage.getItem(key); } catch { return null; } };
const set = (key, value) => { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {} };

const onThisMachine = url => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url || '');
const override = new URLSearchParams(location.search).get('server')?.replace(/\/+$/, '');
if (onThisMachine(override)) set(SERVER, override);
const local = ['localhost', '127.0.0.1'].includes(location.hostname);
export const serverUrl = () => (onThisMachine(get(SERVER)) && get(SERVER)) || (local ? 'http://localhost:8787' : PUBLIC_SERVER);

export const unlocked = () => Boolean(get(PASSWORD));
export const forget = () => set(PASSWORD, null);

export class GeneratorError extends Error {
  constructor(message, status = 0, body = {}) { super(message); this.status = status; this.body = body; }
}

async function call(path, options = {}) {
  if (!serverUrl()) throw new GeneratorError('The generator is not set up yet.');
  let response;
  try {
    response = await fetch(serverUrl() + path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  } catch { throw new GeneratorError('The generator is offline right now.'); }
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) forget();
  if (!response.ok) throw new GeneratorError(body.error || 'Something went wrong.', response.status, body);
  return body;
}
const auth = () => ({ Authorization: `Bearer ${get(PASSWORD)}` });

export async function unlock(password) {
  await call('/api/unlock', { method: 'POST', body: JSON.stringify({ password }) });
  set(PASSWORD, password);
}

// The saves kept on the server: one copy shared by everyone with the password.
// Sending names the version it was based on; the server refuses (409) when another
// browser saved in between, and the caller merges again.
export const fetchSaves = () => call('/api/saves', { headers: auth() });
export const sendSaves = (data, version) => call('/api/saves', { method: 'PUT', headers: auth(), body: JSON.stringify({ version, data }) });

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Resolves with the candidate pictures; onStatus hears each step along the way.
export async function generate(prompt, onStatus) {
  const { id } = await call('/api/jobs', { method: 'POST', headers: auth(), body: JSON.stringify({ prompt }) });
  for (;;) {
    await pause(1500);
    const job = await call(`/api/jobs/${id}`, { headers: auth() });
    onStatus(job);
    if (job.status === 'done') return job;
    if (job.status === 'error') throw new GeneratorError(job.error || 'The picture could not be made.');
  }
}

export async function pictureToArt(src, options) {
  const image = new Image();
  image.src = src;
  await image.decode();
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  ctx.drawImage(image, 0, 0);
  return convertImage(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, options);
}
