// RC-13 regression: a batch ACK interrupted mid-write must not be recorded as
// a partial success, and must leave the whole batch deliverable.
//
// Buggy behaviour (server.js acknowledgePrivateBatch): PROCESSED records are
// appended one item at a time, so a crash between appends leaves an on-disk
// state where the first items are PROCESSED and the rest remain
// DELIVERED/UNCERTAIN. That partial state replays silently: processedCount is
// neither zero nor the batch size, and the un-ACKed remainder can never be
// re-delivered under the same lease. This test reproduces the exact durable
// shape such an interruption produces and asserts the all-or-nothing
// invariant. It is expected to FAIL until the ACK becomes atomic (single
// batch-level record, or a tail-truncating commit).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { privateJournalTestHooks as journal } from '../server.js';

const owner = Object.freeze({
  principalId: randomUUID(), workspaceId: 'web-chat-automation',
  projectId: '4', orchestratorId: 'p0', parentTaskId: '65',
});
const recipient = Object.freeze({
  type: 'manager_tab', tabId: 101, incarnationId: randomUUID(), connectionGeneration: 1,
});
const worker = Object.freeze({
  type: 'worker_tab', tabId: 201, incarnationId: randomUUID(), connectionGeneration: 1,
});

function queued(seq) {
  const id = randomUUID();
  return {
    version: 4, seq, id, idempotencyKey: randomUUID(), kind: 'queue.transition',
    ownerScope: owner, source: worker, recipient, ref: id,
    recordedAt: new Date().toISOString(),
    payload: { phase: 'QUEUED', entryType: 'CHILD_RESULT', leaseGeneration: 0,
      leaseNonce: null, data: { summary: 'rc13-fixture-' + seq } },
  };
}

function transition(seq, original, phase, nonce, ack = null) {
  const payload = { phase, ref: original.ref, leaseGeneration: 1, leaseNonce: nonce };
  if (ack) payload.ack = ack;
  return {
    version: 4, seq, id: randomUUID(), idempotencyKey: randomUUID(),
    kind: 'queue.transition', ownerScope: owner, source: original.source,
    recipient, ref: original.ref, recordedAt: new Date().toISOString(), payload,
  };
}

function ackFor(ref, batchId) {
  return { kind: 'explicit_manager_ack', eventRef: ref, principalId: owner.principalId,
    acknowledgedAt: new Date().toISOString(), batchId };
}

// Durable history for one 3-item wake batch: every item DELIVERED under the
// same lease nonce, then the interrupted ACK writes PROCESSED for the first
// `acked` items only — exactly what a kill between per-item appends leaves.
function deliveredBatch(acked) {
  const items = [queued(1), queued(2), queued(3)];
  const nonce = randomUUID();
  const events = [...items];
  for (const item of items) events.push(transition(events.length + 1, item, 'LEASED', nonce));
  for (const item of items) events.push(transition(events.length + 1, item, 'DISPATCHING', nonce));
  for (const item of items) events.push(transition(events.length + 1, item, 'DELIVERED', nonce));
  for (const item of items.slice(0, acked)) {
    events.push(transition(events.length + 1, item, 'PROCESSED', nonce,
      ackFor(item.ref, nonce)));
  }
  return { items, nonce, events };
}

function frames(events) {
  return Buffer.concat(events.map(journal.privateJournalFrame));
}

function finalPhases(events) {
  const reduced = journal.reducePrivateQueueEvents(events, true);
  return reduced.fifo.map((key) => reduced.byRef.get(key));
}

test('RC-13 fixture: a complete batch ACK is accepted (control)', () => {
  const { events } = deliveredBatch(3);
  const replay = journal.replayPrivateJournal(frames(events));
  assert.equal(replay.tail, null);
  const items = finalPhases(replay.events);
  assert.deepEqual(items.map((i) => i.phase), ['PROCESSED', 'PROCESSED', 'PROCESSED']);
});

test('RC-13 interrupted ACK must be all-or-nothing, never partially processed', () => {
  const { events, items: originals } = deliveredBatch(1);
  const bytes = frames(events);
  // Frame integrity holds: the partial state is durable, readable and would
  // be accepted on every restart. That is precisely why the invariant must be
  // enforced by the ACK semantics rather than by the journal format.
  const replay = journal.replayPrivateJournal(bytes);
  assert.equal(replay.tail, null, 'partial ACK bytes are structurally valid');
  assert.equal(replay.events.length, events.length);

  const items = finalPhases(replay.events);
  const processed = items.filter((item) => item.phase === 'PROCESSED');
  const batchSize = originals.length;
  assert.ok(
    processed.length === 0 || processed.length === batchSize,
    `interrupted batch ACK recorded a partial success: ${processed.length}/${batchSize} ` +
    'items PROCESSED (' + items.map((i) => i.phase).join(',') + '); ' +
    'the remaining items are no longer deliverable under their lease. ' +
    'ACK must be atomic per batch (or leave the batch fully deliverable).');
});

test('RC-13 no ACK at all leaves the whole batch recoverable as UNCERTAIN', () => {
  const { events, items: originals } = deliveredBatch(0);
  const replay = journal.replayPrivateJournal(frames(events));
  assert.equal(replay.tail, null);
  const items = finalPhases(replay.events);
  assert.equal(items.length, originals.length);
  assert.deepEqual(items.map((i) => i.phase), ['UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN'],
    'an uninterrupted-away batch must stay wholly unresolved, never half-processed');
  assert.equal(items.every((i) => i.recovered === true), true);
});
