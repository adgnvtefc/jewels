// Gallery, on its own screen: every finished picture, levels first, then the bonus ones, then
// your own. Tapping one shows it large, with Save to camera roll: on a phone that opens the
// share sheet (Save Image puts it in Photos); elsewhere the picture downloads as a PNG.
// The screen's markup lives here; index.html only has its empty <main id="galleryScreen">.
import { esc } from './dialog.js';

const SAVE_SIZE = 1024;  // the saved picture's longer side, about, in pixels

// The picture as a PNG file, each jewel a crisp square, on white.
function pictureFile(art) {
  const scale = Math.max(1, Math.floor(SAVE_SIZE / Math.max(art.width, art.height)));
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
  canvas.width = art.width * scale; canvas.height = art.height * scale;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  art.pixels.forEach((c, i) => {
    if (c < 0) return;
    ctx.fillStyle = art.colors[c];
    ctx.fillRect(i % art.width * scale, Math.floor(i / art.width) * scale, scale, scale);
  });
  const name = `${String(art.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'picture'}.png`;
  return new Promise(resolve => canvas.toBlob ? canvas.toBlob(blob => resolve(blob && new File([blob], name, { type: 'image/png' })), 'image/png') : resolve(null));
}

// deps: { $, show, showScreen(id), home(), track, thumbnail, progress, levels: [puzzles], library() → every puzzle, levels first }
export function createGallery(deps) {
  const { $ } = deps;
  $('galleryScreen').innerHTML = `<header class="chat-top"><button id="galleryBack" class="chat-back" aria-label="Back to the start screen">‹ Back</button><h1>Gallery</h1></header>
    <div class="screen-body" id="galleryBody"></div>`;
  $('galleryBack').onclick = () => deps.home();
  const name = puzzle => { const n = deps.levels.indexOf(puzzle); return n < 0 ? puzzle.title : `Level ${n + 1} · ${puzzle.title}`; };

  function open() {
    deps.showScreen('galleryScreen');
    const done = deps.library().filter(puzzle => deps.progress(puzzle) === 1);
    $('galleryBody').innerHTML = done.length ? '<div class="puzzle-list" id="galleryList"></div>' : '<p>Finish a puzzle and it will hang here.</p>';
    for (const puzzle of done) {
      const item = document.createElement('button');
      item.className = 'gallery-item';
      item.innerHTML = `<img alt="" src="${deps.thumbnail(puzzle)}"><span class="puzzle-title">${esc(name(puzzle))}</span>`;
      item.onclick = () => picture(puzzle);
      $('galleryList').append(item);
    }
    $('galleryBody').scrollTop = 0;
  }

  // One picture, large, and the way to keep it. The file is made as the pop-up opens, so the
  // tap on Save can open the share sheet straight away (Safari only allows that right after a tap).
  function picture(puzzle) {
    const n = deps.levels.indexOf(puzzle), file = pictureFile(puzzle);
    deps.show(`<p class="eyebrow">${n < 0 ? 'FREE PLAY' : `LEVEL ${n + 1}`}</p><h2>${esc(puzzle.title)}</h2><img src="${deps.thumbnail(puzzle, 12)}" alt="${esc(puzzle.title)}"><button class="primary" id="savePicture">Save to camera roll</button><p class="save-note" id="saveNote" role="status"></p>`);
    let ready = null;
    file.then(made => { ready = made; });
    $('savePicture').onclick = async () => {
      const made = ready || await file;
      if (!made) { $('saveNote').textContent = 'This browser can’t save the picture.'; return; }
      if (navigator.canShare?.({ files: [made] })) {
        try { await navigator.share({ files: [made] }); deps.track('picture_saved', { puzzle: puzzle.id, via: 'share' }); }
        catch (error) { if (error?.name !== 'AbortError') $('saveNote').textContent = 'Couldn’t open the share sheet. Try again.'; }
        return;
      }
      const link = document.createElement('a'), url = URL.createObjectURL(made);
      link.href = url; link.download = made.name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      $('saveNote').textContent = 'Saved to your downloads.';
      deps.track('picture_saved', { puzzle: puzzle.id, via: 'download' });
    };
  }

  return { open };
}
