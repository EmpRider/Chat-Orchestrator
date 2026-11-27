// RC-10 (P1): Child pairing submission reconciliation against the REAL proxy.
// Stimulus: a Child prompt was submitted, but a ChatGPT DOM rewrite hid the user
// turn from the ordinary confirmation poll, so submission could not be proven.
// Expected: pairing that Child calls confirm_child_pairing_submission, records
// the submission as confirmed WITHOUT re-submitting the original prompt, and
// leaves the durable journal without a duplicate QUEUED record.
// Every case spawns its own server.js on PORT=0 with a disposable profile dir;
// the live proxy on 8787 is never touched.
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
const PARENT_TAB = 101;
const CHILD_TAB = 201;
const NEXT_CHILD_TAB = 202;
// Every browser RPC that can create a tab or submit a prompt. The reconcile
// path must not increase this count at all.
const SUBMIT_SHAPED = new Set([
  'spawn_worker', 'start_prepared_worker', 'send_to_tab', 'wake_manager', 'reopen_child',
]);

function disposableProfile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-rc10-'));
  const journalPath = path.join(dir, 'coordination.events.journal');
  fs.writeFileSync(journalPath, '');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, journalPath };
}

function spawnProxy(t, dir) {
  const env = {
    ...process.env, PORT: '0', HOST: '127.0.0.1',
    CHAT_ORCH_PROFILE_DIR: dir, CHAT_ORCH_SETTINGS_DIR: dir,
    CHAT_ORCH_PRIVATE_COORDINATION: '1',
  };
  delete env.CHAT_ORCH_EXTENSION_PROFILE_TOKEN;
  delete env.CHAT_ORCH_JOURNAL_DIR;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
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
  port.catch(() => {});
  return { child, port, output: () => output };
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

function routeHashFor(session, tabId, incarnationId) {
  return createHash('sha256')
    .update([session, tabId, incarnationId, 'chatgpt'].join(':')).digest('hex');
}

async function connectMcp(port) {
  const client = new Client({ name: 'rc10-pairing', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL('http://127.0.0.1:' + port + '/mcp')));
  return client;
}

test('RC-10 child pairing reconciles an unprovable submission without replaying the prompt', { timeout: 40000 }, async (t) => {
  const startedAt = Date.now();
  const { dir, journalPath } = disposableProfile(t);
  const proxy = spawnProxy(t, dir);
  const port = await proxy.port;
  const session = randomUUID();
  const managerIncarnation = randomUUID();
  const childIncarnation = randomUUID();
  const nextChildIncarnation = randomUUID();
  const childTaskId = randomUUID();
  const nextTaskId = randomUUID();

  // Extension-side state: the Child's user turn was hidden by a DOM rewrite,
  // so the ordinary read-only poll cannot prove delivery until pairing.
  const childSubmission = { confirmed: false, evidence: null };
  const calls = [];
  let spawnPreparations = 0;
  const tabIncarnations = { [PARENT_TAB]: managerIncarnation, [CHILD_TAB]: childIncarnation };
  const submitCounts = new Map(); // method:tab -> count, submit-shaped only

  const tab = (tabId) => ({
    tab_id: tabId, site: 'chatgpt', browser_session_id: session,
    incarnation_id: tabIncarnations[tabId],
    route_hash: routeHashFor(session, tabId, tabIncarnations[tabId]),
    parent_approved: tabId === PARENT_TAB,
    is_managed_worker: tabId !== PARENT_TAB,
  });

  const bridge = new WebSocket('ws://127.0.0.1:' + port + '/bridge');
  bridge.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'session_heartbeat') {
      bridge.send(JSON.stringify({ type: 'session_heartbeat_ack', nonce: m.nonce,
        proxy_session_id: 'test-proxy-session' }));
      return;
    }
    if (m.type !== 'call') return;
    calls.push({ method: m.method, params: m.params });
    if (SUBMIT_SHAPED.has(m.method)) {
      const key = m.method + ':' + (m.params?.tab_id ?? '');
      submitCounts.set(key, (submitCounts.get(key) || 0) + 1);
    }
    let result;
    switch (m.method) {
      case 'inspect_tab':
        result = tab(m.params.tab_id);
        break;
      case 'recover_owned_children':
        result = [];
        break;
      case 'desktop_list_agent_closures':
        result = [];
        break;
      case 'manager_state':
        // Manager is busy: the FIFO pump must never dispatch a wake here.
        result = { tab_id: PARENT_TAB, state: 'busy', ready: false,
          browser_session_id: session, incarnation_id: managerIncarnation };
        break;
      case 'attest_profile_manager':
        result = { tab_id: m.params.tab_id, browser_session_id: session,
          incarnation_id: tabIncarnations[m.params.tab_id], connection_generation: 1 };
        break;
      case 'spawn_worker': {
        spawnPreparations++;
        // The first preparation is the original Child; the second is the
        // separate worker created AFTER the held original was reconciled.
        const reuse = spawnPreparations > 1;
        const preparedTab = reuse ? NEXT_CHILD_TAB : CHILD_TAB;
        // inspect_tab must attest the same incarnation the preparation returned.
        tabIncarnations[preparedTab] = reuse ? nextChildIncarnation : childIncarnation;
        result = { tab_id: preparedTab,
          incarnation_id: tabIncarnations[preparedTab],
          prepared: true, reused_tab: false };
        break;
      }
      case 'start_prepared_worker': {
        const isOriginal = m.params.tab_id === CHILD_TAB;
        result = isOriginal
          ? { task_id: childTaskId, tab_id: CHILD_TAB, status: 'uncertain',
              submission_confirmed: false }
          : { task_id: nextTaskId, tab_id: NEXT_CHILD_TAB, status: 'running',
              submission_confirmed: true };
        break;
      }
      case 'verify_worker_submission':
        // Ordinary confirmation poll. The hidden user turn keeps this false
        // until the Child's authenticated pairing records the evidence.
        result = { task_id: m.params.task_id, tab_id: m.params.tab_id,
          status: childSubmission.confirmed ? 'running' : 'uncertain',
          verified: childSubmission.confirmed,
          submission_confirmed: childSubmission.confirmed };
        break;
      case 'confirm_child_pairing_submission': {
        // Mirrors the extension guard in background.js:3128-3133.
        if (m.params.__verifiedChildPairing !== true ||
            m.params.__sessionBrowserId !== session ||
            m.params.tab_id !== CHILD_TAB ||
            m.params.worker_incarnation_id !== childIncarnation)
          throw new Error('Only the original verified Child pairing may confirm submission');
        childSubmission.confirmed = true;
        childSubmission.evidence = 'AUTHENTICATED_CHILD_PAIRING';
        result = { task_id: childTaskId, tab_id: CHILD_TAB, status: 'running',
          verified: true, submission_confirmed: true };
        break;
      }
      case 'inspect_worker_tasks':
        result = { tab_id: m.params.tab_id,
          worker_incarnation_id: childIncarnation,
          tasks: [{ task_id: childTaskId,
            status: childSubmission.confirmed ? 'running' : 'uncertain',
            parent_reviewed: false }] };
        break;
      default:
        result = {};
    }
    bridge.send(JSON.stringify({ type: 'result', id: m.id, ok: true, result }));
  });
  await new Promise((resolve, reject) => { bridge.once('open', resolve); bridge.once('error', reject); });
  const registered = waitMessage(bridge, (m) => m.type === 'session_registered', 5000,
    'session_registered');
  bridge.send(JSON.stringify({ type: 'register_session', browser_session_id: session,
    connection_generation: 1, proxy_session_id: 'test-proxy-session' }));
  assert.equal((await registered).connection_generation, 1);
  bridge.send(JSON.stringify({ type: 'session_ready' }));

  const client = await connectMcp(port);
  t.after(async () => { await client.close().catch(() => {}); bridge.terminate(); });

  const pair = async (tabId, incarnationId) => {
    const code = randomUUID();
    const ack = waitMessage(bridge, (m) => m.type === 'pairing_offer_ack', 5000,
      'pairing_offer_ack for tab ' + tabId);
    bridge.send(JSON.stringify({ type: 'pairing_offer', request_id: randomUUID(), code,
      tab_id: tabId, incarnation_id: incarnationId,
      route_hash: routeHashFor(session, tabId, incarnationId) }));
    assert.equal((await ack).ok, true, 'pairing offer must verify for tab ' + tabId);
    return client.callTool({ name: 'pair_conversation', arguments: {
      code, idempotency_key: randomUUID() } });
  };

  const parentPair = await pair(PARENT_TAB, managerIncarnation);
  assert.equal(parentPair.isError, undefined, parentPair.content?.[0]?.text);
  const credential = JSON.parse(parentPair.content[0].text).agent_credential;
  const call = async (name, args = {}) => {
    const out = await client.callTool({ name, arguments: {
      caller_tab_id: PARENT_TAB, browser_session_id: session,
      agent_credential: credential, idempotency_key: randomUUID(), ...args } });
    if (out.isError) throw new Error(out.content[0].text);
    return JSON.parse(out.content[0].text);
  };
  await call('coordination_register_manager');
  // Sentinel FIFO ref: pairing must not duplicate or rewrite this QUEUED event.
  const sentinel = await call('coordination_status_request',
    { summary: 'RC-10 sentinel barrier' });
  assert.equal(sentinel.state, 'QUEUED');
  const sentinelRef = sentinel.event_id;
  const queuedRefs = () => journal.replayPrivateJournal(fs.readFileSync(journalPath))
    .events.filter((e) => e.payload?.phase === 'QUEUED')
    .map((e) => e.ref);
  assert.deepEqual(queuedRefs(), [sentinelRef]);
  const journalBefore = fs.readFileSync(journalPath);

  // 1) Child prompt is submitted, but the DOM rewrite hides the user turn.
  //    The startup transport returns UNCERTAIN, and the read-only poll cannot
  //    prove delivery. The session-wide spawn FIFO is held.
  await assert.rejects(call('spawn_worker', { site: 'chatgpt', wait_seconds: 0,
    task: 'RC-10 child task whose user turn is hidden by a DOM rewrite' }),
  /Prepared worker tab 201 outcome UNCERTAIN; inspect the tab and registry before retrying: Child prompt submission was NOT verified/,
  'an unprovable submission must surface as UNCERTAIN, not success');
  assert.equal(childSubmission.confirmed, false);
  const prePairVerify = calls.filter((c) => c.method === 'verify_worker_submission');
  assert.ok(prePairVerify.length >= 1,
    'the ordinary confirmation poll must actually have been attempted');
  assert.equal(submitCounts.get('start_prepared_worker:' + CHILD_TAB), 1);

  await assert.rejects(call('spawn_worker', { site: 'chatgpt', wait_seconds: 0,
    task: 'A second worker must not start while the first submission is unproven' }),
  /Spawn FIFO is HELD: worker tab 201 has an unverified prompt submission/,
  'an unproven submission must hold new spawns before pairing');
  assert.equal(spawnPreparations, 1, 'the held FIFO must not prepare another worker');

  // 2) The Child pairs. Pairing must reconcile the ORIGINAL submission.
  const submitsBeforePair = new Map(submitCounts);
  const childPair = await pair(CHILD_TAB, childIncarnation);
  assert.equal(childPair.isError, undefined, childPair.content?.[0]?.text);
  const paired = JSON.parse(childPair.content[0].text);
  assert.equal(paired.paired, true);
  assert.equal(paired.no_browser_prompt_replayed, true);

  // No replay: not a single submit-shaped browser call across the reconcile.
  assert.deepEqual(submitCounts, submitsBeforePair,
    'pairing the Child must not re-dispatch any prompt or tab operation');
  assert.equal(submitCounts.get('start_prepared_worker:' + CHILD_TAB), 1,
    'the original Child prompt must be submitted exactly once');
  assert.equal(childSubmission.confirmed, true);
  assert.equal(childSubmission.evidence, 'AUTHENTICATED_CHILD_PAIRING');
  const confirmCall = calls.find((c) => c.method === 'confirm_child_pairing_submission');
  assert.ok(confirmCall, 'pairing an owned Child must call confirm_child_pairing_submission');
  assert.equal(confirmCall.params.__verifiedChildPairing, true);
  assert.equal(confirmCall.params.tab_id, CHILD_TAB);
  assert.equal(confirmCall.params.worker_incarnation_id, childIncarnation);

  // Proof is durable in the journal domain as well: byte-identical and no
  // duplicate QUEUED record for the existing ref.
  assert.equal(fs.readFileSync(journalPath).equals(journalBefore), true,
    'reconciliation must not append a journal record');
  assert.deepEqual(queuedRefs(), [sentinelRef],
    'no duplicate QUEUED record may be created for any ref');

  // Diagnostics record the accepted reconciliation, not a deferred evidence.
  const diagPath = path.join(dir, 'diagnostics-proxy.jsonl');
  const diag = fs.readFileSync(diagPath, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line));
  const reconciled = diag.filter((e) => e.msg === 'worker.pairing_submission_reconciled');
  assert.equal(reconciled.length, 1, 'one reconcile event expected: ' + JSON.stringify(diag));
  assert.equal(reconciled[0].data.verified, true);
  assert.equal(reconciled[0].data.tabId, CHILD_TAB);
  assert.equal(diag.some((e) => e.msg === 'worker.pairing_submission_evidence_deferred'), false,
    'verified evidence must not be reported as deferred');

  // 3) The next spawn clears the held FIFO through read-only verification of
  //    the ORIGINAL Child. It must not re-dispatch tab 201.
  const resumed = await call('spawn_worker', { site: 'chatgpt', wait_seconds: 0,
    task: 'A new worker after the original submission was reconciled' });
  assert.equal(resumed.tab_id, NEXT_CHILD_TAB);
  assert.equal(resumed.submission_confirmed, true);
  assert.equal(submitCounts.get('start_prepared_worker:' + CHILD_TAB), 1,
    'FIFO recovery must never replay the original prompt');
  assert.equal(submitCounts.get('start_prepared_worker:' + NEXT_CHILD_TAB), 1);

  console.log('RC-10 elapsed_ms=' + (Date.now() - startedAt));
});
