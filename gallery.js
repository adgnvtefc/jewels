// Gallery: every finished picture, levels first, then the bonus ones, then your own.
import { esc } from './dialog.js';

// deps: { show, thumbnail, progress, levels: [puzzles], library() → every puzzle, levels first }
export function createGallery(deps) {
  function open() {
    const done = deps.library().filter(puzzle => deps.progress(puzzle) === 1);
    const name = puzzle => { const n = deps.levels.indexOf(puzzle); return n < 0 ? esc(puzzle.title) : `Level ${n + 1}`; };
    deps.show(`<p class="eyebrow">GALLERY</p><h2>Finished pictures</h2>${done.length
      ? `<div class="puzzle-list">${done.map(puzzle => `<figure class="gallery-item"><img alt="${esc(puzzle.title)}" src="${deps.thumbnail(puzzle)}"><figcaption>${name(puzzle)}</figcaption></figure>`).join('')}</div>`
      : '<p>Finish a puzzle and it will hang here.</p>'}`);
  }
  return { open };
}
