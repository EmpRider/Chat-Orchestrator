// RC-03 / CM-13 / ST-06 — outage and restart contracts, executed against real
// spawned proxies on private ports. The live 8787 proxy is never touched.
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
const routeHash = (session, tabId, incarnation) => createHash('sha256')
  .update([session, tabId, incarnation, 'chatgpt'].join(':')).digest('hex');

async function startProxy(t, { port = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-outage-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1',
      CHAT_ORCH_PROFILE_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { try { child.kill(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const boundPort = await new Promise((resolve, reject) => {
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
  return { child, dir, port: boundPort };
}

async function mcpClient(t, port) {
  const client = new Client({ name: 'outage-contract', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + port + '/mcp')));
  t.after(() => client.close().catch(() => {}));
  return client;
}

async function bridgeFor(t, port, browserSession,
  { generation = 1, ignoreRef = null, incarnations = new Map() } = {}) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/bridge');
  ws.browserSession = browserSession;
  // Incarnation identifies the tab DOCUMENT and outlives a socket outage; only
  // the connection generation changes on reconnect. A fresh incarnation per
  // bridge would (correctly) be treated as "Paired tab or conversation changed;
  // re-pair" by resolveCaller at server.js:195-198 — see RC-03.
  const incarnationFor = (tabId) => {
    if (!incarnations.has(tabId)) incarnations.set(tabId, randomUUID());
    return incarnations.get(tabId);
  };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'session_heartbeat') {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'session_heartbeat_ack', nonce: m.nonce,
        proxy_session_id: 'test-proxy-session' }));
      return;
    }
    if (m.type !== 'call') return;
    // The outage lever: one call the extension is told about and never answers.
    // Ignoring a method permanently would also break the post-timeout control
    // assertion, which needs the very next call to behave normally.
    if (ignoreRef && m.method === ignoreRef.method && ignoreRef.armed) {
      ignoreRef.armed = false;
      return;
    }
    let result;
    if (m.method === 'inspect_tab') {
      const tabId = m.params.tab_id;
      result = { tab_id: tabId, site: 'chatgpt', browser_session_id: browserSession,
        incarnation_id: incarnationFor(tabId),
        route_hash: routeHash(browserSession, tabId, incarnationFor(tabId)),
        parent_approved: true, is_managed_worker: false };
    } else if (m.method === 'attest_profile_manager') {
      const tabId = m.params.tab_id;
      result = { tab_id: tabId, browser_session_id: browserSession,
        incarnation_id: incarnationFor(tabId), connection_generation: generation };
    } else if (m.method === 'recover_owned_children') {
      result = [];
    } else if (m.method === 'list_tabs') {
      result = [{ tab_id: 101, role: 'orchestrator', site: 'chatgpt' }];
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
    connection_generation: generation, proxy_session_id: 'test-proxy-session' }));
  await registered;
  ws.send(JSON.stringify({ type: 'session_ready' }));
  return { ws, incarnationFor, waitFor };
}

async function pair(client, bridge, tabId = 101) {
  const code = randomUUID();
  const ack = bridge.waitFor('pairing_offer_ack');
  bridge.ws.send(JSON.stringify({ type: 'pairing_offer', request_id: randomUUID(), code,
    tab_id: tabId, incarnation_id: bridge.incarnationFor(tabId),
    route_hash: routeHash(bridge.ws.browserSession, tabId, bridge.incarnationFor(tabId)) }));
  const acked = await ack;
  assert.equal(acked.ok, true, 'pairing offer must be acknowledged: ' + acked.error);
  const out = await client.callTool({ name: 'pair_conversation',
    arguments: { code, idempotency_key: randomUUID() } });
  assert.equal(out.isError, undefined, out.content?.[0]?.text);
  return JSON.parse(out.content[0].text).agent_credential;
}

test('CM-13 an extension that never answers fails the call at the 120s bridge timeout', { timeout: 180000 }, async (t) => {
  const proxy = await startProxy(t);
  const session = randomUUID();
  // The extension answers inspection (so identity resolves) and silently drops
  // exactly one list_tabs request — the outage the catalog describes.
  const dropNext = { method: 'list_tabs', armed: true };
  const bridge = await bridgeFor(t, proxy.port, session, { ignoreRef: dropNext });
  const client = await mcpClient(t, proxy.port);
  const credential = await pair(client, bridge);
  assert.equal(dropNext.armed, true, 'pairing must not consume the drop');
  const startedAt = Date.now();
  const out = await client.callTool({ name: 'list_tabs',
    arguments: { browser_session_id: session, agent_credential: credential,
      idempotency_key: randomUUID() } }, undefined, { timeout: 170000 });
  const elapsed = Date.now() - startedAt;
  assert.equal(dropNext.armed, false, 'the dropped request is the one that timed out');
  assert.equal(out.isError, true, 'an unanswered bridge call must fail, never hang forever');
  assert.match(out.content[0].text, /timed out after 120s/,
    'the bound must be the documented 120s default (server.js:1547), got: ' + out.content[0].text);
  assert.ok(elapsed >= 118000 && elapsed <= 150000, 'measured ' + elapsed + 'ms');
  // A timeout must not poison the socket or the pending map: the next call,
  // with a fresh idempotency key, is served normally.
  const after = await client.callTool({ name: 'list_tabs',
    arguments: { browser_session_id: session, agent_credential: credential,
      idempotency_key: randomUUID() } }, undefined, { timeout: 30000 });
  assert.equal(after.isError, undefined,
    'one timed-out call must not break the next one: ' + after.content?.[0]?.text);
  assert.equal(JSON.parse(after.content[0].text).length, 1);
});

test('RC-03 a real 5m11s outage fails every call and recovery succeeds after reconnect', { timeout: 480000 }, async (t) => {
  const proxy = await startProxy(t);
  const session = randomUUID();
  const incarnations = new Map();
  const bridge = await bridgeFor(t, proxy.port, session, { incarnations });
  const client = await mcpClient(t, proxy.port);
  const credential = await pair(client, bridge);
  const callList = () => client.callTool({ name: 'list_tabs',
    arguments: { browser_session_id: session, agent_credential: credential,
      idempotency_key: randomUUID() } }, undefined, { timeout: 90000 });
  assert.equal((await callList()).isError, undefined, 'a healthy bridge must serve calls');

  const outageStartedAt = Date.now();
  bridge.ws.terminate();
  await delay(250);
  const during = await callList();
  assert.equal(during.isError, true, 'a call issued into the outage must fail');
  assert.match(during.content[0].text, /did not reconnect before the active MCP request deadline/);
  const health = await (await fetch('http://127.0.0.1:' + proxy.port + '/health')).json();
  assert.equal(health.extensionConnected, false, 'the outage is visible in health');

  // The catalog's real-world window: 5m11s. Waited, not simulated.
  const remaining = 311000 - (Date.now() - outageStartedAt);
  if (remaining > 0) await delay(remaining);
  const midOutage = await callList();
  assert.equal(midOutage.isError, true, 'still failing after the full window');

  // Recovery: the same browser session and the same tab incarnation reconnect
  // on a higher connection generation.
  const reconnected = await bridgeFor(t, proxy.port, session, { generation: 2, incarnations });
  assert.equal(reconnected.incarnationFor(101), bridge.incarnationFor(101),
    'a reconnect is the same tab document, not a replacement');
  await delay(300);
  const recoveredHealth = await (await fetch('http://127.0.0.1:' + proxy.port + '/health')).json();
  assert.equal(recoveredHealth.extensionConnected, true, 'health must report the reconnection');
  const after = await callList();
  assert.equal(after.isError, undefined,
    'every call must succeed again once the extension reconnects: ' + after.content?.[0]?.text);
  assert.equal(JSON.parse(after.content[0].text).length, 1);
  // Re-registering must have replaced, not duplicated, the socket for this session.
  assert.equal(reconnected.ws.readyState, 1);
});

test('ST-06 a proxy restart leaves no orphaned session socket and accepts every reconnect', { timeout: 120000 }, async (t) => {
  const first = await startProxy(t);
  const port = first.port;
  const sessions = [randomUUID(), randomUUID(), randomUUID()];
  const bridges = [];
  for (const session of sessions) bridges.push(await bridgeFor(t, port, session));
  const client = await mcpClient(t, port);
  const credential = await pair(client, bridges[0]);
  await client.close().catch(() => {});
  let health = await (await fetch('http://127.0.0.1:' + port + '/health')).json();
  assert.equal(health.extensionConnected, true);

  // Restart on the same port, as the desktop app would.
  first.child.kill();
  await new Promise((resolve) => first.child.once('exit', resolve));
  const second = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1',
      CHAT_ORCH_PROFILE_DIR: first.dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { try { second.kill(); } catch {} });
  await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('Restart timed out: ' + out)), 10000);
    second.stdout.on('data', (buf) => {
      out += buf.toString();
      if (/listening on http/.test(out)) { clearTimeout(timer); resolve(); }
    });
    second.stderr.on('data', (buf) => { out += buf.toString(); });
    second.once('exit', (code) => { clearTimeout(timer); reject(new Error('Restart exited ' + code + ': ' + out)); });
  });
  health = await (await fetch('http://127.0.0.1:' + port + '/health')).json();
  assert.equal(health.ok, true, 'the restarted proxy must be healthy');
  assert.equal(health.extensionConnected, false,
    'a restarted proxy must not inherit a phantom connection');
  // The old sockets are gone, not silently still trusted.
  await delay(500);
  for (const bridge of bridges)
    assert.notEqual(bridge.ws.readyState, 1, 'the pre-restart socket must be closed');
  // Every session can re-register and is accepted exactly once.
  const again = [];
  for (const session of sessions) again.push(await bridgeFor(t, port, session, { generation: 2 }));
  await delay(300);
  health = await (await fetch('http://127.0.0.1:' + port + '/health')).json();
  assert.equal(health.extensionConnected, true,
    'all three sessions must reconnect after a restart');
});
