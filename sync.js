// Keeps a signed-in account's progress and puzzles in step with the server.
//
// Each save goes up with the server revision it was based on. The server takes it if
// nothing else saved that puzzle since; otherwise the copy with more jewels home wins,
// and the winner comes back here. Copies that changed here are never overwritten by
// a download; they go up, and the server decides.
import { api } from './account.js';
import { syncMeta, setSyncMeta, readSave, writeSave, customPuzzles, storeCustom, removeCustom } from './library.js';

const withoutFrom = ({ from, ...art }) => art;

// Returns the ids of puzzles whose save here was replaced by the server's copy.
export async function syncAccount() {
  const replaced = [];
  // Puzzles made here (or brought back to Free play) that the server hasn't got yet.
  for (const id of syncMeta().uploads) {
    const art = customPuzzles().find(a => a.id === id);
    try { if (art) await api.addPuzzle(withoutFrom(art)); }
    catch (error) { if (![400, 409].includes(error.status)) throw error; }
    const meta = syncMeta(); meta.uploads = meta.uploads.filter(x => x !== id); setSyncMeta(meta);
  }
  for (const id of syncMeta().removals) {
    try { await api.removePuzzle(id); } catch (error) { if (error.status !== 404) throw error; }
    const meta = syncMeta(); meta.removals = meta.removals.filter(x => x !== id); setSyncMeta(meta);
  }

  // Everything that changed on the server since last time.
  const changes = await api.changes(syncMeta().since);
  for (const item of changes.library) {
    if (item.removed) removeCustom(item.puzzle, { tell: false });
    else storeCustom(item.from ? { ...item.art, from: item.from } : item.art);
  }
  let meta = syncMeta();
  for (const save of changes.saves) {
    if (meta.revs[save.puzzle] === save.rev || meta.dirty.includes(save.puzzle)) continue;
    writeSave(save.puzzle, save.state, false);
    meta.revs[save.puzzle] = save.rev;
    replaced.push(save.puzzle);
  }
  meta.since = changes.rev;
  setSyncMeta(meta);

  // Saves changed here.
  const sent = meta.dirty.slice(0, 300).map(id => ({ puzzle: id, state: readSave(id), based_on: meta.revs[id] || 0 }));
  if (sent.length) {
    const reply = await api.putSaves(sent.filter(item => item.state));
    meta = syncMeta();
    for (const item of sent) {
      const result = reply.results[item.puzzle];
      const untouched = readSave(item.puzzle)?.savedAt === item.state?.savedAt;
      if (result) meta.revs[item.puzzle] = result.rev;
      if (result?.state) {
        // Another device got further: its copy wins here too.
        writeSave(item.puzzle, result.state, false);
        replaced.push(item.puzzle);
      }
      if (!result || result.state || untouched) meta.dirty = meta.dirty.filter(id => id !== item.puzzle);
    }
    setSyncMeta(meta);
  }
  return replaced;
}

// Anything here the server hasn't got yet?
export const unsent = () => { const meta = syncMeta(); return meta.dirty.length + meta.uploads.length + meta.removals.length; };
