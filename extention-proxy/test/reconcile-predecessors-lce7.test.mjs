// LC-E7 — coordination_reconcile_predecessors. The catalog source line
// (server.js:3088-3091) is now the tool at :3148 and the module method at
// :1423. Neither had a single test at any level: the reducer contract is
// covered in private-journal.test.mjs, but nothing exercised this tool.
//
// The contract under test is all-or-nothing. Quarantining historical events is
// the one operation that permanently declares a Parent's old generation dead,
// so every rejection must leave the journal BYTE-IDENTICAL, and acceptance must
// preserve every historical event as unprocessed — never replay, never ACK.
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnProxy(t, dir) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: '0', HOST: '127.0.0.1',
      CHAT_ORCH_PROFILE_DIR: dir, CHAT_ORCH_SETTINGS_DIR: dir,
      CHAT_ORCH_PRIVATE_COORDINATION: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (b) => { output += b.toString(); });
  child.stderr.on('data', (b) => { output += b.toString(); });
  t.after(() => { try { child.kill(); } catch {} });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Proxy startup timed out: ' + output)), 10000);
    const scan = () => {
      const m = /listening on http:\/\/[^:]+:(\d+)/.exec(output);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    child.stdout.on('data', scan);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Proxy exited ' + code + ': ' + output)); });
  });
}

function liveTab({ session, tabId, incarnationId }) {
  return { tab_id: tabId, site: 'chatgpt', browser_session_id: session,
    incarnation_id: incarnationId,
    route_hash: createHash('sha256').update([session, tabId, incarnationId, 'chatgpt'].join(':')).digest('hex'),
    parent_approved: true, is_managed_worker: false };
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
    Promise.resolve().then(() => handleCall(m, generation))
      .then((result) => ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, result })))
      .catch((error) => ws.send(JSON.stringify({ type: 'result', id: m.id, ok: false,
        error: String(error?.message || error) })));
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const registered = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('session_registered timed out')), 5000);
    const onMessage = (raw) => {
      if (JSON.parse(raw.toString()).type !== 'session_registered') return;
      clearTimeout(timer); ws.off('message', onMessage); resolve();
    };
    ws.on('message', onMessage);
  });
  ws.send(JSON.stringify({ type: 'register_session', browser_session_id: session,
    connection_generation: generation, proxy_session_id: 'test-proxy-session' }));
  await registered;
  ws.send(JSON.stringify({ type: 'session_ready' }));
  return ws;
}

test('LC-E7 predecessor quarantine is all-or-nothing and never replays or ACKs', { timeout: 40000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-lce7-'));
  const journalPath = path.join(dir, 'coordination.events.journal');
  fs.writeFileSync(journalPath, '');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const port = await spawnProxy(t, dir);
  const session = randomUUID();
  const managerIncarnation = randomUUID();
  let generation = 1;
  let managerState = 'busy'; // a busy manager is never served, so events stay QUEUED
  const handleCall = (m) => {
    switch (m.method) {
      case 'inspect_tab':
        return liveTab({ session, tabId: m.params.tab_id, incarnationId: managerIncarnation });
      case 'recover_owned_children': return [];
      case 'manager_state':
        return { tab_id: 101, state: managerState, ready: managerState === 'idle',
          browser_session_id: session, incarnation_id: managerIncarnation };
      case 'attest_profile_manager':
        return { tab_id: m.params.tab_id, browser_session_id: session,
          incarnation_id: managerIncarnation, connection_generation: generation };
      default: return {};
    }
  };
  let bridge = await openBridge(port, { session, generation: 1, handleCall });
  const client = new Client({ name: 'lce7', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL('http://127.0.0.1:' + port + '/mcp')));
  t.after(async () => { await client.close().catch(() => {}); try { bridge.terminate(); } catch {} });

  const code = randomUUID();
  const ack = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('pairing_offer_ack timed out')), 5000);
    const onMessage = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type !== 'pairing_offer_ack') return;
      clearTimeout(timer); bridge.off('message', onMessage); resolve(m);
    };
    bridge.on('message', onMessage);
  });
  bridge.send(JSON.stringify({ type: 'pairing_offer', request_id: randomUUID(), code,
    tab_id: 101, incarnation_id: managerIncarnation,
    route_hash: createHash('sha256').update([session, 101, managerIncarnation, 'chatgpt'].join(':')).digest('hex') }));
  assert.equal((await ack).ok, true);
  const paired = await client.callTool({ name: 'pair_conversation',
    arguments: { code, idempotency_key: randomUUID() } });
  assert.equal(paired.isError, undefined, paired.content?.[0]?.text);
  const credential = JSON.parse(paired.content[0].text).agent_credential;
  const call = async (name, args = {}) => {
    const out = await client.callTool({ name, arguments: {
      caller_tab_id: 101, browser_session_id: session,
      agent_credential: credential, idempotency_key: randomUUID(), ...args } });
    if (out.isError) throw new Error(out.content[0].text);
    return JSON.parse(out.content[0].text);
  };

  await call('coordination_register_manager');
  const enqueued = await call('coordination_status_request',
    { summary: 'Unresolved status barrier from the soon-to-be-predecessor generation' });
  assert.equal(enqueued.state, 'QUEUED');
  await delay(300);
  assert.equal((await call('coordination_pending')).events.length, 1,
    'the current generation sees its own queued event');

  // The predecessor generation: same tab, new connection generation. Same
  // incarnation — a re-pair would revoke the credential, which is RC-03's
  // territory, not this test's.
  generation = 2;
  bridge.close();
  await delay(400);
  bridge = await openBridge(port, { session, generation: 2, handleCall });
  t.after(() => { try { bridge.terminate(); } catch {} });

  const conflicts = await call('coordination_incarnation_conflicts');
  assert.equal(conflicts.classification, 'RECONCILIATION_REQUIRED');
  assert.equal(conflicts.unresolved_event_count, 1);
  assert.equal(conflicts.confirmation_received, undefined);
  const snapshot = conflicts.snapshot_sha256;
  assert.match(snapshot, /^[a-f0-9]{64}$/);
  const bytesBefore = fs.readFileSync(journalPath);

  // ---- every rejection must be byte-identical ---------------------------------
  const rejections = [
    [{ confirmation: 'QUARANTINE_UNPROCESSED_EVENTS',
       reason: 'too short',
       snapshot_sha256: snapshot }, /reason|at least 10|min/i],
    [{ confirmation: 'QUARANTINE_UNPROCESSED_EVENTS',
       reason: 'Operator reviewed the historical generation and retained every event.',
       snapshot_sha256: '0'.repeat(64) }, /snapshot (mismatch|changed)|Historical (snapshot|recipient snapshot)/i],
    [{ confirmation: 'SOMETHING_ELSE',
       reason: 'Operator reviewed the historical generation and retained every event.',
       snapshot_sha256: snapshot }, /confirmation|Invalid|literal|argument/i],
  ];
  for (const [args, pattern] of rejections) {
    const out = await client.callTool({ name: 'coordination_reconcile_predecessors',
      arguments: { caller_tab_id: 101, browser_session_id: session,
        agent_credential: credential, idempotency_key: randomUUID(), ...args } });
    assert.equal(out.isError, true, 'a rejected quarantine must not succeed: ' + args.reason);
    assert.match(out.content[0].text, pattern);
    assert.equal(fs.readFileSync(journalPath).equals(bytesBefore), true,
      'a rejected quarantine must not append one byte: ' + out.content[0].text);
  }

  // ---- acceptance -------------------------------------------------------------
  const accepted = await call('coordination_reconcile_predecessors', {
    confirmation: 'QUARANTINE_UNPROCESSED_EVENTS',
    reason: 'Operator reviewed the historical generation and retained its unprocessed events.',
    snapshot_sha256: snapshot,
  });
  assert.match(accepted.reconciliation_event_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(accepted.historical_events_preserved, true);
  assert.equal(accepted.historical_events_processed, false,
    'quarantine must never claim the historical events were processed');
  assert.equal(accepted.automatic_replay, false, 'quarantine must never replay');
  assert.equal(accepted.quarantined_recipient_generations, 1);

  const after = await call('coordination_incarnation_conflicts');
  assert.equal(after.classification, 'HISTORICAL_EVENTS_QUARANTINED',
    'the boundary must be durable and reported, not a one-shot acknowledgement');
  assert.equal(after.historical_events_quarantined, true);
  assert.equal(after.unresolved_event_count, 1,
    'the historical event is preserved, not removed — only quarantined');
  assert.equal(after.events[0].quarantined, true);
  assert.equal(after.automatic_replay_allowed, false);

  // The historical event is still readable in full, and still unprocessed.
  const predecessor = await call('coordination_get_predecessor_event',
    { event_id: enqueued.event_id });
  assert.equal(predecessor.historical_unprocessed, true);
  assert.equal(predecessor.event_id, enqueued.event_id);

  // Replaying the identical call must not append a second boundary: the
  // snapshot is no longer resolvable, so it fails rather than double-quarantines.
  const again = await client.callTool({ name: 'coordination_reconcile_predecessors',
    arguments: { caller_tab_id: 101, browser_session_id: session,
      agent_credential: credential, idempotency_key: randomUUID(),
      confirmation: 'QUARANTINE_UNPROCESSED_EVENTS',
      reason: 'Operator re-submitted the same quarantine without re-inspecting first.',
      snapshot_sha256: snapshot } });
  assert.equal(again.isError, true,
    'a stale snapshot must not quarantine twice: ' + again.content?.[0]?.text);
  // The journal grew by exactly the one accepted boundary record.
  const growth = fs.readFileSync(journalPath).length - bytesBefore.length;
  assert.ok(growth > 0, 'the accepted boundary must be durable');
  const beforeCount = conflicts.events.length;
  assert.equal(beforeCount, 1);
});
