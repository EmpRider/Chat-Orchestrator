import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function launch(directory) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: '0', BRIDGE_TOKEN: 'fixture-private-token',
      BRIDGE_TOKEN_FILE: path.join(directory, 'bridge.token'),
      CHAT_ORCH_PRIVATE_COORDINATION: '1',
      EXTENSION_BRIDGE_TOKEN: 'private-extension-disk-test-token-0123456789',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (data) => { output += data; });
  proc.stderr.on('data', (data) => { output += data; });
  return { proc, output: () => output };
}

test('private disk preflight opens only preprovisioned journal and refuses crash-stale owner lock', {
  timeout: 25000,
}, async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-journal-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'coordination.events.journal');
  const lock = file + '.lock';
  fs.writeFileSync(path.join(folder, 'bridge.token'), 'fixture-private-token');
  // Explicit provisioning is a prerequisite, not a durable power-loss guarantee.
  fs.writeFileSync(file, '');
  const first = launch(folder);
  t.after(() => first.proc.kill());
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    port = Number(first.output().match(/listening on http:\/\/[^:]+:(\d+)/)?.[1] || 0);
    if (!port) await sleep(50);
  }
  assert.ok(port, first.output());
  const health = await (await fetch('http://127.0.0.1:' + port + '/health')).json();
  assert.equal(health.coordination.enabled, false, 'no false operational dispatch claim');
  assert.equal(health.coordination.storageReady, true);
  assert.ok(fs.existsSync(lock), 'private single-writer owner lock exists');
  first.proc.kill();
  await new Promise((resolve) => first.proc.once('exit', resolve));
  assert.ok(fs.existsSync(lock), 'crash leaves lock for manual owner reconciliation');

  const second = launch(folder);
  t.after(() => second.proc.kill());
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 7000);
    second.proc.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });
  assert.notEqual(code, 'timeout', second.output());
  assert.notEqual(code, 0, 'stale owner refuses startup');
  assert.match(second.output(), /owner lock exists|owner unknown|PRIVATE_JOURNAL_OWNER_UNKNOWN/i);
  assert.ok(fs.existsSync(lock), 'stale lock was NOT automatically deleted');
});
