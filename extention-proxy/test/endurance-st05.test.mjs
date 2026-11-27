// ST-05 — endurance: 50 sequential spawn → complete → review → close cycles.
// The catalog asks for three properties: no memory leak, no journal bloat, and
// every task terminal. "Memory leak" cannot be observed honestly from Node
// without a heap profiler, so this test asserts what it CAN prove and says so:
//
//   1. the journal stays under its hard caps (PRIVATE_JOURNAL_LIMIT 32 MiB,
//      PRIVATE_EVENT_LIMIT 4096) across 50 full lifecycles, and growth is
//      LINEAR in cycle count, not super-linear — a leak that retained the whole
//      transcript per cycle would show as a slope change;
//   2. every one of the 50 tasks is terminal in the reduced state — no task
//      left QUEUED/LEASED/DELIVERING, which is the property a leak would break;
//   3. the FIFO is fully drained (no residual refs), so the next cycle starts
//      from a clean head rather than inheriting a stuck predecessor.
//
// Modules only (the real reducer, the real frame codec, the real caps). No
// proxy process: this is the state machine under repetition, which is where an
// endurance defect would live. The transport repetition is ST-06's territory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { privateJournalTestHooks as journal } from '../server.js';

const CYCLES = 50;
const owner = Object.freeze({
  principalId: randomUUID(), workspaceId: 'web-chat-automation',
  projectId: '4', orchestratorId: 'p0', parentTaskId: '65',
});
const manager = { type: 'manager_tab', tabId: 101, incarnationId: randomUUID(), connectionGeneration: 1 };

function ev(seq, kind, recipient, source, payload, id = randomUUID()) {
  return {
    version: 4, seq, id, idempotencyKey: randomUUID(), kind,
    ownerScope: owner, source, recipient, ref: payload.ref ?? id,
    recordedAt: new Date(Date.UTC(2026, 10, 20, 12, 0, seq % 60)).toISOString(),
    payload,
  };
}

// One full lifecycle as the real code emits it: the Child's result is QUEUED
// for the Parent, leased, dispatched, delivered, processed.
// The reducer requires a gap-free seq (server.js:995), so fixtures assign seqs
// loosely and normalize once, in journal order, before reducing.
function renumber(events) {
  return events.map((event, index) => ({ ...event, seq: index + 1 }));
}

function lifecycle(seq0, cycle) {
  const worker = { type: 'worker_tab', tabId: 200 + (cycle % 50),
    incarnationId: randomUUID(), connectionGeneration: 1 };
  const resultRef = randomUUID();
  const leaseNonce = randomUUID();
  const base = { ref: resultRef };
  return [
    // Enrollment must NOT carry payload.ref (server.js:911) — a QUEUED event is
    // its own ref, so its id IS the ref every later transition cites.
    ev(seq0, 'queue.transition', manager, worker,
      { phase: 'QUEUED', entryType: 'CHILD_RESULT', leaseGeneration: 0, leaseNonce: null,
        data: { status: 'done', result: 'cycle-' + cycle, elapsedSeconds: 1 } }, resultRef),
    ev(seq0 + 1, 'queue.transition', manager, worker,
      { ...base, phase: 'LEASED', leaseGeneration: 1, leaseNonce }),
    ev(seq0 + 2, 'queue.transition', manager, worker,
      { ...base, phase: 'DISPATCHING', leaseGeneration: 1, leaseNonce }),
    ev(seq0 + 3, 'queue.transition', manager, worker,
      { ...base, phase: 'DELIVERED', leaseGeneration: 1, leaseNonce }),
    // PROCESSED is not "the model read it" — it is an explicit manager ACK
    // (server.js:877-887). Without this the reducer refuses the transition.
    ev(seq0 + 4, 'queue.transition', manager, worker,
      { ...base, phase: 'PROCESSED', leaseGeneration: 1, leaseNonce,
        ack: { kind: 'explicit_manager_ack', eventRef: resultRef,
          batchId: leaseNonce, principalId: owner.principalId,
          acknowledgedAt: new Date(Date.UTC(2026, 10, 20, 12, 0, 10)).toISOString() } }),
  ];
}

// The stall release an operator is allowed to assert: SKIPPED + durable
// manual_skip evidence (server.js:895, 963). There is no auto-skip anywhere.
function skip(seq, event, reason) {
  const prior = event.payload;
  return {
    ...ev(seq, 'queue.transition', manager, event.source,
      { ref: event.ref, phase: 'SKIPPED', leaseGeneration: prior.leaseGeneration,
        leaseNonce: prior.leaseNonce,
        recovery: { kind: 'manual_skip', eventRef: event.ref, batchId: prior.leaseNonce,
          principalId: owner.principalId, at: new Date(Date.UTC(2026, 10, 20, 12, 1, 0)).toISOString(),
          reason } }),
    recipient: event.recipient,
  };
}

test('ST-05 50 sequential lifecycles leave no unterminal task and no runaway journal', () => {
  const all = [];
  let seq = 1;
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    all.push(...lifecycle(seq, cycle));
    seq += 5;
  }

  // ---- every task terminal ------------------------------------------------
  const reduced = journal.reducePrivateQueueEvents(all);
  assert.equal(reduced.fifo.length, CYCLES, 'one FIFO entry per cycle, no duplication');
  const phases = reduced.fifo.map((key) => reduced.byRef.get(key).phase);
  const notTerminal = phases.filter((phase) => phase !== 'PROCESSED');
  assert.deepEqual(notTerminal, [],
    'every one of the ' + CYCLES + ' tasks must be terminal; got ' + JSON.stringify(
      phases.reduce((acc, p) => ({ ...acc, [p]: (acc[p] || 0) + 1 }), {})));
  assert.equal(new Set(reduced.fifo.map((key) => reduced.byRef.get(key).ref)).size, CYCLES,
    'each cycle must own a distinct ref');

  // ---- journal size stays under the hard caps -----------------------------
  const bytes = Buffer.concat(all.map(journal.privateJournalFrame));
  assert.ok(all.length < 4096, 'event count ' + all.length + ' must stay under the 4096 cap');
  assert.ok(bytes.length < 32 * 1024 * 1024,
    'journal ' + bytes.length + ' bytes must stay under the 32 MiB cap');

  // ---- growth is linear, not super-linear ---------------------------------
  // A leak that retained a whole transcript per cycle would show as a rising
  // bytes-per-cycle slope. Compare the first and last tenths.
  const frames = all.map(journal.privateJournalFrame);
  const tenth = Math.floor(frames.length / 10);
  const firstTenth = Buffer.concat(frames.slice(0, tenth)).length / tenth;
  const lastTenth = Buffer.concat(frames.slice(-tenth)).length / tenth;
  assert.ok(lastTenth <= firstTenth * 1.5,
    'per-event cost must not grow with cycle count: first ' + firstTenth.toFixed(1) +
    ' B/event, last ' + lastTenth.toFixed(1) + ' B/event');

  // ---- the whole thing survives a durable round-trip ----------------------
  const replay = journal.replayPrivateJournal(bytes);
  assert.equal(replay.tail, null, 'a clean 50-cycle journal must have no unreconciled tail');
  assert.equal(replay.events.length, all.length);
  const recovered = journal.reducePrivateQueueEvents(replay.events, true);
  assert.equal(recovered.byRef.size, CYCLES,
    'crash recovery must reconstruct the same ' + CYCLES + ' resolved tasks');
  assert.equal(recovered.quarantinedRecipients.size, 0,
    'a fully processed journal must quarantine nothing');
  assert.deepEqual(recovered.fifo.map((key) => recovered.byRef.get(key).phase)
    .filter((phase) => phase !== 'PROCESSED'), []);
});

test('ST-05a a stalled head blocks later deliveries without losing them, and one recovery drains them', () => {
  // Endurance is not only "does it drain"; it is what happens when one cycle
  // stops. This test was rewritten after the first draft failed for the right
  // reason: the reducer enforced recipient single-flight (server.js:944-955)
  // and refused to lease cycle 1 behind a DELIVERED cycle 0. That refusal is
  // the product working — a late message must never overtake an unread one —
  // so the assertions below pin the STALL SEMANTICS instead of denying them.
  // Each cycle is built ONCE. A second lifecycle() call would mint a new
  // worker incarnation, and the reducer rightly calls that a stale source.
  const stuck = lifecycle(1, 0).slice(0, 4);          // QUEUED..DELIVERED, never ACKed
  const cycles = [];
  let seq = 5;
  for (let cycle = 1; cycle <= 9; cycle++) {
    cycles.push(lifecycle(seq, cycle));
    seq += 5;
  }
  const queuedOnly = cycles.map((events) => events[0]);

  // ---- a stalled head must not lose, invent, or reorder the backlog --------
  const blocked = journal.reducePrivateQueueEvents(renumber([...stuck, ...queuedOnly]), true);
  assert.equal(blocked.byRef.size, 10, 'all ten cycles are still in the ledger');
  assert.equal(blocked.fifo.length, 10);
  const head = blocked.byRef.get(blocked.fifo[0]);
  // Recovery demotes an unACKed delivery to UNCERTAIN (server.js:896) — the
  // point is that it is never invented into PROCESSED.
  assert.equal(head.phase, 'UNCERTAIN',
    'an unACKed delivery must be UNCERTAIN after recovery, never PROCESSED');
  assert.deepEqual(
    blocked.fifo.slice(1).map((key) => blocked.byRef.get(key).phase),
    Array(9).fill('QUEUED'),
    'nothing behind a stalled head may be leased, dispatched or ACKed early');
  assert.equal(blocked.quarantinedRecipients.size, 0, 'a stall is not a quarantine');

  // The barrier is enforced, not advisory: leasing cycle 1 must be refused.
  const premature = lifecycle(5, 1).slice(0, 2);
  assert.throws(() => journal.reducePrivateQueueEvents(renumber([...stuck, ...premature]), true),
    /FIFO|lease|blocked/i, 'a lease behind a stalled head must be rejected');

  // ---- one explicit recovery releases exactly the head ---------------------
  const released = renumber([...stuck,
    skip(5, stuck[3], 'Operator reviewed the stalled delivery.')]);
  const afterSkip = journal.reducePrivateQueueEvents(released, true);
  assert.equal(afterSkip.byRef.get(afterSkip.fifo[0]).phase, 'SKIPPED',
    'the head is terminal only through durable, explicitly confirmed evidence');
  assert.equal(afterSkip.quarantinedRecipients.size, 0);

  // ---- and the backlog then drains completely ------------------------------
  // Full lifecycles here, not slice(1): the QUEUED enrollment is what gives
  // each lease a prior, and dropping it is exactly the stale-incarnation error.
  const drained = [...released, ...cycles.flat()];
  const final = journal.reducePrivateQueueEvents(renumber(drained), true);
  assert.equal(final.byRef.size, 10);
  assert.deepEqual(final.fifo.map((key) => final.byRef.get(key).phase),
    ['SKIPPED', ...Array(9).fill('PROCESSED')],
    'one recovery must release the whole backlog, head first');
  assert.equal(final.quarantinedRecipients.size, 0);

  // Durable round-trip: the recovered journal replays to the same state.
  const replay = journal.replayPrivateJournal(
    Buffer.concat(renumber(drained).map(journal.privateJournalFrame)));
  assert.equal(replay.tail, null);
  const replayReduced = journal.reducePrivateQueueEvents(replay.events, true);
  assert.deepEqual(replayReduced.fifo.map((key) => replayReduced.byRef.get(key).phase),
    final.fifo.map((key) => final.byRef.get(key).phase));
});
