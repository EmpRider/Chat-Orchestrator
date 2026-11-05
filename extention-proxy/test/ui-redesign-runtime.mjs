// Real isolated Electron rendering smoke. Never attaches to live profiles or ports.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const output = path.resolve(root, '..', 'test-output');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-redesign-'));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const proxyPort = await availablePort();
const cdpPort = await availablePort();
assert.notEqual(proxyPort, cdpPort);
const env = {
  ...process.env, CHAT_ORCH_E2E_MODE: '1', CHAT_ORCH_E2E_DATA_DIR: profile,
  CHAT_ORCH_E2E_PORT: String(proxyPort), CHAT_ORCH_E2E_CDP_PORT: String(cdpPort),
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [root], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', (data) => { stderr = (stderr + String(data)).slice(-2500); });
let ws;
try {
  let target;
  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null) throw new Error('Isolated Electron exited: ' + stderr);
    try {
      const res = await fetch('http://127.0.0.1:' + cdpPort + '/json/list',
        { signal: AbortSignal.timeout(500) });
      target = (await res.json()).find((item) =>
        item.type === 'page' && item.url.includes('/desktop/index.html'));
      if (target?.webSocketDebuggerUrl) break;
    } catch {}
    await pause(170);
  }
  assert.ok(target?.webSocketDebuggerUrl, 'Isolated Electron renderer unavailable: ' + stderr);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let sequence = 0;
  const pending = new Map();
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    const item = pending.get(msg.id);
    if (!item) return;
    pending.delete(msg.id);
    clearTimeout(item.timer);
    if (msg.error) item.reject(new Error(msg.error.message));
    else item.resolve(msg.result);
  });
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout')); }, 10000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails) + ' expression=' + expression);
    return response.result?.value;
  }
  const check = async (name, id) => {
    const expression = '(() => { const view = document.getElementById(' +
      JSON.stringify('view-' + name) + '); const rect = document.getElementById(' +
      JSON.stringify(id) + ').getBoundingClientRect(); const shell = document.querySelector(".app-shell");' +
      'return {visible: !view.hidden, controlVisible: rect.width > 0 && rect.height > 0,' +
      ' otherHidden: [...document.querySelectorAll(".app-view")].filter(x => x !== view).every(x => x.hidden),' +
      ' navCount: document.querySelectorAll(".nav-item").length,' +
      ' overflow: document.documentElement.scrollWidth - innerWidth,' +
      ' contentOverflow: shell.scrollWidth - shell.clientWidth}; })()';
    const result = await evaluate(expression);
    assert.equal(result.visible, true, name + ' hidden');
    assert.equal(result.controlVisible, true, id + ' invisible');
    assert.equal(result.otherHidden, true, 'other views visible');
    assert.equal(result.navCount, 4);
    assert.ok(result.overflow <= 1, name + ' body overflow: ' + result.overflow);
    assert.ok(result.contentOverflow <= 2, name + ' content overflow: ' + result.contentOverflow);
    return { name, ...result };
  };
  for (let i = 0; i < 60; i++) {
    if (await evaluate('document.readyState === "complete" && Boolean(document.getElementById("quick-extension-token"))')) break;
    await pause(150);
  }
  const results = [];
  await fs.promises.mkdir(output, { recursive: true });
  async function screenshot(name) {
    const capture = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await fs.promises.writeFile(path.join(output, 'redesign-' + name + '.png'),
      Buffer.from(capture.data, 'base64'));
  }
  results.push(await check('overview', 'quick-extension-token'));
  await screenshot('overview');
  for (const [name, control] of [
    ['connections', 'copy-extension-token'],
    ['agents', 'agent-seats'],
    ['settings', 'minimize-to-tray'],
  ]) {
    await evaluate('document.querySelector(' +
      JSON.stringify('[data-view="' + name + '"]') + ').click()');
    results.push(await check(name, control));
    await screenshot(name);
  }
  assert.equal(await evaluate(
    'document.querySelector("[data-view=settings]").getAttribute("aria-current")'), 'page');
  await evaluate('document.querySelector("[data-open-view=connections]").click()');
  assert.equal(await evaluate('document.getElementById("view-connections").hidden'), false);
  console.log('UI_REDESIGN_RUNTIME_PASS ' + JSON.stringify(results));
} finally {
  try { ws?.close(); } catch {}
  if (child.pid && child.exitCode === null) {
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
      { stdio: 'ignore', timeout: 5000 }); }
    catch { child.kill(); }
  }
  await pause(350);
  fs.rmSync(profile, { recursive: true, force: true });
}
