// End-to-end smoke test: fake extension <-> server <-> real MCP client.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8799;
const profile = fs.mkdtempSync(path.join(os.tmpdir(),'chat-orch-mcp-smoke-'));
const browserSession = randomUUID();
const managerIncarnation = randomUUID();
const workerIncarnation = randomUUID();

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), CHAT_ORCH_PROFILE_DIR: profile,
    CHAT_ORCH_PRIVATE_COORDINATION:'0' },
  stdio: ['ignore', 'pipe', 'inherit'],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;

try {
  await sleep(1200);

  // fake extension
  const ws = new WebSocket(`ws://localhost:${PORT}/bridge`);
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type !== 'call') return;
    let result;
    if (m.method === 'list_tabs') result = [{tab_id:1,site:'chatgpt',role:'unregistered'}];
    else if (m.method === 'inspect_tab') result = {
      tab_id:m.params.tab_id,site:'chatgpt',browser_session_id:browserSession,
      incarnation_id:m.params.tab_id===1?managerIncarnation:workerIncarnation,
      is_managed_worker:m.params.tab_id===2,
    };
    else if (m.method === 'attest_profile_manager') result = {
      tab_id:m.params.tab_id,browser_session_id:browserSession,
      incarnation_id:managerIncarnation,connection_generation:1,
    };
    else if (m.method === 'spawn_worker') result = {
      tab_id:2,incarnation_id:workerIncarnation,reused_tab:false,prepared:true,
    };
    else if (m.method === 'start_prepared_worker') result = {
      task_id:'t1',tab_id:2,status:'done',result:`echo: ${m.params.task}`,
    };
    else result = { method: m.method, params: m.params };
    ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, result }));
  });

  const client = new Client({ name: 'smoke', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`))
  );

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    'close_worker',
    'get_result',
    'list_tabs',
    'read_chat',
    'reopen_child',
    'send_to_tab',
    'spawn_worker',
  ]);

  const list = await client.callTool({ name: 'list_tabs', arguments: {} });
  assert.match(list.content[0].text, /chatgpt/);

  const spawned = await client.callTool({
    name: 'spawn_worker',
    arguments: { caller_tab_id:1,site: 'chatgpt', task: 'say hi' },
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
  const exited = new Promise((resolve)=>{if(child.exitCode !== null || child.signalCode !== null)resolve();
    else child.once('exit',resolve);});
  child.kill();
  await Promise.race([exited,sleep(2000)]);
  try { fs.rmSync(profile,{recursive:true,force:true}); }
  catch (err) { console.warn('Smoke profile cleanup needs manual inspection:',err.message); }
  process.exit(failed ? 1 : 0);
}
