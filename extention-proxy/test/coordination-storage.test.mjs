import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { preparePrivateJournal, PRIVATE_JOURNAL_MAX_BYTES } from '../desktop/coordination-storage.mjs';

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
