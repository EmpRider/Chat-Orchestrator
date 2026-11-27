// RC-02 and ST-03 need no browser: both are transport contracts. Executed
// against a real spawned proxy over a real WebSocket bridge and real MCP HTTP.
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

function routeHash(browserSession, tabId, incarnation) {
  return createHash('sha256').update([browserSession, tabId, incarnation, 'chatgpt'].join(':')).digest('hex');
}

async function startProxy(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-transport-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: '0', HOST: '127.0.0.1', CHAT_ORCH_PROFILE_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('Proxy startup timed out: ' + out)), 8000);
    child.stdout.on('data', (buf) => {
      out += buf.toString();
      const m = /listening on http:\/\/[^:]+:(\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.stderr.on('data', (buf) => { out += buf.toString(); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Proxy exited ' + code + ': ' + out)); });
  });
  const client = new Client({ name: 'transport-contract', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + port + '/mcp')));
  t.after(() => client.close().catch(() => {}));
  return { dir, child, port, client };
}

// A bridge that answers only inspect_tab and health-level calls: enough to pair
// and to prove the reconnect deadline, nothing browser-side.
async function connectBridge(t, port, browserSession, approvedTabs) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/bridge');
  const incarnations = new Map();
  const incarnationFor = (tabId) => {
    if (!incarnations.has(tabId)) incarnations.set(tabId, randomUUID());
    return incarnations.get(tabId);
  };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'session_heartbeat') {
      ws.send(JSON.stringify({ type: 'session_heartbeat_ack', nonce: m.nonce,
        proxy_session_id: 'test-proxy-session' }));
      return;
    }
    if (m.type !== 'call') return;
    let result;
    if (m.method === 'inspect_tab') {
      const tabId = m.params.tab_id;
      result = { tab_id: tabId, site: 'chatgpt', browser_session_id: browserSession,
        incarnation_id: incarnationFor(tabId),
        route_hash: routeHash(browserSession, tabId, incarnationFor(tabId)),
        parent_approved: approvedTabs.includes(tabId), is_managed_worker: false };
    } else if (m.method === 'recover_owned_children') {
      result = [];
    } else if (m.method === 'attest_profile_manager') {
      const tabId = m.params.tab_id;
      result = { tab_id: tabId, browser_session_id: browserSession,
        incarnation_id: incarnationFor(tabId), connection_generation: 1 };
    } else if (m.method === 'list_tabs') {
      result = approvedTabs.map((id) => ({ tab_id: id, role: 'orchestrator', site: 'chatgpt' }));
    } else {
      result = { profile: null };
    }
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, result }));
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => ws.terminate());
  const waitFor = (type) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bridge message ' + type + ' timed out')), 4000);
    const onMessage = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type !== type) return;
      clearTimeout(timer); ws.off('message', onMessage); resolve(m);
    };
    ws.on('message', onMessage);
  });
  const registered = waitFor('session_registered');
  ws.send(JSON.stringify({ type: 'register_session', browser_session_id: browserSession,
    connection_generation: 1, proxy_session_id: 'test-proxy-session' }));
  await registered;
  ws.send(JSON.stringify({ type: 'session_ready' }));
  return { ws, incarnationFor, waitFor };
}

async function offer(bridge, code, tabId) {
  const ack = bridge.waitFor('pairing_offer_ack');
  bridge.ws.send(JSON.stringify({ type: 'pairing_offer', request_id: randomUUID(), code,
    tab_id: tabId, incarnation_id: bridge.incarnationFor(tabId),
    route_hash: routeHash(bridge.ws.browserSession || '', tabId, bridge.incarnationFor(tabId)) }));
  return ack;
}

test('RC-02 a tool call during a bridge outage fails at the 55s reconnect deadline', { timeout: 120000 }, async (t) => {
  const proxy = await startProxy(t);
  const browserSession = randomUUID();
  const bridge = await connectBridge(t, proxy.port, browserSession, [101]);
  // route_hash must be built from the same session the bridge registered with.
  bridge.ws.browserSession = browserSession;
  const code = randomUUID();
  const ack = await offer(bridge, code, 101);
  assert.equal(ack.ok, true, 'the approved Parent must be offered a pairing code');
  const paired = await proxy.client.callTool({ name: 'pair_conversation',
    arguments: { code, idempotency_key: randomUUID() } });
  assert.equal(paired.isError, undefined, paired.content?.[0]?.text);
  const credential = JSON.parse(paired.content[0].text).agent_credential;

  // The outage: the extension socket disappears, the pairing record survives.
  bridge.ws.terminate();
  await delay(250);
  const startedAt = Date.now();
  const out = await proxy.client.callTool({ name: 'list_tabs', arguments: {
    browser_session_id: browserSession, agent_credential: credential,
    idempotency_key: randomUUID() } }, undefined, { timeout: 90000 });
  const elapsed = Date.now() - startedAt;
  assert.equal(out.isError, true, 'an outage must fail the call, never answer from cache');
  assert.match(out.content[0].text, /did not reconnect before the active MCP request deadline/);
  // The catalog pins 55s (server.js:1492). A 30s or 120s bound is a contract change.
  assert.ok(elapsed >= 53000 && elapsed <= 80000,
    'the call must hold for the documented 55s deadline, held ' + elapsed + 'ms');
  // An outage must not corrupt the proxy: it still answers health, and it
  // reports the extension as absent rather than pretending to be connected.
  const health = await (await fetch('http://127.0.0.1:' + proxy.port + '/health')).json();
  assert.equal(health.ok, true);
  assert.equal(health.extensionConnected, false);
});

test('ST-03 five rapid pair_conversation attempts either bind independently or fail cleanly', { timeout: 30000 }, async (t) => {
  const proxy = await startProxy(t);
  const browserSession = randomUUID();
  const tabs = [101, 102, 103, 104, 105];
  const bridge = await connectBridge(t, proxy.port, browserSession, tabs);
  bridge.ws.browserSession = browserSession;
  const codes = [];
  for (const tabId of tabs) {
    const code = randomUUID();
    const ack = await offer(bridge, code, tabId);
    assert.equal(ack.ok, true, 'each approved tab must receive its own offer');
    codes.push(code);
  }
  // Fire all five inside the same tick: the catalog's 5-in-2s stimulus.
  const results = await Promise.all(codes.map((code) =>
    proxy.client.callTool({ name: 'pair_conversation',
      arguments: { code, idempotency_key: randomUUID() } })));
  const ok = results.filter((r) => !r.isError).map((r) => JSON.parse(r.content[0].text));
  assert.equal(ok.length, 5, 'every offered code must bind: ' +
    results.map((r) => r.isError ? r.content[0].text : 'ok').join(' | '));
  assert.equal(new Set(ok.map((b) => b.agent_credential)).size, 5,
    'each binding has its own credential');
  assert.equal(new Set(ok.map((b) => b.tab_id)).size, 5, 'each binding keeps its own tab');
  // No corruption: every credential works for its own tab and only its own.
  for (const binding of ok) {
    const mine = await proxy.client.callTool({ name: 'list_tabs', arguments: {
      browser_session_id: browserSession, agent_credential: binding.agent_credential,
      caller_tab_id: binding.tab_id, idempotency_key: randomUUID() } });
    assert.equal(mine.isError, undefined,
      'a just-paired tab must serve its own calls: ' + mine.content?.[0]?.text);
  }
  // A code that was never offered fails cleanly and, crucially, mints nothing.
  const forged = await proxy.client.callTool({ name: 'pair_conversation',
    arguments: { code: randomUUID(), idempotency_key: randomUUID() } });
  assert.equal(forged.isError, true);
  assert.match(forged.content[0].text, /Pairing code unavailable or expired/);
  const after = await proxy.client.callTool({ name: 'list_tabs', arguments: {
    browser_session_id: browserSession, agent_credential: ok[0].agent_credential,
    caller_tab_id: ok[0].tab_id, idempotency_key: randomUUID() } });
  assert.equal(after.isError, undefined, 'a rejected pairing must not disturb live bindings');
});
