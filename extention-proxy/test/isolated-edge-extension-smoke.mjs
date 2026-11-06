// Explicit manual smoke: isolated, disposable Edge profile and Electron45 only.
// Never point the profile/ports at a user's production browser or app.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const origin = 'http://127.0.0.1:8899';
const edgeCdp = 'http://127.0.0.1:9341';
const desktopCdp = 'http://127.0.0.1:9339';
const testProfile = process.env.CHAT_ORCH_SMOKE_PROFILE || 'D:\\web-chat-automation\\test-output\\p0-ui-profile';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (fn, label, maxMs = 18000) => {
  const end = Date.now() + maxMs;
  let last;
  while (Date.now() < end) {
    try { const out = await fn(); if (out) return out; } catch (err) { last = err; }
    await sleep(160);
  }
  throw new Error(label + (last ? ': ' + last.message : ''));
};
async function debuggerFor(port, predicate) {
  const target = await wait(async () => {
    const data = await (await fetch(port + '/json/list')).json();
    return data.find(predicate);
  }, 'CDP target unavailable');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let seq = 0;
  const waiting = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    const slot = waiting.get(msg.id);
    if (slot) {
      waiting.delete(msg.id);
      clearTimeout(slot.timer);
      msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result);
    }
  });
  async function call(method, params = {}) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(method + ' timed out')); }, 12000);
      waiting.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expr) {
    const result = await call('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ': ' +
        (result.exceptionDetails.exception?.description || 'renderer error'));
    }
    return result.result?.value;
  }
  return { call, evaluate, close: () => ws.close(), target };
}
const extension = await debuggerFor(edgeCdp, (t) =>
  t.type === 'service_worker' && /^chrome-extension:\/\//.test(t.url) && t.url.endsWith('/background.js'));
const desktop = await debuggerFor(desktopCdp, (t) =>
  t.type === 'page' && t.url.includes('/extention-proxy/desktop/index.html'));
let client;
let enrolled;
try {
  const startup = await (await fetch(origin + '/health')).json();
  assert.equal(startup.coordination.storageReady, true);
  // The disposable Edge profile may reconnect before CDP attaches on repeat runs.
  const secret = (await fs.readFile(testProfile + '/extension-bridge.token', 'utf8')).trim();
  assert.ok(secret.length >= 32);
  const setExpression = 'chrome.storage.local.set(' + JSON.stringify({
    serverUrl: 'ws://127.0.0.1:8899/bridge', token: secret, enabled: true,
  }) + ')';
  await extension.evaluate(setExpression);
  await wait(async () => (await (await fetch(origin + '/health')).json()).extensionConnected,
    'isolated real Edge extension did not connect');
  const tabs = await extension.evaluate('chrome.tabs.query({url:["https://chatgpt.com/*"]})');
  const manager = tabs.find((t) => t.id > 0);
  assert.ok(manager, 'No isolated ChatGPT tab in Edge profile');
  enrolled = await desktop.evaluate('window.bridge.enrollPrincipal(' + JSON.stringify({
    role: 'pm', seatName: 'P0 isolated Edge PM', workspaceId: 'p0-isolated-edge',
    projectId: '4', orchestratorId: 'edge-smoke', parentTaskId: '65',
    callerTabId: manager.id,
  }) + ')');
  assert.ok(enrolled.token?.length >= 32 && enrolled.principal?.callerTabId === manager.id);
  client = new Client({ name: 'real-edge-extension-smoke', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(origin + '/mcp?token=' + encodeURIComponent(enrolled.token))));
  async function call(name, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content[0]?.text || name + ' rejected');
    return JSON.parse(result.content[0].text);
  }
  const registered = await call('coordination_register_manager');
  assert.equal(registered.registered, true);
  assert.equal(registered.manager_tab_id, manager.id);
  let liveWorker = 'not-requested';
  let liveCount = 0;
  let key;
  let queued;
  const fullThreeChildSmoke = process.env.CHAT_ORCH_LIVE_WORKER_COUNT === '3';
  if (process.env.CHAT_ORCH_LIVE_WORKER_SMOKE === '1') {
    await extension.evaluate('chrome.storage.local.set({taskTimeoutMin:1,maxWorkers:10,maxTasksPerHour:100})');
    const expected = fullThreeChildSmoke ? 3 : 1;
    for (let child = 1; child <= expected; child++) {
      const spawned = await call('spawn_worker', {
        site: 'chatgpt', role: 'specialist', keep_open: true, wait_seconds: 0,
        task: 'Isolation smoke only. Reply with the exact text P0_E2E_OK_' + child + ' and nothing else.',
      });
      assert.ok(spawned.task_id && spawned.tab_id > 0);
      liveWorker = spawned.status;
      for (let i = 0; i < 6 && liveWorker === 'running'; i++) {
        const status = await call('get_result', { task_id: spawned.task_id, wait_seconds: 10 });
        liveWorker = status.status;
      }
      if (liveWorker !== 'done') {
        throw new Error('Isolated child ' + child + ' did not complete; status=' + liveWorker);
      }
      liveCount++;
      await wait(async () => {
        const next = await call('coordination_pending');
        return next.events.filter((item) => item.entryType === 'CHILD_RESULT').length === liveCount
          ? next : null;
      }, 'live child ' + child + ' did not reach durable parent queue', 20000);
      if (fullThreeChildSmoke && child === 1) {
        key = randomUUID();
        queued = await call('coordination_status_request', {
          idempotency_key: key, summary: 'Interleaved isolated status request after child one',
        });
      }
    }
  }
  if (!queued) {
    key = randomUUID();
    queued = await call('coordination_status_request', {
      idempotency_key: key, summary: 'Isolated live Edge extension verification only',
    });
  }
  assert.equal(queued.state, 'QUEUED');
  const repeated = await call('coordination_status_request', {
    idempotency_key: key,
    summary: fullThreeChildSmoke ? 'Interleaved isolated status request after child one'
      : 'Isolated live Edge extension verification only',
  });
  assert.equal(repeated.event_id, queued.event_id);
  let wakeDelivered = false;
  if (process.env.CHAT_ORCH_LIVE_WAKE === '1') {
    const expected = fullThreeChildSmoke
      ? ['CHILD_RESULT', 'STATUS_REQUEST', 'CHILD_RESULT', 'CHILD_RESULT']
      : liveCount === 1 ? ['CHILD_RESULT', 'STATUS_REQUEST'] : ['STATUS_REQUEST'];
    assert.equal((await call('coordination_start_delivery')).armed, true);
    const sent = await wait(async () => {
      const now = await call('coordination_pending');
      return now.events.length === expected.length &&
        now.events.every((item) => item.phase === 'DELIVERED') ? now : null;
    }, 'live Edge manager did not receive one combined batch', 30000);
    assert.deepEqual(sent.events.map((item) => item.entryType), expected);
    wakeDelivered = true;
  }
  let queuePromptVisible = false;
  if (wakeDelivered) {
    for (let i = 0; i < 12; i++) {
      const chat = await call('read_chat', {tab_id:manager.id,last_n:10}).catch(() => null);
      const transcript = chat?.transcript || '';
      if (transcript.includes('<queue_batch') && transcript.includes('STATUS_REQUEST')) {
        queuePromptVisible = true;
        break;
      }
      await sleep(250);
    }
  }
  const pending = await call('coordination_pending');
  assert.ok(pending.events.some((item) => item.ref === queued.event_id));
  const list = await call('list_tabs');
  assert.ok(list.some((tab) => tab.tab_id === manager.id && tab.role === 'orchestrator'));
  const denial = await call('close_worker', { tab_id: manager.id }).then(
    () => false, () => true);
  assert.equal(denial, true, 'manager tab must never be closable via worker method');
  await desktop.evaluate('window.bridge.revokePrincipal(' +
    JSON.stringify(enrolled.principal.credentialId) + ')');
  const revoked = await call('coordination_pending').then(() => false, () => true);
  assert.equal(revoked, true, 'revoked scoped credential still worked');
  console.log('REAL_EDGE_EXTENSION_SMOKE_PASS ' + JSON.stringify({
    realEdge: true, realElectron45: true, extensionConnected: true,
    managerTabId: manager.id, paired: true, durableStatus: true,
    deduplicated: true, ownScopeOnly: true, revokedDenied: true,
    managerChatIdle: registered.observation === 'idle', liveWorker, liveCount, wakeDelivered, queuePromptVisible,
  }));
} finally {
  if (enrolled?.principal?.credentialId) await desktop.evaluate('window.bridge.revokePrincipal(' +
    JSON.stringify(enrolled.principal.credentialId) + ')').catch(() => {});
  if (client) await client.close().catch(() => {});
  extension.close();
  desktop.close();
}
