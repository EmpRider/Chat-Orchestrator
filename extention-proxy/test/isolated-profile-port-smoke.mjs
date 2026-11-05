// Manual Windows-only smoke: two disposable named profiles, distinct ports.
// The default running 8787 instance and its profile are never mutated.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('Windows Electron profile smoke only');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const appData = process.env.APPDATA;
assert.ok(appData && path.isAbsolute(appData), 'Explicit Windows APPDATA required');
assert.ok(fs.existsSync(electron), 'Local Electron binary is missing');
const profileRoot = path.join(appData, 'Chat Orchestrator Profiles');
fs.mkdirSync(profileRoot, { recursive: true });
const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
const names = ['qa' + suffix + 'a', 'qa' + suffix + 'b'];
const ports = [21871, 21872];
const owned = [];
const diagnosticLogs = new Map();
const launchEnv = { ...process.env, CHAT_ORCH_DIAGNOSTICS: '1' };
for (const name of ['CHAT_ORCH_E2E_MODE', 'CHAT_ORCH_E2E_PORT',
  'CHAT_ORCH_E2E_DATA_DIR', 'CHAT_ORCH_E2E_CDP_PORT', 'CHAT_ORCH_PACKAGED_SMOKE']) {
  delete launchEnv[name];
}
const created = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ping = async (port) => {
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/health', {
      signal: AbortSignal.timeout(700),
    });
    return response.ok ? response.json() : null;
  } catch { return null; }
};
const waitHealthy = async (port, child) => {
  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null) throw new Error('Profile ' + port + ' exited before readiness');
    const health = await ping(port);
    if (health?.ok === true && health.coordination?.enabled === false) return health;
    await delay(250);
  }
  throw new Error('Profile ' + port + ' failed health readiness');
};

try {
  for (const port of ports) {
    assert.equal(await ping(port), null, 'Test port is already occupied: ' + port);
  }
  const defaultBefore = await ping(8787);
  for (let i = 0; i < names.length; i++) {
    const dir = path.join(profileRoot, names[i]);
    fs.mkdirSync(dir, { recursive: false });
    created.push(dir);
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
      domain: '', minimizeToTray: false, privateCoordinationOptIn: false,
      proxyPort: ports[i],
    }));
    const child = spawn(electron, [root, '--profile=' + names[i]], {
      cwd: root, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
      env: launchEnv,
    });
    diagnosticLogs.set(child, '');
    child.stderr.on('data', (chunk) => {
      diagnosticLogs.set(child, (diagnosticLogs.get(child) + String(chunk)).slice(-1500));
    });
    owned.push(child);
  }
  try { await Promise.all(owned.map((child, i) => waitHealthy(ports[i], child))); }
  catch (error) {
    console.error('PROFILE_SMOKE_DIAGNOSTICS ' + owned.map((child, i) =>
      names[i] + ' exit=' + child.exitCode + ' stderr=' + diagnosticLogs.get(child)).join(' | '));
    throw error;
  }
  const tokens = created.map((dir) => fs.readFileSync(path.join(dir, 'bridge.token'), 'utf8').trim());
  assert.notEqual(tokens[0], tokens[1], 'Separate profiles must never reuse a bridge token');
  assert.deepEqual(created.map((dir) =>
    JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).proxyPort), ports);
  if (defaultBefore?.ok) assert.equal((await ping(8787))?.ok, true,
    'Default existing profile/port must remain healthy');
  console.log('PROFILE_PORT_SMOKE PASS profiles=2 separate_ports=2 separate_tokens=2 default_untouched=true');
} finally {
  for (const child of owned) {
    if (!child.pid || child.exitCode !== null) continue;
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
        { stdio: 'ignore', timeout: 5000 });
    } catch { child.kill(); }
  }
  await delay(750);
  for (const dir of created) {
    if (!dir.startsWith(profileRoot + path.sep) || !path.basename(dir).startsWith('qa' + suffix)) {
      throw new Error('Refusing unsafe test-profile cleanup path');
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch { console.warn('Disposable test profile could not be removed: ' + path.basename(dir)); }
  }
}
