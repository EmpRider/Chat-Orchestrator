// Manual real Edge + Electron smoke in an isolated, existing test profile.
// Never launches or stops the production profile/port. No journal repair.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import WebSocket from 'ws';

if (process.platform !== 'win32') throw new Error('Windows-only isolated smoke');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orchestrator-e2e-'));
const profile = path.join(tempRoot, 'app');
const edgeProfile = path.join(tempRoot, 'edge');
fs.mkdirSync(profile);
fs.mkdirSync(edgeProfile);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({privateCoordinationOptIn:false}));
const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const extensionDir = path.resolve(root, '..', 'extention');
for (const target of [profile, electronExe, edgeExe, extensionDir]) {
  assert.ok(fs.existsSync(target), 'Missing isolated smoke prerequisite: ' + target);
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function occupied(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({host:'127.0.0.1',port});
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}
async function waitFor(check, label, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  let error;
  while (Date.now() < end) {
    try { if (await check()) return; }
    catch (e) { error = e; }
    await pause(220);
  }
  throw new Error(label + (error ? ': ' + error.message : ''));
}
async function closeTestEdge() {
  let version;
  try { version = await (await fetch('http://127.0.0.1:9341/json/version')).json(); }
  catch { return; }
  if (!/Chrome|Edg/i.test(version.Browser || '') ||
      !version.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:9341/devtools/browser/')) {
    throw new Error('Refusing to close an unknown browser on test port 9341');
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  await pause(500);
  ws.close();
}
async function invokeTrustedDesktop(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Trusted desktop IPC timed out')), 30000);
      ws.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error || message.result?.exceptionDetails) {
          reject(new Error(message.error?.message || message.result.exceptionDetails.text));
        } else resolve(message.result?.result?.value);
      });
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  } finally { ws.close(); }
}
let electron;
let testEdgeStarted = false;
try {
  for (const port of [8899, 9339, 9341]) {
    if (await occupied(port)) throw new Error('Test port already occupied: ' + port);
  }
  const env = { ...process.env, CHAT_ORCH_E2E_MODE: '1',
    CHAT_ORCH_E2E_DATA_DIR: profile, CHAT_ORCH_E2E_PORT: '8899',
    CHAT_ORCH_E2E_CDP_PORT: '9339' };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = spawn(electronExe, [root], { cwd: root, env, windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'] });
  let electronError = '';
  electron.stderr.on('data', (data) => {
    electronError = (electronError + String(data)).slice(-2000);
  });
  let desktopTarget;
  await waitFor(async () => {
    if (electron.exitCode !== null) throw new Error('Electron exited: ' + electronError);
    try {
      const targets = await (await fetch('http://127.0.0.1:9339/json/list')).json();
      desktopTarget = targets.find((t) => t.type === 'page' &&
        t.url?.includes('/desktop/index.html') && t.webSocketDebuggerUrl);
      return Boolean(desktopTarget);
    } catch { return false; }
  }, 'Isolated Electron desktop readiness', 35000);
  const provisioned = await invokeTrustedDesktop(desktopTarget,
    '(async()=>{ await window.bridge.configurePrivateCoordination(true); await window.bridge.stop(); await window.bridge.start(); return (await window.bridge.status()).privateCoordinationOptIn === true; })()');
  assert.equal(provisioned, true, 'Trusted desktop journal provisioning failed');
  await waitFor(async () => {
    try {
      const health = await (await fetch('http://127.0.0.1:8899/health')).json();
      return health.coordination?.storageReady === true;
    } catch { return false; }
  }, 'Isolated private queue readiness', 35000);
  const edge = spawn(edgeExe, [
    '--remote-debugging-port=9341',
    '--user-data-dir=' + edgeProfile,
    '--load-extension=' + extensionDir,
    '--disable-extensions-except=' + extensionDir,
    '--no-first-run',
    'https://chatgpt.com/',
  ], { windowsHide: true, stdio: 'ignore' });
  edge.once('error', () => {});
  testEdgeStarted = true;
  await waitFor(async () => {
    try {
      const targets = await (await fetch('http://127.0.0.1:9341/json/list')).json();
      return targets.some((t) => t.type === 'service_worker' &&
        /^chrome-extension:\/\//.test(t.url || '') && t.url.endsWith('/background.js'));
    } catch { return false; }
  }, 'Isolated Edge extension readiness', 35000);
  const smokeEnv = { ...process.env,
    CHAT_ORCH_LIVE_WORKER_SMOKE: process.env.CHAT_ORCH_LIVE_WORKER_SMOKE ?? '1',
    CHAT_ORCH_SMOKE_PROFILE: profile };
  const smoke = spawn(process.execPath, [
    path.join(root, 'test', 'isolated-edge-extension-smoke.mjs'),
  ], { cwd: root, env: smokeEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [smoke.stdout, smoke.stderr]) {
    stream.on('data', (data) => { output = (output + String(data)).slice(-12000); });
  }
  let timeoutId;
  const result = await Promise.race([
    new Promise((resolve) => smoke.once('exit', (code) => resolve({ code }))),
    new Promise((resolve) => { timeoutId = setTimeout(() => resolve({ timedOut: true }), 240000); }),
  ]);
  clearTimeout(timeoutId);
  if (result.timedOut) {
    smoke.kill();
    throw new Error('Real Edge smoke timed out: ' + output);
  }
  if (result.code !== 0 || !output.includes('REAL_EDGE_EXTENSION_SMOKE_PASS')) {
    throw new Error('Real Edge smoke failed (code ' + result.code + '): ' + output);
  }
  process.stdout.write(output.slice(-5000));
} finally {
  let safeToRemove = true;
  if (testEdgeStarted) {
    try { await closeTestEdge(); }
    catch (error) {
      safeToRemove = false;
      process.stderr.write('Test Edge close needs inspection: ' + error.message + '\n');
    }
  }
  if (electron?.pid && electron.exitCode === null) {
    const stopped = spawnSync('taskkill.exe', ['/PID', String(electron.pid), '/T', '/F'],
      { windowsHide: true, timeout: 7000, stdio: 'ignore' });
    if (stopped.status !== 0) {
      safeToRemove = false;
      electron.kill();
    }
  }
  if (safeToRemove) {
    await pause(5000);
    try { fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 16, retryDelay: 500 }); }
    catch (error) { process.stderr.write('Isolated profile cleanup pending: ' + error.message + '\n'); }
  }
  else process.stderr.write('Preserved isolated test profile for process inspection: ' + tempRoot + '\n');
}
