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

// The journal may contain unacknowledged FIFO deliveries after a crash. A dead
// PID alone is NOT permission to reclaim its lock or replay any queued event.
// Preserve an interrupted recovery marker as evidence for manual reconciliation.
export async function acquirePrivateJournalLock(journalPath) {
  if (typeof journalPath !== 'string' || !path.isAbsolute(journalPath))
    throw new Error('Private journal requires an absolute user-data path');
  const lockPath = journalPath + '.lock';
  const recoveryPath = lockPath + '.recovery';
  const metadata = JSON.stringify({version:1,pid:process.pid,
    hostname:os.hostname(),nonce:crypto.randomUUID()});
  let handle;
  try {
    const recoveryMarker = await fs.promises.lstat(recoveryPath).then(
      () => true, (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
    if (recoveryMarker) throw ownerUnknown();
    try { handle = await fs.promises.open(lockPath, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw ownerUnknown(); throw error; }
    await handle.writeFile(metadata, 'utf8');
    await handle.sync();
  } catch (error) {
    // A partially written owner record remains fail-closed for inspection.
    await handle?.close();
    throw error;
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
  const recovery = safeStat(journalPath + '.lock.recovery');
  if (file && (!file.isFile() || file.size > PRIVATE_JOURNAL_MAX_BYTES)) {
    throw new Error('Private journal is not a bounded regular file');
  }
  if (lock && !lock.isFile()) throw new Error('Private owner lock is not a regular file');
  if (recovery && !recovery.isFile()) throw new Error('Private recovery marker is not a regular file');
  return Object.freeze({present: Boolean(file), bytes: file?.size || 0,
    lockPresent: Boolean(lock), ownerVerified: false,
    requiresManualOwnerCheck: Boolean(lock || recovery)});
}


// Read-only recovery diagnosis. A PID check alone never authorizes discarding
// unacknowledged FIFO events. Only an empty journal has an in-app recovery path.
export function inspectJournalRecovery(journalPath,{ignoreRecoveryMarker=false}={}) {
  const inspection=inspectPrivateJournal(journalPath);
  const blocked=(reason,explanation,extra={})=>Object.freeze({
    ...inspection,canRecover:false,reason,explanation,...extra,
  });
  if(!inspection.present)return blocked('JOURNAL_MISSING',
    'Journal file is missing. Inspect its storage before restarting this profile.');
  const recoveryPath=journalPath+'.lock.recovery';
  if(!ignoreRecoveryMarker && fs.existsSync(recoveryPath))return blocked('RECOVERY_INTERRUPTED',
    'A previous recovery was interrupted. Preserve its evidence and inspect this profile.');
  if(!inspection.lockPresent)return blocked('NO_LOCK',
    'No owner lock exists. Start the local Proxy normally.');
  const lockPath=journalPath+'.lock';
  let owner,lockBytes;
  try {
    const lockStat=fs.lstatSync(lockPath);
    if(!lockStat.isFile()||lockStat.size<1||lockStat.size>1024)throw ownerUnknown();
    lockBytes=fs.readFileSync(lockPath);
    const parsed=JSON.parse(lockBytes.toString('utf8'));
    if(parsed?.version!==1 || !Number.isSafeInteger(parsed.pid) || parsed.pid<1 ||
        parsed.hostname!==os.hostname() ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.nonce||''))
      throw ownerUnknown();
    owner=parsed;
  } catch {
    return blocked('OWNER_UNVERIFIED',
      'Owner identity is missing or invalid. Do not remove this lock without manual reconciliation.');
  }
  let dead=false;
  try {process.kill(owner.pid,0);}catch(error){dead=error?.code==='ESRCH';}
  if(!dead)return blocked('OWNER_MAY_BE_RUNNING',
    'The owner process is running or cannot be verified as stopped.',{ownerPid:owner.pid});
  if(inspection.bytes!==0)return blocked('JOURNAL_NOT_EMPTY',
    'The owner stopped but the journal contains events. Reconcile deliveries before recovery.',
    {ownerPid:owner.pid});
  const stat=fs.statSync(journalPath);
  const snapshot=crypto.createHash('sha256').update(journalPath).update(lockBytes)
    .update(JSON.stringify({size:stat.size,dev:stat.dev,ino:stat.ino,
      ctimeMs:stat.ctimeMs,mtimeMs:stat.mtimeMs})).digest('hex');
  return Object.freeze({...inspection,ownerPid:owner.pid,canRecover:true,
    reason:'EMPTY_STALE_LOCK',snapshot,
    explanation:'The owner is not running and the journal is empty. After reviewing any unfinished Agent work, you may archive the stale lock.'});
}

// Explicit operator-controlled recovery, only for an unchanged empty journal
// with a provably dead local owner. Archive the lock; never delete evidence.
export async function archiveEmptyStaleJournalLock(journalPath,expectedSnapshot) {
  if(typeof expectedSnapshot!=='string'||!/^[0-9a-f]{64}$/.test(expectedSnapshot))
    throw new Error('Inspect this journal before requesting recovery');
  const current=inspectJournalRecovery(journalPath);
  if(!current.canRecover||current.snapshot!==expectedSnapshot)
    throw new Error('Journal state changed or is unsafe. Inspect again; nothing was modified.');
  const lockPath=journalPath+'.lock';
  const recoveryPath=lockPath+'.recovery';
  let marker,renameAttempted=false,archived=false;
  try {
    try {marker=await fs.promises.open(recoveryPath,'wx',0o600);}
    catch(error){if(error.code==='EEXIST')throw ownerUnknown();throw error;}
    await marker.writeFile(JSON.stringify({version:1,pid:process.pid,
      operation:'explicit_empty_journal_recovery',createdAt:new Date().toISOString()}));
    await marker.sync();
    const again=inspectJournalRecovery(journalPath,{ignoreRecoveryMarker:true});
    if(!again.canRecover||again.snapshot!==expectedSnapshot)
      throw new Error('Journal or lock changed during recovery. Lock was not archived.');
    const archivePath=lockPath+'.reconciled-'+Date.now()+'-'+crypto.randomUUID();
    renameAttempted=true;
    await fs.promises.rename(lockPath,archivePath);
    archived=true;
    return Object.freeze({archived:true,archiveName:path.basename(archivePath)});
  } finally {
    if(marker){
      await marker.close();
      // Unknown rename result remains blocked for manual examination.
      if(!renameAttempted||archived)await fs.promises.unlink(recoveryPath);
    }
  }
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
