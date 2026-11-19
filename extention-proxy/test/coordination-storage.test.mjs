import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { preparePrivateJournal, inspectPrivateJournal, acquirePrivateJournalLock, PRIVATE_JOURNAL_MAX_BYTES } from '../desktop/coordination-storage.mjs';

test('lock release checks its own identity and never deletes a replacement owner', async() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-lock-owner-'));
  const journal = path.join(root,'coordination.events.journal');
  const lockPath = journal + '.lock';
  try {
    const lock = await acquirePrivateJournalLock(journal);
    const replacement = {...JSON.parse(fs.readFileSync(lockPath,'utf8')),
      nonce:'ffffffff-ffff-4fff-8fff-ffffffffffff'};
    fs.writeFileSync(lockPath,JSON.stringify(replacement));
    await assert.rejects(lock.release(), {code:'PRIVATE_JOURNAL_OWNER_UNKNOWN'});
    assert.deepEqual(JSON.parse(fs.readFileSync(lockPath,'utf8')),replacement);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('foreign-host and interrupted recovery locks remain fail-closed', async() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-lock-host-'));
  const journal = path.join(root,'coordination.events.journal');
  const lockPath = journal + '.lock';
  const owner = JSON.stringify({version:1,pid:2147483647,hostname:'not-this-host',
    nonce:'ffffffff-ffff-4fff-8fff-ffffffffffff'});
  try {
    fs.writeFileSync(lockPath,owner);
    await assert.rejects(acquirePrivateJournalLock(journal), {code:'PRIVATE_JOURNAL_OWNER_UNKNOWN'});
    assert.equal(fs.readFileSync(lockPath,'utf8'),owner);
    fs.writeFileSync(lockPath+'.recovery','preserve recovery evidence');
    await assert.rejects(acquirePrivateJournalLock(journal), {code:'PRIVATE_JOURNAL_OWNER_UNKNOWN'});
    assert.equal(fs.readFileSync(lockPath+'.recovery','utf8'),'preserve recovery evidence');
    assert.equal(fs.readFileSync(lockPath,'utf8'),owner);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('well-formed dead-owner and orphan recovery marker never authorize automatic lock removal',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'chat-orch-lock-crash-'));
  const journal=path.join(root,'coordination.events.journal');
  const lockPath=journal+'.lock';
  const original=JSON.stringify({version:1,pid:2147483647,
    hostname:os.hostname(),nonce:'ffffffff-ffff-4fff-8fff-ffffffffffff'});
  try {
    fs.writeFileSync(lockPath,original);
    await assert.rejects(acquirePrivateJournalLock(journal),{code:'PRIVATE_JOURNAL_OWNER_UNKNOWN'});
    assert.equal(fs.readFileSync(lockPath,'utf8'),original);
    fs.unlinkSync(lockPath);
    fs.writeFileSync(lockPath+'.recovery','interrupted recovery marker');
    await assert.rejects(acquirePrivateJournalLock(journal),{code:'PRIVATE_JOURNAL_OWNER_UNKNOWN'});
    assert.equal(fs.existsSync(lockPath),false);
    assert.equal(fs.readFileSync(lockPath+'.recovery','utf8'),'interrupted recovery marker');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('private journal provisioning is explicit, fsynced, idempotent and non-truncating', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-prep-'));
  const file = path.join(root, 'profile', 'coordination.events.journal');
  try {
    assert.deepEqual(preparePrivateJournal(file), { created: true, bytes: 0 });
    fs.appendFileSync(file, 'opaque history');
    assert.deepEqual(preparePrivateJournal(file), { created: false, bytes: 14 });
    assert.equal(fs.readFileSync(file, 'utf8'), 'opaque history');
    const lock = file + '.lock';
    fs.writeFileSync(lock, 'unknown owner');
    assert.deepEqual(preparePrivateJournal(file), { created: false, bytes: 14 });
    assert.equal(fs.readFileSync(lock, 'utf8'), 'unknown owner', 'never remove a stale-owner lock');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('private journal provisioning fails closed for invalid and oversized targets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-invalid-prep-'));
  try {
    assert.throws(() => preparePrivateJournal('relative/journal'), /absolute/);
    const directory = path.join(root, 'directory-as-journal');
    fs.mkdirSync(directory);
    assert.throws(() => preparePrivateJournal(directory), /bounded regular file/);
    const oversized = path.join(root, 'oversized.journal');
    fs.writeFileSync(oversized, '');
    fs.truncateSync(oversized, PRIVATE_JOURNAL_MAX_BYTES + 1);
    assert.throws(() => preparePrivateJournal(oversized), /bounded regular file/);
    assert.equal(fs.statSync(oversized).size, PRIVATE_JOURNAL_MAX_BYTES + 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('read-only journal inspector flags unknown owner locks without mutating evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-inspect-'));
  const file = path.join(root, 'coordination.events.journal');
  try {
    assert.deepEqual(inspectPrivateJournal(file), {present:false,bytes:0,lockPresent:false,
      ownerVerified:false,requiresManualOwnerCheck:false});
    preparePrivateJournal(file);
    fs.appendFileSync(file,'unchanged journal evidence');
    const lock = file + '.lock';
    fs.writeFileSync(lock,'unverified owner');
    const before = fs.readFileSync(file,'utf8');
    const locked = inspectPrivateJournal(file);
    assert.equal(locked.lockPresent, true);
    assert.equal(locked.ownerVerified, false);
    assert.equal(locked.requiresManualOwnerCheck, true);
    assert.equal(locked.bytes, Buffer.byteLength(before));
    assert.equal(fs.readFileSync(file,'utf8'), before);
    assert.equal(fs.readFileSync(lock,'utf8'), 'unverified owner');
    fs.unlinkSync(lock);
    assert.equal(inspectPrivateJournal(file).lockPresent, false);
    fs.writeFileSync(lock+'.recovery','interrupted recovery evidence');
    assert.equal(inspectPrivateJournal(file).requiresManualOwnerCheck,true);
    assert.equal(inspectPrivateJournal(file).lockPresent,false);
    fs.unlinkSync(lock+'.recovery');
    fs.mkdirSync(lock);
    assert.throws(() => inspectPrivateJournal(file), /not a regular file/);
    assert.equal(fs.readFileSync(file,'utf8'), before);
  } finally {fs.rmSync(root, {recursive:true,force:true});}
});
