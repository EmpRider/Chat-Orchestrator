import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function waitForHealth(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Server did not become ready');
}

test('server uses desktop token path without printing the token', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chat-orch-server-'));
  const tokenFile = path.join(dir, 'config', 'bridge.token');
  const port = 8891;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BRIDGE_TOKEN: '', BRIDGE_TOKEN_FILE: tokenFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  try {
    await waitForHealth(port);
    assert.equal(existsSync(tokenFile), true);
    const token = readFileSync(tokenFile, 'utf8').trim();
    assert.match(token, /^[a-f0-9]{48}$/);
    assert.equal(output.includes(token), false);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
});
