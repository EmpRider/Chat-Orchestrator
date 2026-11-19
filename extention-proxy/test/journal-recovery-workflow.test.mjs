import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inspectJournalRecovery,archiveEmptyStaleJournalLock} from '../desktop/coordination-storage.mjs';

const deadOwner=()=>JSON.stringify({version:1,pid:2147483647,
  hostname:os.hostname(),nonce:'ffffffff-ffff-4fff-8fff-ffffffffffff'});
const withJournal=(fn)=>async(t)=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'chat-orch-guided-lock-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const journal=path.join(folder,'coordination.events.journal');
  fs.writeFileSync(journal,'');
  await fn(journal,folder);
};

test('operator-approved empty journal recovery archives evidence, never truncates or deletes it',withJournal(async(journal,folder)=>{
  const lock=journal+'.lock';
  const original=deadOwner();
  fs.writeFileSync(lock,original);
  const inspection=inspectJournalRecovery(journal);
  assert.equal(inspection.reason,'EMPTY_STALE_LOCK');
  assert.equal(inspection.canRecover,true);
  assert.match(inspection.snapshot,/^[0-9a-f]{64}$/);
  const outcome=await archiveEmptyStaleJournalLock(journal,inspection.snapshot);
  assert.equal(outcome.archived,true);
  assert.match(outcome.archiveName,/\.lock\.reconciled-/);
  assert.equal(fs.readFileSync(path.join(folder,outcome.archiveName),'utf8'),original);
  assert.equal(fs.existsSync(lock),false);
  assert.equal(fs.existsSync(lock+'.recovery'),false);
  assert.equal(fs.statSync(journal).size,0);
  assert.equal(inspectJournalRecovery(journal).reason,'NO_LOCK');
}));

test('journal events block unlock even when owner PID is confirmed absent',withJournal(async(journal)=>{
  const lock=journal+'.lock',owner=deadOwner();
  fs.writeFileSync(journal,'recorded unresolved event');
  fs.writeFileSync(lock,owner);
  const inspection=inspectJournalRecovery(journal);
  assert.equal(inspection.reason,'JOURNAL_NOT_EMPTY');
  assert.equal(inspection.canRecover,false);
  await assert.rejects(archiveEmptyStaleJournalLock(journal,'a'.repeat(64)),/unsafe|changed/);
  assert.equal(fs.readFileSync(lock,'utf8'),owner);
  assert.equal(fs.readFileSync(journal,'utf8'),'recorded unresolved event');
}));

test('a live owner and invalid owner metadata are never recoverable',withJournal(async(journal)=>{
  const lock=journal+'.lock';
  fs.writeFileSync(lock,JSON.stringify({version:1,pid:process.pid,
    hostname:os.hostname(),nonce:'ffffffff-ffff-4fff-8fff-ffffffffffff'}));
  assert.equal(inspectJournalRecovery(journal).reason,'OWNER_MAY_BE_RUNNING');
  fs.writeFileSync(lock,'not valid JSON');
  assert.equal(inspectJournalRecovery(journal).reason,'OWNER_UNVERIFIED');
  await assert.rejects(archiveEmptyStaleJournalLock(journal,'b'.repeat(64)));
  assert.equal(fs.readFileSync(lock,'utf8'),'not valid JSON');
}));

test('changed journal or replaced lock invalidates previously approved snapshot',withJournal(async(journal)=>{
  const lock=journal+'.lock';
  fs.writeFileSync(lock,deadOwner());
  const first=inspectJournalRecovery(journal);
  fs.writeFileSync(journal,'a');
  await assert.rejects(archiveEmptyStaleJournalLock(journal,first.snapshot),/unsafe|changed/);
  assert.equal(fs.existsSync(lock),true);
  fs.writeFileSync(journal,'');
  const second=inspectJournalRecovery(journal);
  fs.writeFileSync(lock,deadOwner()+' ');
  await assert.rejects(archiveEmptyStaleJournalLock(journal,second.snapshot),/unsafe|changed/);
  assert.equal(fs.existsSync(lock),true);
}));

test('interrupted recovery marker remains protected; parallel clicks archive at most once',withJournal(async(journal,folder)=>{
  const lock=journal+'.lock';
  fs.writeFileSync(lock,deadOwner());
  fs.writeFileSync(lock+'.recovery','previous recovery evidence');
  assert.equal(inspectJournalRecovery(journal).reason,'RECOVERY_INTERRUPTED');
  await assert.rejects(archiveEmptyStaleJournalLock(journal,'c'.repeat(64)));
  assert.equal(fs.readFileSync(lock+'.recovery','utf8'),'previous recovery evidence');
  fs.unlinkSync(lock+'.recovery');
  const snapshot=inspectJournalRecovery(journal).snapshot;
  const attempts=await Promise.allSettled([
    archiveEmptyStaleJournalLock(journal,snapshot),
    archiveEmptyStaleJournalLock(journal,snapshot),
  ]);
  assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1);
  assert.equal(attempts.filter(a=>a.status==='rejected').length,1);
  assert.equal(fs.readdirSync(folder).filter(n=>n.includes('.lock.reconciled-')).length,1);
  assert.equal(fs.statSync(journal).size,0);
}));
