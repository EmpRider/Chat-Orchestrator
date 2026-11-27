// ST-04: an event larger than the chat-prompt budget must be stored intact and
// delivered without truncation. Every ingress clamps BEFORE the journal write
// (`enqueuePrivateStatus` rejects summary > 4000, `acceptPrivateWorkerReport`
// rejects a data frame > 48000), and the delivery summary previews the body to
// 3000 chars while carrying `full_report_ref` + `result_sha256`, so the Parent
// can always reach the full record. These assertions pin that contract: raise
// any ingress bound past the delivery budget and this file goes red.
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
const managerSource = recipient;

function queued(seq, entryType, data, source = managerSource) {
  const id = randomUUID();
  return {
    version: 4, seq, id, idempotencyKey: randomUUID(), kind: 'queue.transition',
    ownerScope: owner, source, recipient, ref: id,
    recordedAt: new Date().toISOString(),
    payload: { phase: 'QUEUED', entryType, leaseGeneration: 0, leaseNonce: null, data },
  };
}

function roundTrip(events) {
  const bytes = Buffer.concat(events.map(journal.privateJournalFrame));
  const replay = journal.replayPrivateJournal(bytes);
  assert.equal(replay.tail, null, 'oversized-but-bounded event must be a valid frame');
  return replay.events;
}

test('ST-04 the largest permitted status summary is stored byte-identically', () => {
  // enqueuePrivateStatus refuses > 4000, so 4000 is the true worst case.
  const summary = 'S'.repeat(4000);
  const [stored] = roundTrip([queued(1, 'STATUS_REQUEST', { summary })]);
  assert.equal(stored.payload.data.summary.length, 4000);
  assert.equal(stored.payload.data.summary, summary, 'no truncation at the ingress bound');
});

test('ST-04 a worker report near the frame bound keeps a full-record handle', () => {
  // acceptPrivateWorkerReport refuses a data JSON > 48000 bytes. The delivery
  // summary previews to 3000 chars but must carry the durable handle, so a
  // large answer is deferred in full, never silently cut.
  const result = 'R'.repeat(30000);
  const data = {
    taskId: randomUUID(), workerTabId: 201, site: 'chatgpt', status: 'done',
    result, error: null, originParentUrl: null,
    resultSha256: 'a'.repeat(64), elapsedSeconds: 12,
  };
  assert.ok(Buffer.byteLength(JSON.stringify(data)) < 48000,
    'fixture must stay inside the accepted ingress bound');
  const [stored] = roundTrip([queued(1, 'CHILD_RESULT', data)]);
  assert.equal(stored.payload.data.result.length, 30000,
    'the stored record keeps the whole answer');
  // What the Parent is shown comes from the REAL projection, not a copy of it.
  // A hand-built preview would pass even if production truncation regressed.
  const projected = JSON.parse(journal.privateQueueSummary(stored));
  assert.equal(projected.full_report_ref, stored.id);
  assert.equal(projected.result_sha256, 'a'.repeat(64));
  assert.equal(projected.result_preview.length, 3000);
  assert.equal(projected.preview_truncated, true,
    'the Parent must be told the preview is partial');
  assert.equal(projected.result_preview,
    stored.payload.data.result.slice(0, 3000));
  assert.equal(projected.task_id, stored.payload.data.taskId);
});

test('ST-04 an event past the frame limit is refused, never stored torn', () => {
  // The journal is the backstop: even if an ingress bound regressed, a frame
  // that cannot be framed must throw rather than write a partial record.
  assert.throws(
    () => journal.privateJournalFrame(queued(1, 'STATUS_REQUEST',
      { summary: 'S'.repeat(200000) })),
    /exceeds the size limit/);
});
