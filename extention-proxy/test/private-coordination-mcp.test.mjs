
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createPrincipalCredential } from '../principal-auth.mjs';
import { privateJournalTestHooks } from '../server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = 'synthetic-test-bridge';
const EXTENSION_SECRET = 'private-extension-test-secret-0123456789abcdef';
const WORKER_INCAR = randomUUID();
const TASK_ID = randomUUID();
const TASK_FIXTURES = [
  { id: TASK_ID, tabId: 201, incarnation: WORKER_INCAR, result: 'Synthetic immutable full report' },
  { id: randomUUID(), tabId: 202, incarnation: randomUUID(), result: 'Second child verified report' },
  { id: randomUUID(), tabId: 203, incarnation: randomUUID(), result: 'Third child verified report' },
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('private opt-in batches three child results around status, with scope, Saga and uncertain holds', {
  timeout: 30000,
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-private-mcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'bridge.token'), SHARED);
  fs.writeFileSync(path.join(dir, 'coordination.events.journal'), '');
  const registry = path.join(dir, 'coordination-principals.json');
  const browserSessionId = randomUUID();
  const a = createPrincipalCredential(registry, {
    role: 'pm', workspaceId: 'work-A', projectId: '4', orchestratorId: 'p0',
    parentTaskId: '65', callerTabId: 101,
    browserSessionId, managerIncarnationId: randomUUID(),
  });
  const b = createPrincipalCredential(registry, {
    role: 'tl', workspaceId: 'work-B', projectId: '4', orchestratorId: 'p0',
    parentTaskId: '65', callerTabId: 102,
    browserSessionId, managerIncarnationId: randomUUID(),
  });
  let boardSubtaskDone = false;
  let boardNoteText = '';
  const sagaBoard = http.createServer((req, res) => {
    if (req.url !== '/api/tasks/65') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 65, epic_id: 14, project_id: 4, status: 'in_progress',
      subtasks: [{ id: 128, task_id: 65, status: boardSubtaskDone ? 'done' : 'todo' }],
      notes: [{ id: 37, related_entity_type: 'task', related_entity_id: 65,
        content: boardNoteText }],
    }));
  });
  await new Promise((resolve) => sagaBoard.listen(0, '127.0.0.1', resolve));
  t.after(() => sagaBoard.close());
  const sagaPort = sagaBoard.address().port;
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: '0', BRIDGE_TOKEN: SHARED,
      BRIDGE_TOKEN_FILE: path.join(dir, 'bridge.token'), CHAT_ORCH_PRIVATE_COORDINATION: '1',
      EXTENSION_BRIDGE_TOKEN: EXTENSION_SECRET,
      SAGA_READBACK_BASE_URL: 'http://127.0.0.1:' + sagaPort },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const clients = [];
  let bridge;
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    bridge?.close();
    proc.kill();
  });
  let output = '';
  proc.stdout.on('data', (b) => { output += b; });
  proc.stderr.on('data', (b) => { output += b; });
  let port = 0;
  for (let i = 0; i < 140 && !port; i++) {
    port = Number(output.match(/listening on http:\/\/[^:]+:(\d+)/)?.[1] || 0);
    if (!port) await sleep(50);
  }
  assert.ok(port, output);
  const denied = new WebSocket('ws://127.0.0.1:' + port + '/bridge?token=' + SHARED);
  await new Promise((resolve, reject) => {
    denied.once('unexpected-response', (_request, response) => {
      assert.equal(response.statusCode, 401, 'shared MCP token cannot impersonate private extension');
      response.resume(); resolve();
    });
    denied.once('open', () => reject(new Error('Shared token unexpectedly upgraded private bridge')));
    denied.once('error', reject);
  });
  const forwarded = new WebSocket('ws://127.0.0.1:' + port + '/bridge?token=' + EXTENSION_SECRET,
    { headers: { 'X-Forwarded-For': '203.0.113.9' } });
  await new Promise((resolve, reject) => {
    forwarded.once('unexpected-response', (_request, response) => {
      assert.equal(response.statusCode, 401, 'tunneled caller cannot take local extension channel');
      response.resume(); resolve();
    });
    forwarded.once('open', () => reject(new Error('Forwarded request upgraded private bridge')));
    forwarded.once('error', reject);
  });
  bridge = new WebSocket('ws://127.0.0.1:' + port + '/bridge?token=' + EXTENSION_SECRET);
  let queueCapability;
  const receipts = new Map();
  const wakes = [];
  let failNextWake = false;
  let wrongIncarnationOnce = false;
  let managerBusy = true;
  let managerUnknown = false;
  let processedBatches = 0;
  let verifiedCloseCount = 0;
  const response = async (message) => {
    const p = message.params?.__trustedPrincipal;
    let result;
    if (message.method === 'manager_state') result = { tab_id: p.callerTabId,
      state: managerUnknown ? 'unknown' : managerBusy ? 'busy' : 'idle', ready: !managerBusy,
      browser_session_id: p.browserSessionId,
      incarnation_id: wrongIncarnationOnce ? (wrongIncarnationOnce = false, randomUUID()) : p.sessionIncarnationId };
    else if (message.method === 'wake_manager') {
      wakes.push(message.params);
      result = { submitted: !failNextWake, uncertain: failNextWake };
      failNextWake = false;
    }
    else if (message.method === 'manager_processed') { processedBatches++; result = { processed: true }; }
    else if (message.method === 'close_verified_worker') { verifiedCloseCount++; result = { closed: 201, saga_verified: true }; }
    else if (message.method === 'get_result') {
      if (p.credentialId !== a.principal.credentialId) {
        bridge.send(JSON.stringify({ type: 'result', id: message.id, ok: false, error: 'Wrong owner' }));
        return;
      }
      const task = TASK_FIXTURES.find((item) => item.id === message.params.task_id);
      if (!task) {
        bridge.send(JSON.stringify({ type: 'result', id: message.id, ok: false, error: 'Task absent' }));
        return;
      }
      result = { task_id: task.id, tab_id: task.tabId, status: 'done',
        source_incarnation_id: task.incarnation, site: 'chatgpt',
        result: task.result, elapsed_seconds: 3 };
    } else if (message.method === 'list_tabs') {
      result = p.credentialId === a.principal.credentialId
        ? TASK_FIXTURES.map((item) => ({ tab_id: item.tabId, role: 'worker', incarnation_id: item.incarnation })) : [];
    } else result = {};
    bridge.send(JSON.stringify({ type: 'result', id: message.id, ok: true, result }));
  };
  const onBridgeMessage = (bytes) => {
    const message = JSON.parse(bytes.toString());
    if (message.type === 'coordination_capabilities') queueCapability = message.queue_enabled;
    else if (message.type === 'call') void response(message);
    else if (message.type === 'worker_event_receipt') {
      const handler = receipts.get(message.request_id);
      if (handler) { receipts.delete(message.request_id); handler(message); }
    }
  };
  bridge.on('message', onBridgeMessage);
  await new Promise((resolve, reject) => { bridge.once('open', resolve); bridge.once('error', reject); });
  for (let i = 0; queueCapability === undefined && i < 50; i++) await sleep(20);
  assert.equal(queueCapability, true);
  const health = await (await fetch('http://127.0.0.1:' + port + '/health')).json();
  assert.equal(health.coordination.storageReady, true);
  assert.equal(health.coordination.enabled, false);
  async function client(token) {
    const c = new Client({ name: 'private-queue-test', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(
      new URL('http://127.0.0.1:' + port + '/mcp?token=' + encodeURIComponent(token)),
    ));
    clients.push(c); return c;
  }
  const A = await client(a.token);
  const B = await client(b.token);
  const legacy = await client(SHARED);
  async function call(c, name, args = {}) {
    const out = await c.callTool({ name, arguments: args });
    if (out.isError) throw new Error(out.content[0].text);
    return JSON.parse(out.content[0].text);
  }
  await assert.rejects(call(legacy, 'coordination_register_manager'), /authenticated scoped manager/);
  wrongIncarnationOnce = true;
  await assert.rejects(call(A, 'coordination_register_manager'), /could not be attested/);
  assert.equal((await call(A, 'coordination_register_manager')).registered, true);
  assert.equal((await call(B, 'coordination_register_manager')).registered, true);
  async function workerReceipt(fixture = TASK_FIXTURES[0]) {
    const id = randomUUID();
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { receipts.delete(id); reject(new Error('Journal receipt timeout')); }, 4000);
      receipts.set(id, (receipt) => { clearTimeout(timer); resolve(receipt); });
    });
    bridge.send(JSON.stringify({
      type: 'worker_done', request_id: id, task_id: fixture.id, tab_id: fixture.tabId,
      credential_id: a.principal.credentialId, worker_incarnation_id: fixture.incarnation,
    }));
    return promise;
  }
  const first = await workerReceipt();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.receipt.durably_recorded, true);
  const key = randomUUID();
  const status = await call(A, 'coordination_status_request', {
    idempotency_key: key, summary: 'Status after child one, before children two and three',
  });
  assert.equal(status.state, 'QUEUED');
  assert.equal((await call(A, 'coordination_status_request', {
    idempotency_key: key, summary: 'Status after child one, before children two and three',
  })).event_id, status.event_id);
  const duplicate = await workerReceipt();
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.receipt.event_id, first.receipt.event_id);
  const second = await workerReceipt(TASK_FIXTURES[1]);
  const third = await workerReceipt(TASK_FIXTURES[2]);
  assert.equal(second.ok, true);
  assert.equal(third.ok, true);
  assert.notEqual(second.receipt.event_id, third.receipt.event_id);
  const fullReport = await call(A, 'coordination_get_report', {
    event_id: first.receipt.full_report_ref,
  });
  assert.equal(fullReport.report.result, 'Synthetic immutable full report');
  assert.equal(fullReport.result_sha256, first.receipt.result_sha256);
  await assert.rejects(call(B, 'coordination_get_report', {
    event_id: first.receipt.full_report_ref,
  }), /Unknown immutable report in this caller scope/);

  const own = await call(A, 'coordination_pending');
  assert.deepEqual(own.events.map((x) => x.entryType),
    ['CHILD_RESULT', 'STATUS_REQUEST', 'CHILD_RESULT', 'CHILD_RESULT']);
  assert.equal((await call(B, 'coordination_pending')).events.length, 0);
  const bytes = fs.readFileSync(path.join(dir, 'coordination.events.journal'));
  const scan = privateJournalTestHooks.replayPrivateJournal(bytes);
  assert.equal(scan.tail, null);
  assert.equal(scan.events.length, 4, 'idempotent duplicate did not add a fifth event');
  assert.equal((await call(A, 'coordination_start_delivery')).armed, true);
  await sleep(250);
  assert.equal(wakes.length, 0, 'busy manager must receive no prompt');
  managerUnknown = true;
  managerBusy = false;
  await sleep(250);
  assert.equal(wakes.length, 0, 'unknown manager readiness must not dispatch');
  managerUnknown = false;
  let delivered = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    const pending = await call(A, 'coordination_pending');
    delivered = pending.events.length === 4 && pending.events.every((x) => x.phase === 'DELIVERED');
    if (delivered) break;
    await sleep(50);
  }
  assert.equal(delivered, true, 'single batch reached durable DELIVERED');
  assert.equal(wakes.length, 1, 'one manager prompt, never one per child');
  assert.deepEqual(wakes[0].events.map((x) => x.type),
    ['CHILD_RESULT', 'STATUS_REQUEST', 'CHILD_RESULT', 'CHILD_RESULT']);
  await assert.rejects(call(B, 'coordination_ack_batch', {
    batch_id: wakes[0].batch_id, event_ids: wakes[0].events.map((x) => x.event_id),
  }), /does not match/);
  await assert.rejects(call(A, 'coordination_ack_batch', {
    batch_id: wakes[0].batch_id, event_ids: [randomUUID()],
  }), /does not match/);
  const ack = await call(A, 'coordination_ack_batch', {
    batch_id: wakes[0].batch_id, event_ids: wakes[0].events.map((x) => x.event_id),
  });
  assert.deepEqual(ack.processed, wakes[0].events.map((x) => x.event_id));
  assert.equal(ack.saga_confirmed, false);
  assert.equal(processedBatches, 1);
  const processed = await call(A, 'coordination_pending');
  assert.ok(processed.events.every((x) => x.phase === 'PROCESSED'));
  const closeEvidence = {
    tab_id: 201, saga_task_id: 65, saga_subtask_id: 128,
    saga_note_id: 37, saga_event_id: first.receipt.event_id,
  };
  boardNoteText = 'CHATORCH_SAGA_VERIFIED ' + [
    first.receipt.event_id, TASK_ID, '201', a.principal.credentialId,
  ].join(' ');
  await assert.rejects(call(A, 'close_worker', closeEvidence), /task\/subtask not complete/);
  assert.equal(verifiedCloseCount, 0, 'unfinished Saga work never closes a tab');
  await assert.rejects(call(B, 'close_worker', closeEvidence), /no processed journal ACK/);
  boardSubtaskDone = true;
  const released = await call(A, 'close_worker', closeEvidence);
  assert.equal(released.saga_verified, true);
  assert.equal(verifiedCloseCount, 1);
  const sagaConfirmed = await call(A, 'coordination_pending');
  assert.equal(sagaConfirmed.events.find((x) =>
    x.ref === first.receipt.event_id).phase, 'SAGA_CONFIRMED');

  // Real proxy-originated child-loss event: one durable receipt, one scoped manager wake,
  // and a concise event-specific instruction (no workspace/delegation boilerplate).
  const childLossRequestId = randomUUID();
  const childLossReceipt = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      receipts.delete(childLossRequestId);
      reject(new Error('Child-loss journal receipt timed out'));
    }, 4000);
    receipts.set(childLossRequestId, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
  bridge.send(JSON.stringify({
    type: 'worker_lost', request_id: childLossRequestId,
    event_key: randomUUID(), task_id: TASK_FIXTURES[1].id,
    tab_id: TASK_FIXTURES[1].tabId,
    credential_id: a.principal.credentialId,
    worker_incarnation_id: TASK_FIXTURES[1].incarnation,
    saved_url: 'https://chatgpt.com/c/recover-child-two',
  }));
  const lossReceipt = await childLossReceipt;
  assert.equal(lossReceipt.ok, true, JSON.stringify(lossReceipt));
  assert.equal(lossReceipt.receipt.durably_recorded, true);
  let childLossDelivered = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    const pending = await call(A, 'coordination_pending');
    childLossDelivered = pending.events.some((x) =>
      x.ref === lossReceipt.receipt.event_id && x.phase === 'DELIVERED');
    if (childLossDelivered) break;
    await sleep(50);
  }
  assert.equal(childLossDelivered, true, 'child-loss event must reach real manager wake');
  assert.equal(wakes.length, 2);
  assert.deepEqual(wakes[1].events.map((x) => x.type), ['CHILD_TAB_LOST']);
  assert.match(wakes[1].prompt_text, /read_chat/);
  assert.match(wakes[1].prompt_text, /get_result/);
  assert.match(wakes[1].prompt_text, /saved_url/);
  assert.match(wakes[1].prompt_text, /recover-child-two/);
  assert.doesNotMatch(wakes[1].prompt_text, /@AgentBridge|When a task requires files/);
  const lossAck = await call(A, 'coordination_ack_batch', {
    batch_id: wakes[1].batch_id,
    event_ids: wakes[1].events.map((x) => x.event_id),
  });
  assert.deepEqual(lossAck.processed, [lossReceipt.receipt.event_id]);

  // A journal-accepted 32 KB worker report must NOT block FIFO at the
  // extension's 20 KB per-summary boundary: queue a bounded preview + immutable ref.
  const large = { id: randomUUID(), tabId: 205, incarnation: randomUUID(),
    result: 'Long verified worker report: ' + 'R'.repeat(32000) };
  TASK_FIXTURES.push(large);
  const largeReceipt = await workerReceipt(large);
  assert.equal(largeReceipt.ok, true, JSON.stringify(largeReceipt));
  let largeDelivered = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    const pending = await call(A, 'coordination_pending');
    largeDelivered = pending.events.some((x) =>
      x.ref === largeReceipt.receipt.event_id && x.phase === 'DELIVERED');
    if (largeDelivered) break;
    await sleep(50);
  }
  assert.equal(largeDelivered, true, 'large immutable report must not starve oldest FIFO dispatch');
  assert.equal(wakes.length, 3);
  assert.deepEqual(wakes[2].events.map((x) => x.type), ['CHILD_RESULT']);
  const summary = JSON.parse(wakes[2].events[0].summary);
  assert.equal(summary.full_report_ref, largeReceipt.receipt.full_report_ref);
  assert.equal(summary.preview_truncated, true);
  assert.ok(summary.result_preview.length <= 3000);
  assert.ok(wakes[2].events[0].summary.length <= 20000);
  assert.match(wakes[2].prompt_text, /coordination_get_report/);
  assert.doesNotMatch(wakes[2].prompt_text, /@AgentBridge|@Worker Tool/);
  const restored = await call(A, 'coordination_get_report', {
    event_id: largeReceipt.receipt.full_report_ref,
  });
  assert.equal(restored.report.result, large.result, 'immutable full report remains retrievable');
  const largeAck = await call(A, 'coordination_ack_batch', {
    batch_id: wakes[2].batch_id,
    event_ids: wakes[2].events.map((x) => x.event_id),
  });
  assert.deepEqual(largeAck.processed, [largeReceipt.receipt.event_id]);

  await sleep(200);
  assert.equal(wakes.length, 3, 'ACK does not replay a completed batch');
  const oldBridge = bridge;
  const bridgeClosed = new Promise((resolve) => oldBridge.once('close', resolve));
  oldBridge.close();
  await bridgeClosed;
  const disconnectedHealth = await (await fetch('http://127.0.0.1:' + port + '/health')).json();
  assert.equal(disconnectedHealth.extensionConnected, false, 'disconnected bridge must be visible as disconnected');
  assert.equal((await call(A, 'coordination_pending')).events.length, 6,
    'disconnect must not lose committed pending journal state');
  queueCapability = undefined;
  bridge = new WebSocket('ws://127.0.0.1:' + port + '/bridge?token=' + EXTENSION_SECRET);
  bridge.on('message', onBridgeMessage);
  await new Promise((resolve, reject) => { bridge.once('open', resolve); bridge.once('error', reject); });
  for (let i = 0; queueCapability === undefined && i < 50; i++) await sleep(20);
  assert.equal(queueCapability, true, 'extension reconnect restores private capability handshake');
  assert.equal((await call(A, 'coordination_pending')).events.length, 6);
  await sleep(150);
  assert.equal(wakes.length, 3, 'reconnect must not replay an acknowledged batch');
  failNextWake = true;
  const held = await call(A, 'coordination_status_request', {
    idempotency_key: randomUUID(), summary: 'Second status needs manual reconciliation',
  });
  let uncertain = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    const pending = await call(A, 'coordination_pending');
    uncertain = pending.events.some((x) => x.ref === held.event_id && x.phase === 'UNCERTAIN');
    if (uncertain) break;
    await sleep(50);
  }
  assert.equal(uncertain, true, 'ambiguous submission becomes durable UNCERTAIN');
  assert.equal(wakes.length, 4);
  await call(A, 'coordination_status_request', {
    idempotency_key: randomUUID(), summary: 'Must not overtake uncertain status',
  });
  await sleep(300);
  assert.equal(wakes.length, 4, 'uncertain predecessor blocks all later automatic wakes');

  await assert.rejects(call(A, 'coordination_status_request', {
    idempotency_key: randomUUID(), summary: 'x'.repeat(4001),
  }), /maximum|too big|at most|Invalid status request/i);
  const beforeOversize = (await call(A, 'coordination_pending')).events.length;
  const oversized = { id: randomUUID(), tabId: 204, incarnation: randomUUID(),
    result: 'Oversized immutable report ' + 'X'.repeat(50000) };
  TASK_FIXTURES.push(oversized);
  const rejected = await workerReceipt(oversized);
  assert.equal(rejected.ok, false, 'oversized full report must fail, never truncate');
  assert.match(JSON.stringify(rejected), /Durable worker receipt unavailable; reconcile without replay/,
    'private bridge must not expose journal internals to the extension');
  assert.equal((await call(A, 'coordination_pending')).events.length, beforeOversize,
    'rejected report cannot append a truncated or ambiguous journal event');


});
