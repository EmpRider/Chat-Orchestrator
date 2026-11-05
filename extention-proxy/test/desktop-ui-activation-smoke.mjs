// Manual isolated Electron integration smoke; never run against production CDP.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const endpoint = process.env.CHAT_ORCH_E2E_CDP_URL || 'http://127.0.0.1:9339';
const healthUrl = process.env.CHAT_ORCH_E2E_HEALTH_URL || 'http://127.0.0.1:8899/health';
if (!/^http:\/\/127\.0\.0\.1:[0-9]{4,5}$/.test(endpoint) ||
    !/^http:\/\/127\.0\.0\.1:[0-9]{4,5}\/health$/.test(healthUrl)) {
  throw new Error('Isolated loopback endpoints required');
}
const targets = await (await fetch(endpoint + '/json/list')).json();
const target = targets.find((item) => item.type === 'page' &&
  item.url?.endsWith('/extention-proxy/desktop/index.html'));
if (!target) throw new Error('Isolated Electron renderer not found');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let nextId = 1;
const pending = new Map();
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (!pending.has(msg.id)) return;
  const { resolve, reject, timer } = pending.get(msg.id);
  clearTimeout(timer); pending.delete(msg.id);
  if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
});
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout')); }, 10000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const value = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error('Renderer evaluation failed: ' + value.exceptionDetails.text);
  return value.result?.value;
}
const pause = (ms) => new Promise((res) => setTimeout(res, ms));
async function waitFor(predicate, message, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await predicate()) return;
    await pause(200);
  }
  throw new Error(message);
}
const initial = await evaluate('window.bridge.status().then(s => ({ phase: s.phase, optIn: s.privateCoordinationOptIn }))');
assert.equal(initial.phase, 'running');
assert.equal(initial.optIn, false, 'dedicated profile must begin with queue disabled');
await evaluate("(() => { document.getElementById('coordination-panel').open = true; document.getElementById('configure-private-coordination').click(); return true; })()");
await waitFor(async () => Boolean(await evaluate('window.bridge.status().then(s => s.privateCoordinationOptIn)')),
  'Private coordination toggle failed');
const pendingRestart = await evaluate('window.bridge.status().then(s => s.privateCoordinationRestartRequired)');
assert.equal(pendingRestart, true, 'activation must not silently change a running backend');
await evaluate('window.bridge.stop()');
await waitFor(async () => (await evaluate('window.bridge.status().then(s => s.phase)')) === 'stopped',
  'Isolated backend stop failed');
await evaluate('window.bridge.start()');
await waitFor(async () => (await evaluate('window.bridge.status().then(s => s.phase)')) === 'running',
  'Isolated backend restart failed');
const health = await (await fetch(healthUrl)).json();
assert.equal(health.ok, true);
assert.equal(health.coordination.storageReady, true, 'private journal failed Electron utilityProcess startup');
assert.equal(health.extensionConnected, false, 'do not attach live extension to isolated port');
const metrics = await evaluate(`(() => {
  const panel = document.getElementById('coordination-panel');
  const ids = ['coordination-summary','agent-seats','queue-items','tool-call-log','copy-extension-token'];
  return { panelOpen: panel.open, width: document.documentElement.scrollWidth,
    viewport: innerWidth, controls: ids.every(id => Boolean(document.getElementById(id))),
    background: getComputedStyle(document.body).backgroundColor };
})()`);
assert.equal(metrics.panelOpen, true);
assert.equal(metrics.controls, true);
assert.ok(metrics.width <= metrics.viewport + 20, 'desktop layout overflows horizontally');
const screenshot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../test-output/p0-ui-private-ready.png');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, Buffer.from(screenshot.data, 'base64'));
await evaluate('window.bridge.stop()');
await waitFor(async () => (await evaluate('window.bridge.status().then(s => s.phase)')) === 'stopped',
  'Isolated final graceful stop failed');
const profile = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../test-output/p0-ui-profile');
const staleLock = await fs.stat(path.join(profile, 'coordination.events.journal.lock'))
  .then(() => true).catch((error) => error.code === 'ENOENT' ? false : Promise.reject(error));
assert.equal(staleLock, false, 'graceful utilityProcess stop left owner lock');
ws.close();
console.log('E2E_UI_PRIVATE_ACTIVATION_PASS ' + JSON.stringify({ storageReady: true,
  realElectron: true, extensionConnected: false, staleLock, metrics }));
