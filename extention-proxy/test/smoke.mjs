// End-to-end smoke test: fake extension <-> server <-> real MCP client.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8799;
const TOKEN = 'smoke-token';

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), BRIDGE_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'inherit'],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;

try {
  await sleep(1200);

  // fake extension
  const ws = new WebSocket(`ws://localhost:${PORT}/bridge?token=${TOKEN}`);
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type !== 'call') return;
    let result;
    if (m.method === 'list_tabs') result = [{ tab_id: 1, site: 'chatgpt', role: 'worker' }];
    else if (m.method === 'spawn_worker')
      result = { task_id: 't1', status: 'done', result: `echo: ${m.params.task}` };
    else result = { method: m.method, params: m.params };
    ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, result }));
  });

  // bad token is rejected
  const bad = await fetch(`http://localhost:${PORT}/mcp`, { method: 'POST' });
  assert.equal(bad.status, 401);

  const client = new Client({ name: 'smoke', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp?token=${TOKEN}`))
  );

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    'close_worker',
    'get_result',
    'list_tabs',
    'read_chat',
    'send_to_tab',
    'spawn_worker',
  ]);

  const list = await client.callTool({ name: 'list_tabs', arguments: {} });
  assert.match(list.content[0].text, /chatgpt/);

  const spawned = await client.callTool({
    name: 'spawn_worker',
    arguments: { site: 'chatgpt', task: 'say hi' },
  });
  assert.match(spawned.content[0].text, /echo: say hi/);

  ws.close();
  await sleep(200);
  const offline = await client.callTool({ name: 'list_tabs', arguments: {} });
  assert.equal(offline.isError, true);
  assert.match(offline.content[0].text, /not connected/);

  await client.close();
  console.log('smoke test passed');
} catch (err) {
  failed = true;
  console.error('smoke test FAILED:', err);
} finally {
  child.kill();
  process.exit(failed ? 1 : 0);
}
