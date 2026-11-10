import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('server starts without generating or requiring a bridge token', { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chat-orch-no-token-'));
  const tokenFile = path.join(dir, 'bridge.token');
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1',
      BRIDGE_TOKEN_FILE: tokenFile, BRIDGE_TOKEN: '', EXTENSION_BRIDGE_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { server.kill(); rmSync(dir, { recursive: true, force: true }); });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Server did not start: ' + output)), 8000);
    server.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const found = /listening on http:\/\/[^:]+:(\d+)/.exec(output);
      if (found) { clearTimeout(timer); resolve(Number(found[1])); }
    });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('Proxy exited: ' + code)); });
  });
  const health = await fetch('http://127.0.0.1:' + port + '/health');
  assert.equal(health.ok, true);
  assert.equal(existsSync(tokenFile), false, 'proxy must not provision obsolete token file');
});
