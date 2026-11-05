import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createPrincipalCredential, revokePrincipalCredential } from '../principal-auth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = 'synthetic-shared-token';
const scope = { role: 'pm', workspaceId: 'workspace-A', projectId: '4',
  orchestratorId: 'p0', parentTaskId: '65', callerTabId: 101,
  browserSessionId: randomUUID(), managerIncarnationId: randomUUID() };

test('MCP authenticates per-request identity, rejects spoofing/revocation and isolates bridge token', {
  timeout: 30000,
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-mcp-acl-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, 'bridge.token');
  const registryFile = path.join(directory, 'coordination-principals.json');
  fs.writeFileSync(tokenFile, SHARED);
  const a = createPrincipalCredential(registryFile, scope);
  const b = createPrincipalCredential(registryFile, { ...scope, role: 'tl', callerTabId: 102, managerIncarnationId: randomUUID() });
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: '0', BRIDGE_TOKEN: SHARED, BRIDGE_TOKEN_FILE: tokenFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const clients = [];
  let bridge;
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    bridge?.close();
    server.kill();
  });
  const port = await new Promise((resolve, reject) => {
    let printed = '';
    const timer = setTimeout(() => reject(new Error('MCP server startup timed out: ' + printed)), 7000);
    server.stdout.on('data', (chunk) => {
      printed += chunk;
      const match = printed.match(/listening on http:\/\/[^:]+:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('Server exited: ' + code)); });
  });
  bridge = new WebSocket('ws://127.0.0.1:' + port + '/bridge?token=' + SHARED);
  const seen = [];
  let holdNextCall = false;
  let heldCall = null;
  bridge.on('message', (body) => {
    const msg = JSON.parse(body.toString());
    if (msg.type !== 'call') return;
    seen.push(msg);
    if (holdNextCall) { holdNextCall = false; heldCall = msg; return; }
    bridge.send(JSON.stringify({ type: 'result', id: msg.id, ok: true,
      result: { mode: msg.params?.__trustedPrincipal?.mode,
        principalId: msg.params?.__trustedPrincipal?.principalId ?? null,
        callerTabId: msg.params?.__trustedPrincipal?.callerTabId ?? null,
        tool: msg.method },
    }));
  });
  await new Promise((resolve, reject) => { bridge.once('open', resolve); bridge.once('error', reject); });

  async function connect(token) {
    const client = new Client({ name: 'scoped-acl-fixture', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(
      new URL('http://127.0.0.1:' + port + '/mcp?token=' + encodeURIComponent(token)),
    ));
    clients.push(client);
    return client;
  }
  const clientA = await connect(a.token);
  const clientB = await connect(b.token);
  const legacy = await connect(SHARED);
  const result = async (client, args = {}) => {
    const out = await client.callTool({ name: 'list_tabs', arguments: args });
    assert.notEqual(out.isError, true);
    return JSON.parse(out.content[0].text);
  };
  assert.deepEqual(
    { mode: (await result(clientA)).mode, principalId: (await result(clientA)).principalId },
    { mode: 'scoped', principalId: a.principal.principalId },
  );
  assert.equal((await result(clientB)).principalId, b.principal.principalId);
  assert.equal((await result(legacy)).mode, 'legacy');
  const forged = await result(clientA, { __trustedPrincipal: {
    mode: 'scoped', credentialId: b.principal.credentialId, principalId: b.principal.principalId,
    callerTabId: 102,
  } });
  assert.equal(forged.principalId, a.principal.principalId);
  assert.equal(forged.callerTabId, 101);
  const count = seen.length;
  assert.equal(revokePrincipalCredential(registryFile, a.principal.credentialId), true);
  await assert.rejects(result(clientA), /401|unauthorized|Unauthorized|fetch/i);
  assert.equal(seen.length, count, 'revoked caller was not forwarded to extension');
  assert.equal((await result(clientB)).callerTabId, 102);
  await assert.rejects(connect('invalid-token-' + a.token), /401|unauthorized|Unauthorized|fetch/i);
  // A reconnect while an external call is in flight must NOT accept a stale
  // response as successful completion. The effect is classified UNCERTAIN.
  holdNextCall = true;
  const inFlight = clientB.callTool({ name: 'list_tabs', arguments: {} });
  for (let attempt = 0; !heldCall && attempt < 50; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(heldCall, 'the original socket received the in-flight request');
  const newer = new WebSocket('ws://127.0.0.1:' + port + '/bridge?token=' + SHARED);
  await new Promise((resolve, reject) => { newer.once('open', resolve); newer.once('error', reject); });
  newer.on('message', (body) => {
    const msg = JSON.parse(body.toString());
    if (msg.type === 'call') newer.send(JSON.stringify({
      type: 'result', id: msg.id, ok: true,
      result: { mode: msg.params?.__trustedPrincipal?.mode, callerTabId: 102 },
    }));
  });
  bridge = newer;
  const interrupted = await inFlight;
  assert.equal(interrupted.isError, true, 'reconnect cannot commit an old result');
  assert.match(interrupted.content[0].text, /UNCERTAIN/);
  assert.equal((await result(clientB)).callerTabId, 102);

});
