import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { privateJournalTestHooks as journal } from '../server.js';

const owner = Object.freeze({
  principalId: randomUUID(), workspaceId: 'web-chat-automation',
  projectId: '4', orchestratorId: 'p0', parentTaskId: '65',
});
const incarnation = randomUUID();
const recipient = { type: 'manager_tab', tabId: 101, incarnationId: incarnation, connectionGeneration: 1 };
const worker = { type: 'worker_tab', tabId: 201, incarnationId: randomUUID(), connectionGeneration: 1 };

function queued(seq, entryType, source = worker) {
  const id = randomUUID();
  return {
    version: 4, seq, id, idempotencyKey: randomUUID(), kind: 'queue.transition',
    ownerScope: owner, source, recipient, ref: id,
    recordedAt: new Date().toISOString(),
    payload: { phase: 'QUEUED', entryType, leaseGeneration: 0, leaseNonce: null, data: { summary: 'fixture-' + seq } },
  };
}

function transition(seq, original, phase, generation = 1, nonce = randomUUID()) {
  return {
    version: 4, seq, id: randomUUID(), idempotencyKey: randomUUID(),
    kind: 'queue.transition', ownerScope: owner, source: original.source,
    recipient, ref: original.ref, recordedAt: new Date().toISOString(),
    payload: { phase, ref: original.ref, leaseGeneration: generation, leaseNonce: nonce },
  };
}

test('journal replays a bounded FIFO with status barrier and refuses overtaking', () => {
  const first = queued(1, 'CHILD_RESULT');
  const status = queued(2, 'STATUS_REQUEST', recipient);
  const third = queued(3, 'CHILD_RESULT');
  const events = [first, status, third];
  const file = Buffer.concat(events.map(journal.privateJournalFrame));
  const replay = journal.replayPrivateJournal(file);
  assert.equal(replay.tail, null);
  assert.equal(replay.events.length, 3);
  const reduced = journal.reducePrivateQueueEvents(replay.events);
  assert.equal(reduced.fifo.length, 3);
  const counts = journal.privateQueueDiagnosticCounts(reduced);
  assert.equal(counts.pending, 3);
  assert.equal(counts.phases.QUEUED, 3);
  assert.deepEqual(Object.keys(counts).sort(), ['pending', 'phases']);
  assert.equal(JSON.stringify(counts).includes(owner.principalId), false,
    'local aggregate diagnostics must not disclose owner identity');
  assert.deepEqual(reduced.fifo.map((key) => reduced.byRef.get(key).entryType), [
    'CHILD_RESULT', 'STATUS_REQUEST', 'CHILD_RESULT',
  ]);
  const wrongLease = transition(4, status, 'LEASED');
  assert.throws(() => journal.reducePrivateQueueEvents([...events, wrongLease]), /FIFO/);
  const lease = transition(4, first, 'LEASED');
  assert.equal(journal.reducePrivateQueueEvents([...events, lease]).byRef.size, 3);
  assert.throws(() => journal.reducePrivateQueueEvents([...events, lease, transition(5, status, 'LEASED')]), /FIFO/);
  const dispatching = transition(5, first, 'DISPATCHING', 1, lease.payload.leaseNonce);
  const delivered = transition(6, first, 'DELIVERED', 1, lease.payload.leaseNonce);
  const processed = transition(7, first, 'PROCESSED', 1, lease.payload.leaseNonce);
  processed.payload.ack = {
    kind: 'explicit_manager_ack', eventRef: first.ref, principalId: owner.principalId,
    acknowledgedAt: new Date().toISOString(), batchId: randomUUID(),
  };
  const prematureStatusLease = transition(7, status, 'LEASED');
  const statusLease = transition(8, status, 'LEASED');
  assert.throws(
    () => journal.reducePrivateQueueEvents([...events, lease, dispatching, delivered, prematureStatusLease]),
    /FIFO/,
  );
  const advanced = journal.reducePrivateQueueEvents([
    ...events, lease, dispatching, delivered, processed, statusLease,
  ]);
  assert.equal(advanced.byRef.get(advanced.fifo[0]).phase, 'PROCESSED');
  assert.equal(advanced.byRef.get(advanced.fifo[1]).phase, 'LEASED');
  const recovered = journal.reducePrivateQueueEvents([...events, lease], true);
  assert.equal(recovered.byRef.get(recovered.fifo[0]).recoveryClass, 'STALE_LEASE_OWNER_UNVERIFIED');
  assert.equal(journal.privateQueueDiagnosticCounts(recovered).phases.LEASED, 1);
});

test('journal rejects tampered, torn, duplicated and stale phase events without replay', () => {
  const first = queued(1, 'CHILD_RESULT');
  const full = journal.privateJournalFrame(first);
  assert.equal(journal.replayPrivateJournal(full.subarray(0, full.length - 1)).tail.reason, 'INCOMPLETE_FRAME');
  const corrupt = Buffer.from(full);
  corrupt[8] ^= 1;
  assert.equal(journal.replayPrivateJournal(corrupt).tail.reason, 'CHECKSUM_MISMATCH');
  assert.equal(journal.replayPrivateJournal(Buffer.concat([full, full])).tail.reason, 'INVALID_EVENT');
  const invalid = transition(2, first, 'SAGA_CONFIRMED', 0, null);
  assert.throws(() => journal.reducePrivateQueueEvents([first, invalid]), /independently verified board readback/);
});

test('one batch can lease B-complete/status-request/D-complete without reordering', () => {
  const b = queued(1, 'CHILD_RESULT');
  const status = queued(2, 'STATUS_REQUEST', recipient);
  const d = queued(3, 'CHILD_RESULT');
  const nonce = randomUUID();
  const leases = [
    transition(4, b, 'LEASED', 1, nonce),
    transition(5, status, 'LEASED', 1, nonce),
    transition(6, d, 'LEASED', 1, nonce),
  ];
  const reduced = journal.reducePrivateQueueEvents([b, status, d, ...leases]);
  assert.deepEqual(reduced.fifo.map((key) => reduced.byRef.get(key).phase), [
    'LEASED', 'LEASED', 'LEASED',
  ]);
  const wrong = transition(5, status, 'LEASED', 1, randomUUID());
  assert.throws(() => journal.reducePrivateQueueEvents([b, status, d, leases[0], wrong]), /FIFO/);
});

test('crash replay preserves DISPATCHING and DELIVERED ambiguity with no status overtaking', () => {
  const result = queued(1, 'CHILD_RESULT');
  const status = queued(2, 'STATUS_REQUEST', recipient);
  const nonce = randomUUID();
  const lease = transition(3, result, 'LEASED', 1, nonce);
  const dispatched = transition(4, result, 'DISPATCHING', 1, nonce);
  const delivered = transition(5, result, 'DELIVERED', 1, nonce);
  for (const [history, originalPhase] of [
    [[result, status, lease, dispatched], 'DISPATCHING'],
    [[result, status, lease, dispatched, delivered], 'DELIVERED'],
  ]) {
    const bytes = Buffer.concat(history.map(journal.privateJournalFrame));
    const snapshot = Buffer.from(bytes);
    const decoded = journal.replayPrivateJournal(bytes);
    assert.equal(decoded.tail, null);
    const recovered = journal.reducePrivateQueueEvents(decoded.events, true);
    const ambiguous = recovered.byRef.get(recovered.fifo[0]);
    assert.equal(ambiguous.phase, 'UNCERTAIN');
    assert.equal(ambiguous.previousPhase, originalPhase);
    assert.equal(ambiguous.recoveryClass, 'DISPATCH_CONSUMER_ACK_UNVERIFIED');
    assert.equal(recovered.byRef.get(recovered.fifo[1]).phase, 'QUEUED');
    assert.equal(Buffer.compare(bytes, snapshot), 0, 'recovery must not alter journal evidence');
    assert.throws(() =>
      journal.reducePrivateQueueEvents([...decoded.events,
        transition(history.length + 1, status, 'LEASED')]), /FIFO/,
      'a status request cannot overtake an unacknowledged child after restart');
  }
  const uncertain = transition(6, result, 'UNCERTAIN', 1, nonce);
  const explicit = journal.reducePrivateQueueEvents([
    result, status, lease, dispatched, delivered, uncertain,
  ], true);
  assert.equal(explicit.byRef.get(explicit.fifo[0]).recoveryClass, 'PREEXISTING_UNCERTAIN');
});

test('desktop readiness is fresh, authenticated and fail-closed across disconnects', () => {
  const now = 50000;
  const base = { revoked: false, registered: true, connected: true, now };
  assert.equal(journal.privateReadinessState({ ...base,
    observation: { state: 'busy', observedAt: now - 500 } }), 'busy');
  assert.equal(journal.privateReadinessState({ ...base,
    observation: { state: 'idle', observedAt: now - 500 } }), 'idle');
  assert.equal(journal.privateReadinessState({ ...base,
    observation: { state: 'draft', observedAt: now - 500 } }), 'draft');
  assert.equal(journal.privateReadinessState({ ...base,
    observation: { state: 'unknown', observedAt: now - 500 } }), 'unknown');
  assert.equal(journal.privateReadinessState({ ...base, connected: false,
    observation: { state: 'idle', observedAt: now - 500 } }), 'disconnected');
  assert.equal(journal.privateReadinessState({ ...base,
    observation: { state: 'idle', observedAt: now - 10001 } }), 'unknown');
  assert.equal(journal.privateReadinessState({ ...base,
    observation: { state: 'idle', observedAt: now + 100 } }), 'unknown');
  assert.equal(journal.privateReadinessState({ ...base,
    observation: { state: 'ready', observedAt: now - 500 } }), 'unknown');
  assert.equal(journal.privateReadinessState({ ...base, registered: false }), 'not_registered');
  assert.equal(journal.privateReadinessState({ ...base, revoked: true }), 'revoked');
});
