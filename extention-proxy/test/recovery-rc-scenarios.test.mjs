// REAL recovery scenarios RC-12 / RC-14 / RC-11 / RC-01 against an isolated
// proxy process and disposable journals. Never touches the live profile or the
// running desktop proxy; every case spawns its own server.js on PORT=0.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { privateJournalTestHooks as journal } from '../server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const owner = {
  principalId: randomUUID(), workspaceId: 'web-chat-automation',
  projectId: '4', orchestratorId: 'p0', parentTaskId: '65',
};
const recipientFor = (generation = 1, incarnationId = randomUUID(), tabId = 101) => ({
  type: 'manager_tab', tabId, incarnationId, connectionGeneration: generation,
});
const workerSrc = { type: 'worker_tab', tabId: 201, incarnationId: randomUUID(), connectionGeneration: 1 };

function queuedEvent(seq, entryType, recipient, source = workerSrc) {
  const id = randomUUID();
  return {
    version: 4, seq, id, idempotencyKey: randomUUID(), kind: 'queue.transition',
    ownerScope: owner, source, recipient, ref: id,
    recordedAt: new Date().toISOString(),
    payload: { phase: 'QUEUED', entryType, leaseGeneration: 0, leaseNonce: null,
      data: { summary: 'recovery-fixture-' + seq } },
  };
}
function transitionEvent(seq, original, recipient, phase, generation, nonce) {
  return {
    version: 4, seq, id: randomUUID(), idempotencyKey: randomUUID(),
    kind: 'queue.transition', ownerScope: owner, source: original.source,
    recipient, ref: original.ref, recordedAt: new Date().toISOString(),
    payload: { phase, ref: original.ref, leaseGeneration: generation, leaseNonce: nonce },
  };
}

function disposableProfile(t, journalBytes = Buffer.alloc(0)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-recovery-'));
  const journalPath = path.join(dir, 'coordination.events.journal');
  fs.writeFileSync(journalPath, journalBytes);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, journalPath };
}

function childEnv(dir) {
  const env = {
    ...process.env, PORT: '0', HOST: '127.0.0.1',
    CHAT_ORCH_PROFILE_DIR: dir, CHAT_ORCH_SETTINGS_DIR: dir,
    CHAT_ORCH_PRIVATE_COORDINATION: '1',
  };
  delete env.CHAT_ORCH_EXTENSION_PROFILE_TOKEN;
  delete env.CHAT_ORCH_JOURNAL_DIR;
  return env;
}

function spawnProxy(t, dir) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: childEnv(dir), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (b) => { output += b.toString(); });
  child.stderr.on('data', (b) => { output += b.toString(); });
  t.after(() => { try { child.kill(); } catch { /* already gone */ } });
  const port = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Proxy startup timed out: ' + output)), 10000);
    const scan = () => {
      const m = /listening on http:\/\/[^:]+:(\d+)/.exec(output);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    child.stdout.on('data', scan);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('Proxy exited ' + code + ': ' + output));
    });
  });
  port.catch(() => {}); // Startup-failure scenarios never await the port.
  return { child, port, output: () => output };
}

function waitExit(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve({ code: child.exitCode, signal: null });
    const timer = setTimeout(() => reject(new Error('Proxy did not exit')), timeoutMs);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

function waitMessage(ws, predicate, timeoutMs = 5000, label = 'message') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage); reject(new Error('Timed out waiting for ' + label));
    }, timeoutMs);
    const onMessage = (raw) => {
      const m = JSON.parse(raw.toString());
      if (!predicate(m)) return;
      clearTimeout(timer); ws.off('message', onMessage); resolve(m);
    };
    ws.on('message', onMessage);
  });
}

async function openBridge(port, { session, generation, handleCall }) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/bridge');
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'session_heartbeat') {
      ws.send(JSON.stringify({ type: 'session_heartbeat_ack', nonce: m.nonce,
        proxy_session_id: 'test-proxy-session' }));
      return;
    }
    if (m.type !== 'call') return;
    Promise.resolve()
      .then(() => handleCall(m))
      .then((result) => ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, result })))
      .catch((error) => ws.send(JSON.stringify({ type: 'result', id: m.id, ok: false,
        error: String(error?.message || error) })));
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const registered = waitMessage(ws, (m) => m.type === 'session_registered', 5000,
    'session_registered');
  ws.send(JSON.stringify({ type: 'register_session', browser_session_id: session,
    connection_generation: generation, proxy_session_id: 'test-proxy-session' }));
  const ack = await registered;
  assert.equal(ack.connection_generation, generation);
  ws.send(JSON.stringify({ type: 'session_ready' }));
  return ws;
}

// Fake extension handlers shared by the RC-14 / RC-11 / RC-01 scenarios.
function liveTab({ session, tabId, incarnationId, isManagedWorker, approved }) {
  return {
    tab_id: tabId, site: 'chatgpt', browser_session_id: session,
    incarnation_id: incarnationId,
    route_hash: createHash('sha256').update([session, tabId, incarnationId, 'chatgpt'].join(':')).digest('hex'),
    parent_approved: approved, is_managed_worker: isManagedWorker,
  };
}

async function pairParent(client, bridge, { session, tabId, incarnationId }) {
  const code = randomUUID();
  const ack = waitMessage(bridge, (m) => m.type === 'pairing_offer_ack', 5000, 'pairing_offer_ack');
  bridge.send(JSON.stringify({ type: 'pairing_offer', request_id: randomUUID(), code,
    tab_id: tabId, incarnation_id: incarnationId,
    route_hash: createHash('sha256').update([session, tabId, incarnationId, 'chatgpt'].join(':')).digest('hex') }));
  assert.equal((await ack).ok, true, 'pairing offer must verify');
  const paired = await client.callTool({ name: 'pair_conversation', arguments: {
    code, idempotency_key: randomUUID() } });
  assert.equal(paired.isError, undefined, paired.content?.[0]?.text);
  return JSON.parse(paired.content[0].text);
}

function toolCaller(client, { session, credential, callerTabId }) {
  return async (name, args = {}) => {
    const out = await client.callTool({ name, arguments: {
      caller_tab_id: callerTabId, browser_session_id: session,
      agent_credential: credential, idempotency_key: randomUUID(), ...args } });
    if (out.isError) throw new Error(out.content[0].text);
    return JSON.parse(out.content[0].text);
  };
}

async function connectMcp(port) {
  const client = new Client({ name: 'recovery-scenario', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL('http://127.0.0.1:' + port + '/mcp')));
  return client;
}

// ---------------------------------------------------------------- RC-12
test('RC-12 sequence gap is detected and never silently consumed', () => {
  const recipient = recipientFor();
  const first = queuedEvent(1, 'STATUS_REQUEST', recipient, recipient);
  const third = queuedEvent(3, 'STATUS_REQUEST', recipient, recipient);
  // Module level: a hand-built gap (seq 1 then seq 3) must throw, not reduce.
  assert.throws(() => journal.reducePrivateQueueEvents([first, third]),
    /Private queue sequence gap/,
    'a contiguous-seq reducer must reject a missing sequence number');
  // Disk level: the same gap in framed bytes is an unreconcilable tail.
  const replay = journal.replayPrivateJournal(
    Buffer.concat([journal.privateJournalFrame(first), journal.privateJournalFrame(third)]));
  assert.equal(replay.events.length, 1, 'only the contiguous prefix may be trusted');
  assert.equal(replay.tail?.reason, 'INVALID_EVENT');
  assert.equal(replay.validPrefixBytes, journal.privateJournalFrame(first).length);
});

test('RC-12 startup refuses a gapped journal, preserves bytes and releases its lock', { timeout: 20000 }, async (t) => {
  const recipient = recipientFor();
  const gapped = Buffer.concat([
    journal.privateJournalFrame(queuedEvent(1, 'STATUS_REQUEST', recipient, recipient)),
    journal.privateJournalFrame(queuedEvent(3, 'STATUS_REQUEST', recipient, recipient)),
  ]);
  const { dir, journalPath } = disposableProfile(t, gapped);
  const proxy = spawnProxy(t, dir);
  const exit = await waitExit(proxy.child);
  assert.equal(exit.code, 1, proxy.output());
  assert.match(proxy.output(),
    /Private journal tail requires explicit reconciliation: INVALID_EVENT/);
  assert.match(proxy.output(), /\[bridge\] startup error:/);
  assert.equal(fs.readFileSync(journalPath).equals(gapped), true,
    'no byte of the gapped journal may be truncated or rewritten');
  assert.equal(fs.existsSync(journalPath + '.lock'), false,
    'startup failure must release its own lock, never delete an unknown one');
});

// ---------------------------------------------------------------- RC-14
test('RC-14 generation bump surfaces historical events as RECONCILIATION_REQUIRED without ACK', { timeout: 25000 }, async (t) => {
  const { dir, journalPath } = disposableProfile(t);
  const proxy = spawnProxy(t, dir);
  const port = await proxy.port;
  const session = randomUUID();
  const managerIncarnation = randomUUID();
  let generation = 1;
  let managerState = 'busy';
  const handleCall = (m) => {
    switch (m.method) {
      case 'inspect_tab':
        return liveTab({ session, tabId: m.params.tab_id,
          incarnationId: m.params.tab_id === 101 ? managerIncarnation : randomUUID(),
          isManagedWorker: false, approved: m.params.tab_id === 101 });
      case 'recover_owned_children': return [];
      case 'manager_state':
        return { tab_id: 101, state: managerState, ready: managerState === 'idle',
          browser_session_id: session, incarnation_id: managerIncarnation };
      case 'attest_profile_manager':
        return { tab_id: m.params.tab_id, browser_session_id: session,
          incarnation_id: managerIncarnation, connection_generation: generation };
      case 'wake_manager': return { submitted: true, uncertain: false };
      default: return {};
    }
  };
  const bridge = await openBridge(port, { session, generation: 1, handleCall });
  const client = await connectMcp(port);
  t.after(async () => { await client.close().catch(() => {}); bridge.terminate(); });
  const paired = await pairParent(client, bridge, {
    session, tabId: 101, incarnationId: managerIncarnation });
  assert.equal(paired.recovery.attached, 0);
  const call = toolCaller(client, { session, credential: paired.agent_credential, callerTabId: 101 });
  await call('coordination_register_manager');
  const enqueued = await call('coordination_status_request',
    { summary: 'Status barrier before manager reconnect' });
  assert.equal(enqueued.state, 'QUEUED');
  await delay(300); // pump observes a busy manager and must not lease the event
  const bytesBefore = fs.readFileSync(journalPath);

  // Simulate a crash/reload: same tab, new connection generation, no re-pair.
  generation = 2;
  bridge.close();
  await delay(300);
  const bridge2 = await openBridge(port, { session, generation: 2, handleCall });
  t.after(() => bridge2.terminate());

  const conflicts = await call('coordination_incarnation_conflicts');
  assert.equal(conflicts.classification, 'RECONCILIATION_REQUIRED',
    'a prior unresolved generation must be reported, not adopted');
  assert.equal(conflicts.unresolved_event_count, 1);
  assert.equal(conflicts.conflicting_generations, 1);
  assert.equal(conflicts.historical_events_quarantined, false);
  assert.equal(conflicts.automatic_replay_allowed, false);
  assert.equal(conflicts.events[0].event_id, enqueued.event_id);
  assert.equal(conflicts.events[0].phase, 'QUEUED');
  assert.equal(conflicts.events[0].recipient_generation, 1);
  const pendingNow = await call('coordination_pending');
  assert.deepEqual(pendingNow.events, [],
    'the new generation must not see or implicitly ACK the historical event');
  assert.equal(fs.readFileSync(journalPath).equals(bytesBefore), true,
    'conflict inspection must not append any ACK or replay record');

  // The historical event is still inspectable read-only by its id.
  const predecessor = await call('coordination_get_predecessor_event',
    { event_id: enqueued.event_id });
  assert.equal(predecessor.event_id, enqueued.event_id);
  assert.equal(predecessor.historical_unprocessed, true);
  assert.equal(fs.readFileSync(journalPath).equals(bytesBefore), true);
});

// ---------------------------------------------------------------- RC-11
test('RC-11 re-pairing a Parent reattaches owned live descendants', { timeout: 25000 }, async (t) => {
  const { dir } = disposableProfile(t);
  const proxy = spawnProxy(t, dir);
  const port = await proxy.port;
  const session = randomUUID();
  const managerIncarnation = randomUUID();
  const childIncarnation = randomUUID();
  // reconstructLiveDescendants recurses through every reattached child, so
  // only the outermost inventory (the Parent's) owns the child.
  let childInventories = 1;
  const handleCall = (m) => {
    switch (m.method) {
      case 'inspect_tab':
        return liveTab({ session, tabId: m.params.tab_id,
          incarnationId: m.params.tab_id === 101 ? managerIncarnation : childIncarnation,
          isManagedWorker: m.params.tab_id !== 101, approved: m.params.tab_id === 101 });
      case 'recover_owned_children':
        return childInventories-- > 0
          ? [{ tab_id: 201, browser_session_id: session,
              incarnation_id: childIncarnation, site: 'chatgpt', is_managed_worker: true }]
          : [];
      case 'manager_state':
        return { tab_id: 101, state: 'busy', ready: false,
          browser_session_id: session, incarnation_id: managerIncarnation };
      case 'attest_profile_manager':
        return { tab_id: m.params.tab_id, browser_session_id: session,
          incarnation_id: managerIncarnation, connection_generation: 1 };
      default: return {};
    }
  };
  const bridge = await openBridge(port, { session, generation: 1, handleCall });
  const client = await connectMcp(port);
  t.after(async () => { await client.close().catch(() => {}); bridge.terminate(); });
  const paired = await pairParent(client, bridge, {
    session, tabId: 101, incarnationId: managerIncarnation });
  assert.deepEqual(paired.recovery, { attached: 1, held: 0 },
    'the still-live owned Child must be reattached to the re-paired Parent');
  assert.equal(paired.no_browser_prompt_replayed, true);
});

test('RC-11 descendant recovery failure flags reconciliation_required without failing pairing', { timeout: 25000 }, async (t) => {
  const { dir } = disposableProfile(t);
  const proxy = spawnProxy(t, dir);
  const port = await proxy.port;
  const session = randomUUID();
  const managerIncarnation = randomUUID();
  const handleCall = (m) => {
    switch (m.method) {
      case 'inspect_tab':
        return liveTab({ session, tabId: m.params.tab_id,
          incarnationId: managerIncarnation, isManagedWorker: false, approved: true });
      case 'recover_owned_children':
        throw new Error('Browser tab inventory unavailable');
      case 'manager_state':
        return { tab_id: 101, state: 'busy', ready: false,
          browser_session_id: session, incarnation_id: managerIncarnation };
      case 'attest_profile_manager':
        return { tab_id: m.params.tab_id, browser_session_id: session,
          incarnation_id: managerIncarnation, connection_generation: 1 };
      default: return {};
    }
  };
  const bridge = await openBridge(port, { session, generation: 1, handleCall });
  const client = await connectMcp(port);
  t.after(async () => { await client.close().catch(() => {}); bridge.terminate(); });
  const paired = await pairParent(client, bridge, {
    session, tabId: 101, incarnationId: managerIncarnation });
  assert.equal(paired.paired, true, 'pairing itself must remain valid');
  assert.equal(paired.recovery.attached, 0);
  assert.equal(paired.recovery.held, null);
  assert.equal(paired.recovery.reconciliation_required, true);
  assert.equal(paired.no_browser_prompt_replayed, true);
});

// ---------------------------------------------------------------- RC-01
test('RC-01 bridge drop and reconnect resumes the pending call with a new socket generation', { timeout: 30000 }, async (t) => {
  const { dir } = disposableProfile(t);
  const proxy = spawnProxy(t, dir);
  const port = await proxy.port;
  const session = randomUUID();
  const managerIncarnation = randomUUID();
  let secondGeneration = 1;
  const handleCall = (m) => {
    switch (m.method) {
      case 'inspect_tab':
        return liveTab({ session, tabId: m.params.tab_id,
          incarnationId: managerIncarnation, isManagedWorker: false, approved: true });
      case 'recover_owned_children': return [];
      case 'manager_state':
        return { tab_id: 101, state: 'busy', ready: false,
          browser_session_id: session, incarnation_id: managerIncarnation };
      case 'attest_profile_manager':
        return { tab_id: m.params.tab_id, browser_session_id: session,
          incarnation_id: managerIncarnation, connection_generation: secondGeneration };
      default: return {};
    }
  };
  const bridge = await openBridge(port, { session, generation: 1, handleCall });
  const client = await connectMcp(port);
  t.after(async () => { await client.close().catch(() => {}); bridge.terminate(); });
  const paired = await pairParent(client, bridge, {
    session, tabId: 101, incarnationId: managerIncarnation });
  const call = toolCaller(client, { session, credential: paired.agent_credential, callerTabId: 101 });

  secondGeneration = 2;
  bridge.close();
  await delay(400);
  // Issue the call while the extension is down: it must hold, not fail.
  const inFlight = call('coordination_pending');
  await delay(600);
  const bridge2 = await openBridge(port, { session, generation: 2, handleCall });
  t.after(() => bridge2.terminate());
  const resumed = await Promise.race([inFlight, delay(15000).then(() => {
    throw new Error('Pending call did not resume after reconnect');
  })]);
  assert.ok(Array.isArray(resumed.events), 'resumed call must return queue state');

  const diagPath = path.join(dir, 'diagnostics-proxy.jsonl');
  assert.equal(fs.existsSync(diagPath), true, 'socket generations must be observable');
  const events = fs.readFileSync(diagPath, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line))
    .filter((e) => e.msg === 'bridge.connected' || e.msg === 'bridge.disconnected')
    .map((e) => [e.msg, e.data.socketGeneration]);
  const firstConnect = events.findIndex(([m, g]) => m === 'bridge.connected' && g === 1);
  const disconnect = events.findIndex(([m, g]) => m === 'bridge.disconnected' && g === 1);
  const secondConnect = events.findIndex(([m, g]) => m === 'bridge.connected' && g === 2);
  assert.ok(firstConnect >= 0 && disconnect > firstConnect && secondConnect > disconnect,
    'expected bridge.connected(1), bridge.disconnected(1), bridge.connected(2): ' +
      JSON.stringify(events));
});
