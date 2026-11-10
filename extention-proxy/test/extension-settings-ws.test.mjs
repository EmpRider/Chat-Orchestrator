import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('local extension WebSocket needs no token; settings flow from proxy only', { timeout: 20000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chat-orch-settings-'));
  const file = path.join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify({ agentSettings: { enabled: true, promptSchema: 2,
    promptModules: { queue: 'Private queue processing instructions' } } }));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', CHAT_ORCH_PROFILE_DIR: dir,
      CHAT_ORCH_PRIVATE_COORDINATION: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ws;
  t.after(() => { ws?.terminate(); server.kill(); rmSync(dir, { recursive: true, force: true }); });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Proxy start timeout: ' + output)), 8000);
    server.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const found = /listening on http:\/\/[^:]+:(\d+)/.exec(output);
      if (found) { clearTimeout(timer); resolve(Number(found[1])); }
    });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('Proxy exited: ' + code)); });
  });
  ws = new WebSocket('ws://127.0.0.1:' + port + '/bridge');
  const messages = [];
  ws.on('message', (buf) => { try { messages.push(JSON.parse(buf.toString())); } catch {} });
  await once(ws, 'open');
  await delay(160);
  const snapshot = messages.find((m) => m.type === 'settings_snapshot');
  assert.ok(snapshot, 'extension receives proxy-owned settings without a token');
  assert.equal(snapshot.settings.promptModules.queue, 'Private queue processing instructions');
  ws.send(JSON.stringify({ type: 'settings_snapshot', schema: 1, revision: 333,
    settings: { enabled: false, promptSchema: 2, promptModules: { queue: 'Attempted overwrite' } } }));
  await delay(100);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).agentSettings.promptModules.queue,
    'Private queue processing instructions', 'extension WebSocket must not overwrite desktop-owned settings');
});
