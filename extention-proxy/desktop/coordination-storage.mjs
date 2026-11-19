import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const PRIVATE_JOURNAL_MAX_BYTES = 32 * 1024 * 1024;

function ownerUnknown() {
  const error = new Error('Private journal owner lock exists; verify ownership before recovery');
  error.code = 'PRIVATE_JOURNAL_OWNER_UNKNOWN';
  return error;
}

async function readLockOwner(lockPath) {
  const stat = await fs.promises.lstat(lockPath);
  if (!stat.isFile() || stat.size < 1 || stat.size > 1024) throw ownerUnknown();
  const text = await fs.promises.readFile(lockPath, 'utf8');
  let owner;
  try { owner = JSON.parse(text); } catch { throw ownerUnknown(); }
  if (owner?.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
      owner.hostname !== os.hostname() ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner.nonce || ''))
    throw ownerUnknown();
  return {owner,text};
}

// A PID that still exists (including PID reuse or denied inspection) fails closed.
// No age-based expiry: an idle/live writer must never lose its lock.
export async function acquirePrivateJournalLock(journalPath) {
  if (typeof journalPath !== 'string' || !path.isAbsolute(journalPath))
    throw new Error('Private journal requires an absolute user-data path');
  const lockPath = journalPath + '.lock';
  const recoveryPath = lockPath + '.recovery';
  const metadata = JSON.stringify({version:1,pid:process.pid,
    hostname:os.hostname(),nonce:crypto.randomUUID()});
  let handle;
  let recovery;
  try {
    try { handle = await fs.promises.open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Serialize dead-owner reclamation; another contender must not remove
      // the new writer's lock after examining the previous owner's PID.
      try { recovery = await fs.promises.open(recoveryPath, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw ownerUnknown(); throw error; }
      const {owner,text} = await readLockOwner(lockPath);
      let dead = false;
      try { process.kill(owner.pid, 0); }
      catch (error) { dead = error.code === 'ESRCH'; }
      if (!dead || (await fs.promises.readFile(lockPath, 'utf8')) !== text) throw ownerUnknown();
      await fs.promises.unlink(lockPath);
      handle = await fs.promises.open(lockPath, 'wx', 0o600);
    }
    await handle.writeFile(metadata, 'utf8');
    await handle.sync();
  } catch (error) {
    // A partially written owner record remains fail-closed for inspection.
    await handle?.close();
    throw error;
  } finally {
    if (recovery) {
      await recovery.close();
      await fs.promises.unlink(recoveryPath);
    }
  }
  let released;
  return Object.freeze({
    release: () => released ||= (async() => {
      try {
        const {text} = await readLockOwner(lockPath);
        if (text !== metadata) throw ownerUnknown();
      } finally { await handle.close(); }
      await fs.promises.unlink(lockPath);
    })(),
  });
}

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


// Called by trusted desktop startup or an explicit local action, before proxy start.
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
