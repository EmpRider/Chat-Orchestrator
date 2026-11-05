import fs from 'node:fs';
import path from 'node:path';

export const PRIVATE_JOURNAL_MAX_BYTES = 32 * 1024 * 1024;

// Read-only: ownership cannot be inferred from a lock file after a Windows crash.
// Never remove, truncate, replay or repair a journal in this inspector.
export function inspectPrivateJournal(journalPath) {
  if (typeof journalPath !== 'string' || !path.isAbsolute(journalPath)) {
    throw new Error('Private journal inspection requires an absolute path');
  }
  const safeStat = (target) => {
    try { return fs.lstatSync(target); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const file = safeStat(journalPath);
  const lock = safeStat(journalPath + '.lock');
  if (file && (!file.isFile() || file.size > PRIVATE_JOURNAL_MAX_BYTES)) {
    throw new Error('Private journal is not a bounded regular file');
  }
  if (lock && !lock.isFile()) throw new Error('Private owner lock is not a regular file');
  return Object.freeze({present: Boolean(file), bytes: file?.size || 0,
    lockPresent: Boolean(lock), ownerVerified: false,
    requiresManualOwnerCheck: Boolean(lock)});
}


// Called only by a trusted local desktop action, before a future proxy start.
// There is deliberately no automatic repair, truncation, or stale-lock removal.
export function preparePrivateJournal(journalPath) {
  if (typeof journalPath !== 'string' || !path.isAbsolute(journalPath)) {
    throw new Error('Private journal requires an absolute user-data path');
  }
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  let created = false;
  try {
    const fd = fs.openSync(journalPath, 'wx', 0o600);
    created = true;
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(journalPath);
  if (!stat.isFile() || stat.size > PRIVATE_JOURNAL_MAX_BYTES) {
    throw new Error('Private journal must be a bounded regular file; manual reconciliation required');
  }
  return Object.freeze({ created, bytes: stat.size });
}
