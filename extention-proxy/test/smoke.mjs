// End-to-end smoke test: fake extension <-> server <-> real MCP client.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {createServer as createPortProbe} from 'node:net';
import { randomUUID,createHash } from 'node:crypto';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(),'chat-orch-mcp-smoke-'));
const browserSession = randomUUID();
const managerIncarnation = randomUUID();
const workerIncarnation = randomUUID();
const safePort=async()=>{
  const forbidden=new Set([1719,1720,1723,2049,3659,4045,4190,5060,5061,
    6000,6566,6665,6666,6667,6668,6669,6697,10080]);
  for(let i=0;i<30;i++){
    const probe=createPortProbe();
    await new Promise((resolve,reject)=>probe.once('error',reject)
      .listen(0,'127.0.0.1',resolve));
    const port=probe.address().port;
    await new Promise((resolve)=>probe.close(resolve));
    // Browsers/Undici reject a small list of historically unsafe ports.
    if(port>=1024 && !forbidden.has(port))return port;
  }
  throw new Error('No safe ephemeral MCP test port was available');
};
const selectedPort=await safePort();

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(selectedPort), HOST: '127.0.0.1', CHAT_ORCH_PROFILE_DIR: profile,
    CHAT_ORCH_PRIVATE_COORDINATION:'0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;

try {
  // Use the OS-assigned port: Windows can reserve ranges that contain fixed test ports.
  const PORT = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error('Proxy startup timed out: ' + output)), 10000);
    const onStdout = (chunk) => {
      output += chunk.toString();
      const match = /listening on http:\/\/[^:]+:(\d+)/.exec(output);
      if (match) finish(null, Number(match[1]));
    };
    const onStderr = (chunk) => { output += chunk.toString(); };
    const onError = (err) => finish(err);
    const onExit = (code) => finish(new Error('Proxy exited ' + code + ': ' + output));
    function finish(err, port) {
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('error', onError);
      child.off('exit', onExit);
      if (err) reject(err);
      else resolve(port);
    }
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('error', onError);
    child.once('exit', onExit);
  });

  // fake extension
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/bridge`);
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'session_registered') {
      ws.send(JSON.stringify({type:'session_ready'}));
      return;
    }
    if (m.type !== 'call') return;
    let result;
    if (m.method === 'list_tabs') result = [{tab_id:1,site:'chatgpt',role:'unregistered'}];
    else if (m.method === 'inspect_tab') result = {
      tab_id:m.params.tab_id,site:'chatgpt',browser_session_id:browserSession,
      incarnation_id:m.params.tab_id===1?managerIncarnation:workerIncarnation,
      parent_approved:m.params.tab_id===1,
      route_hash:createHash('sha256').update([browserSession,m.params.tab_id,
        m.params.tab_id===1?managerIncarnation:workerIncarnation,'chatgpt'].join(':')).digest('hex'),
      is_managed_worker:m.params.tab_id===2,
    };
    else if (m.method === 'recover_owned_children') result=[];
    else if (m.method === 'attest_profile_manager') result = {
      tab_id:m.params.tab_id,browser_session_id:browserSession,
      incarnation_id:managerIncarnation,connection_generation:1,
    };
    else if (m.method === 'spawn_worker') result = {
      tab_id:2,incarnation_id:workerIncarnation,reused_tab:false,prepared:true,
    };
    else if (m.method === 'start_prepared_worker') result = {
      task_id:'t1',tab_id:2,status:'done',submission_confirmed:true,result:`echo: ${m.params.task}`,
    };
    else result = { method: m.method, params: m.params };
    ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, result }));
  });
  ws.send(JSON.stringify({type:'register_session',browser_session_id:browserSession,
    connection_generation:1,proxy_session_id:'smoke-session'}));

  const client = new Client({ name: 'smoke', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`))
  );

  const discoveredTools=(await client.listTools()).tools;
  const tools = discoveredTools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    'close_worker',
    'complete_task',
    'get_result',
    'list_tabs',
    'pair_conversation',
    'read_chat',
    'reopen_child',
    'request_parent_context',
    'review_task',
    'send_to_tab',
    'spawn_worker',
  ]);
  assert.equal(Object.hasOwn(discoveredTools.find((t)=>t.name==='spawn_worker')
    .inputSchema.properties,'share_context_from'),false,
    'v1 must not expose automatic transcript copying');

  const code=randomUUID();
  const request_id=randomUUID();
  const ack=new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('Pairing ACK timeout')),5000);
    const onMessage=(raw)=>{
      const msg=JSON.parse(raw.toString());
      if(msg.type==='pairing_offer_ack'&&msg.request_id===request_id){
        clearTimeout(timeout);ws.off('message',onMessage);
        if(msg.ok===true)resolve();else reject(Error(msg.error));
      }
    };
    ws.on('message',onMessage);
  });
  ws.send(JSON.stringify({type:'pairing_offer',request_id,code,tab_id:1,
    incarnation_id:managerIncarnation,route_hash:createHash('sha256').update(
      [browserSession,1,managerIncarnation,'chatgpt'].join(':')).digest('hex')}));
  await ack;
  const paired=await client.callTool({name:'pair_conversation',arguments:{
    code,idempotency_key:randomUUID()}});
  assert.equal(paired.isError,undefined);
  const agent_credential=JSON.parse(paired.content[0].text).agent_credential;
  const list = await client.callTool({ name: 'list_tabs', arguments: {
    agent_credential,idempotency_key:randomUUID()} });
  assert.match(list.content[0].text, /chatgpt/);

  const unsupported=await client.callTool({name:'spawn_worker',arguments:{
    caller_tab_id:1,site:'gemini',task:'must not create a worker',
    agent_credential,idempotency_key:randomUUID()}});
  assert.equal(unsupported.isError,undefined);
  assert.equal(JSON.parse(unsupported.content[0].text).spawned,false);
  assert.match(unsupported.content[0].text,/PROVIDER_NOT_SUPPORTED/);

  const spawned = await client.callTool({
    name: 'spawn_worker',
    arguments: { caller_tab_id:1,site: 'chatgpt', task: 'say hi',
      agent_credential,idempotency_key:randomUUID() },
  });
  assert.match(spawned.content[0].text, /echo: say hi/);

  ws.close();
  await sleep(200);
  let settled=false;
  const cancellation=new AbortController();
  const offline=client.callTool({name:'list_tabs',arguments:{
    agent_credential,idempotency_key:randomUUID(),
  }},undefined,{signal:cancellation.signal}).then(()=>{settled=true;},()=>{settled=true;});
  await sleep(300);
  assert.equal(settled,false,'a live MCP call must await Extension reconnect, not reject immediately');

  cancellation.abort();
  await Promise.race([offline,sleep(1000)]);
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
