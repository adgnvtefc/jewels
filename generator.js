// Asks the Mac (server/generator.py) for puzzles, for signed-in players.
import { convertImage } from './convert.js';
import { request, ServerError } from './account.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Asks the Mac for puzzles and resolves with the finished job; onStatus hears each step.
//   requestPuzzles('create', idea, onStatus, photo?) → job.candidates: [{ variant, art }], four to choose from;
//                                    photo: a JPEG data: URL, sent with this request only
//   requestPuzzles('gauntlet')       → job.puzzles: [{ words, subject, art }], five in a row
// The Mac makes the puzzle art itself (server/generator.py); pictureToArt is only for
// pictures from an older server.
export async function requestPuzzles(kind, idea, onStatus, photo = null) {
  const { id } = kind === 'gauntlet'
    ? await request('/api/gauntlet', { method: 'POST', body: {} })
    : await request('/api/jobs', { method: 'POST', body: { prompt: idea, ...(photo && { photo }) } });
  return follow(id, onStatus);
}
async function follow(id, onStatus) {
  for (;;) {
    await pause(1500);
    const job = await request(`/api/jobs/${id}`);
    onStatus(job);
    if (job.status === 'done') return job;
    if (job.status === 'error') throw new ServerError(job.error || 'The picture could not be made.');
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
