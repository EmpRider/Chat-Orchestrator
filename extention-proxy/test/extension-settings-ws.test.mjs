import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function health(port) {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {}
    await delay(100);
  }
  throw new Error('Isolated proxy did not start');
}
async function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?token=${token}`);
  const messages = [];
  ws.on('message', (data) => { try { messages.push(JSON.parse(data.toString())); } catch {} });
  await once(ws, 'open');
  await delay(120);
  return {ws, messages};
}

test('settings sync only to locally authenticated extension-only token and refuses WebSocket setting writes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chat-orch-agent-settings-'));
  const port = await freePort();
  const bridgeToken = 'mcp-token-only-' + 'a'.repeat(40);
  const extensionToken = 'extension-only-' + 'b'.repeat(40);
  const bridgeFile = path.join(dir, 'bridge.token');
  const extensionFile = path.join(dir, 'extension-bridge.token');
  const settingsFile = path.join(dir, 'settings.json');
  writeFileSync(bridgeFile, bridgeToken);
  writeFileSync(extensionFile, extensionToken);
  writeFileSync(settingsFile, JSON.stringify({agentSettings:{enabled:true,promptSchema:2,promptModules:{queue:'Private queue processing instructions'}}}));
  const child = spawn(process.execPath, ['server.js'], {cwd:root,
    env:{...process.env, PORT:String(port), HOST:'127.0.0.1', BRIDGE_TOKEN:'', EXTENSION_BRIDGE_TOKEN:'',
      BRIDGE_TOKEN_FILE:bridgeFile, EXTENSION_BRIDGE_TOKEN_FILE:extensionFile, CHAT_ORCH_PRIVATE_COORDINATION:'0'},
    stdio:['ignore','pipe','pipe']});
  let stderr = '';
  child.stderr.on('data', (data) => {stderr += data.toString();});
  const sockets = [];
  try {
    await health(port);
    const legacy = await connect(port, bridgeToken);
    sockets.push(legacy.ws);
    assert.equal(legacy.messages.some((m) => m.type === 'settings_snapshot'), false,
      'Shared MCP bridge token must never receive editable prompts');
    const trusted = await connect(port, extensionToken);
    sockets.push(trusted.ws);
    const snapshot = trusted.messages.find((m) => m.type === 'settings_snapshot');
    assert.ok(snapshot, 'Authenticated extension receives snapshot on connect');
    assert.equal(snapshot.schema, 1);
    assert.equal(snapshot.settings.promptModules.queue, 'Private queue processing instructions');
    assert.equal(snapshot.settings.promptModules.core.length>10, true);
    trusted.ws.send(JSON.stringify({type:'settings_snapshot',schema:1,revision:300,
      settings:{enabled:false,promptSchema:2,promptModules:{queue:'Unauthorized overwrite'}}}));
    await delay(100);
    assert.equal(JSON.parse(readFileSync(settingsFile,'utf8')).agentSettings.promptModules.queue,
      'Private queue processing instructions', 'Extension cannot write proxy-owned settings over WebSocket');
  } finally {
    for (const ws of sockets) ws.terminate();
    child.kill();
    if (child.exitCode === null) await once(child, 'exit');
    rmSync(dir, {recursive:true, force:true});
  }
  assert.equal(/token-only-a|extension-only-b/.test(stderr), false, 'Credential value never printed');
});
