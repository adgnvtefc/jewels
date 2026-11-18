// Runs the game's own convert.js for the server (generator.py), so a picture becomes exactly
// the puzzle the browser would have made from it. One long-lived process; one JSON request per
// line on stdin, one JSON reply per line on stdout:
//   in:  {"id": 1, "width": 256, "height": 256, "rgba": "<base64 RGBA bytes>", "options": {"title": "A cat"}}
//   out: {"id": 1, "art": {title, width, height, colors, pixels}}  or  {"id": 1, "error": "…"}
import { createInterface } from 'node:readline';
import { convertImage } from '../convert.js';

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let id = null;
  try {
    const request = JSON.parse(line);
    id = request.id;
    const rgba = new Uint8ClampedArray(Buffer.from(request.rgba, 'base64'));
    const { id: _, ...art } = convertImage(rgba, request.width, request.height, request.options || {});
    process.stdout.write(JSON.stringify({ id, art }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ id, error: String(error?.message || error) }) + '\n');
  }
}
