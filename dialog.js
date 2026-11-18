// The one pop-up (the <dialog id="modal"> in index.html), shared by every screen.
// show(markup, then) fills it and opens it; `then` runs once it closes, however it closes.

export const esc = text => String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export function createDialog($) {
  let afterClose = null;
  function show(content, then = null) {
    afterClose = then;
    $('modalContent').innerHTML = content;
    if (!$('modal').open) $('modal').showModal();
  }
  // The close event comes a moment after close(); if the dialog has reopened by then with
  // new content, that event is stale and the new content's handler waits for its own close.
  $('modal').onclose = () => { if ($('modal').open) return; const next = afterClose; afterClose = null; next?.(); };
  $('close').onclick = () => $('modal').close();
  $('modal').onclick = e => {
    if (e.target !== $('modal')) return;
    const r = $('modal').getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) $('modal').close();
  };
  // A yes/no question; resolves true for yes.
  function ask(question, yes, no) {
    let answer = false;
    return new Promise(resolve => {
      show(`<h2>${esc(question)}</h2><button class="primary" id="askYes">${esc(yes)}</button><button class="home-button" id="askNo">${esc(no)}</button>`, () => resolve(answer));
      $('askYes').onclick = () => { answer = true; $('modal').close(); };
      $('askNo').onclick = () => $('modal').close();
    });
  }
  return { show, ask, close: () => $('modal').close(), isOpen: () => Boolean($('modal').open) };
}
