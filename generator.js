// Makes pictures with the generator on the Mac (server/), for signed-in players, and
// turns a chosen picture into puzzle art in the browser.
import { convertImage } from './convert.js';
import { request, ServerError } from './account.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Resolves with the candidate pictures; onStatus hears each step along the way.
export async function generate(prompt, onStatus) {
  const { id } = await request('/api/jobs', { method: 'POST', body: { prompt } });
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
