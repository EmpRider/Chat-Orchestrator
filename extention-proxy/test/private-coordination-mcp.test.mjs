import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { privateJournalTestHooks } from '../server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('tokenless profile keeps durable FIFO worker reports, barriers and processed ACKs', { timeout: 25000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-profile-queue-'));
  const journal = path.join(dir, 'coordination.events.journal');
  fs.writeFileSync(journal, '');
  const browserSession = randomUUID();
  const managerIncarnation = randomUUID();
  const initialWorkerIncarnation = randomUUID();
  const taskId = randomUUID();
  const credentialHex=createHash('sha256').update(dir+':'+browserSession+':101').digest('hex');
  const profileId=credentialHex.slice(0,8)+'-'+credentialHex.slice(8,12)+'-4'+
    credentialHex.slice(13,16)+'-8'+credentialHex.slice(17,20)+'-'+credentialHex.slice(20,32);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: '0', HOST: '127.0.0.1',
      CHAT_ORCH_PROFILE_DIR: dir, CHAT_ORCH_PRIVATE_COORDINATION: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bridge;
  let client;
  t.after(async () => {
    await client?.close().catch(() => {});
    bridge?.terminate();
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Proxy startup timed out: ' + output)), 8000);
    child.stdout.on('data', (buf) => {
      output += buf.toString();
      const m = /listening on http:\/\/[^:]+:(\d+)/.exec(output);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.stderr.on('data', (buf) => { output += buf.toString(); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Proxy exited ' + code + ': ' + output)); });
  });
  // App registration must work before any extension connects or manager tab is
  // selected; the private queue only requires manager attestation on tool calls.
  const modernProbe = await fetch('http://127.0.0.1:' + port + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-method': 'server/discover', 'mcp-protocol-version': '2026-07-28' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'chatgpt-discover', method: 'server/discover',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'ChatGPT', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {} } } }),
  });
  assert.ok(modernProbe.status >= 400 && modernProbe.status < 500,
    'Legacy server must reject modern discovery with 4xx for client fallback, not 500');
  const modernProbeText = await modernProbe.text();
  assert.ok(modernProbeText.includes('jsonrpc'), 'Modern probe must get JSON-RPC, not HTML error');
  client = new Client({ name: 'profile-queue-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + port + '/mcp')));
  const discoveredTools = (await client.listTools()).tools.map(({ name }) => name);
  assert.ok(discoveredTools.includes('list_tabs'));
  assert.ok(discoveredTools.includes('coordination_register_manager'));

  bridge = new WebSocket('ws://127.0.0.1:' + port + '/bridge');
  const receipts = new Map();
  const wakes = [];
  let managerBusy = true;
  let managerLoading = true;
  let managerAttestationMismatch = false;
  let workerOpen = true;
  let rejectBeforeSubmission = false;
  let workerTabId = 201;
  let workerIncarnation = initialWorkerIncarnation;
  let ackCount = 0;
  bridge.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'worker_event_receipt') {
      receipts.get(m.request_id)?.(m);
      receipts.delete(m.request_id);
      return;
    }
    if (m.type === 'session_heartbeat') {
      bridge.send(JSON.stringify({type:'session_heartbeat_ack',nonce:m.nonce,
        proxy_session_id:'test-proxy-session'}));
      return;
    }
    if (m.type !== 'call') return;
    const principal = m.params?.__trustedPrincipal;
    let result;
    switch (m.method) {
      case 'inspect_tab': {
        const tabId = m.params.tab_id;
        assert.equal(m.params.__sessionBrowserId,browserSession,'proxy routes inspection to this browser session');
        result = {tab_id:tabId,site:'chatgpt',browser_session_id:browserSession,
          incarnation_id:tabId===101?managerIncarnation:workerIncarnation,
          is_managed_worker:tabId===201 || tabId===workerTabId};
        break;
      }
      case 'manager_state':
        assert.equal(m.params.__sessionBrowserId,browserSession,'manager state uses caller session socket');
        result = { tab_id: managerAttestationMismatch ? 999 : 101,
          state: managerLoading ? 'loading' : managerBusy ? 'busy' : 'idle',
          ready: !managerLoading && !managerBusy,
          browser_session_id: browserSession, incarnation_id: managerIncarnation };
        break;
      case 'attest_profile_manager':
        result = {tab_id:101,browser_session_id:browserSession,
          incarnation_id:managerIncarnation,connection_generation:1};
        break;
      case 'get_result':
        assert.equal(m.params.__sessionBrowserId,browserSession,'worker receipt uses originating session');
        result = { task_id: taskId, tab_id: workerTabId, status: 'done',
          source_incarnation_id: workerIncarnation, site: 'chatgpt',
          result: 'Verified mock report', elapsed_seconds: 1 };
        break;
      case 'list_tabs':
        result = [{tab_id:101,role:'orchestrator',site:'chatgpt'},
          ...(workerOpen ? [{tab_id:workerTabId,role:'worker',incarnation_id:workerIncarnation,site:'chatgpt'}] : [])];
        break;
      case 'spawn_worker':
        result = {tab_id:workerTabId,incarnation_id:workerIncarnation,
          prepared:true,reused_tab:false};
        break;
      case 'start_prepared_worker':
        if (rejectBeforeSubmission) {
          bridge.send(JSON.stringify({type:'result',id:m.id,ok:false,
            error:'Worker composer contains a different unsent draft',
            error_code:'COMPOSER_DRAFT_MISMATCH'}));
          return;
        }
        result = {task_id:taskId,tab_id:workerTabId,status:'running'};
        break;
      case 'inspect_worker_tasks':
        result = {tab_id:m.params.tab_id,worker_incarnation_id:workerIncarnation,
          tasks:rejectBeforeSubmission ? [] : [{task_id:taskId,status:'done'}]};
        break;
      case 'close_reviewed_worker':
        result = {closed:m.params.tab_id,parent_reviewed:true};
        break;
      case 'wake_manager':
        wakes.push(m.params);
        result = { submitted: true, uncertain: false };
        break;
      case 'manager_processed':
        ackCount++;
        result = { processed: true };
        break;
      default:
        result = { profile: principal?.mode || null };
    }
    bridge.send(JSON.stringify({ type: 'result', id: m.id, ok: true, result }));
  });
  await new Promise((resolve, reject) => { bridge.once('open', resolve); bridge.once('error', reject); });
  bridge.send(JSON.stringify({type:'register_session',browser_session_id:browserSession,
    connection_generation:1,proxy_session_id:'test-proxy-session'}));
  async function call(name, args = {}) {
    const out = await client.callTool({name,arguments:{browser_session_id:browserSession,...args}});
    if (out.isError) throw new Error(out.content[0].text);
    return JSON.parse(out.content[0].text);
  }
  const caller_tab_id = 101;
  const beforeRegistration=await call('coordination_incarnation_conflicts',{caller_tab_id});
  assert.equal(beforeRegistration.classification,'CLEAR');
  assert.equal(beforeRegistration.unresolved_event_count,0);
  managerAttestationMismatch = true;
  await assert.rejects(call('coordination_register_manager',{caller_tab_id}),
    /mismatch in tab_id/,'mismatched readiness must not register a manager');
  managerAttestationMismatch = false;
  managerLoading = false;
  rejectBeforeSubmission = true;
  await assert.rejects(call('spawn_worker',{caller_tab_id,site:'chatgpt',
    task:'Unsent draft safety check',wait_seconds:0}),
  /not submitted; inspect its unsent draft/);
  assert.equal((await call('coordination_inspect_worker_tasks',{caller_tab_id,tab_id:201})).tasks.length,0);
  rejectBeforeSubmission = false;
  // The prepared tab remains inspectable; a blind retry is still denied.
  await assert.rejects(call('spawn_worker',{caller_tab_id,site:'chatgpt',
    task:'Unsafe replay check',wait_seconds:0}),
  /Existing worker phase does not permit automatic reuse/);
  workerTabId = 202; // New tab; the prepared tab 201 remains held for review.
  workerIncarnation = randomUUID();
  const started = await call('spawn_worker',{caller_tab_id,site:'chatgpt',
    task:'Queue ownership check',wait_seconds:0});
  assert.equal(started.parent_tab_id,caller_tab_id);
  const receiptId = randomUUID();
  const receiptPromise = new Promise((resolve) => receipts.set(receiptId, resolve));
  bridge.send(JSON.stringify({ type: 'worker_done', request_id: receiptId, task_id: taskId,
    tab_id: workerTabId, credential_id: profileId, worker_incarnation_id: workerIncarnation }));
  const receipt = await Promise.race([receiptPromise, delay(4500).then(() => { throw new Error('Worker receipt timeout'); })]);
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.receipt.durably_recorded, true,
    'spawn_worker enrolls its parent even before explicit queue registration');
  managerLoading = true;
  const loadingManager = await call('coordination_register_manager',{caller_tab_id});
  assert.equal(loadingManager.registered,true);
  assert.equal(loadingManager.observation,'loading',
    'Authenticated manager may register before browser network becomes idle');
  managerLoading = false;
  // 1 worker result + 18 status barriers exercises the 16-event FIFO cap.
  const keys=[];
  for (let i=1;i<=18;i++) {
    const key=randomUUID();
    keys.push(key);
    const summary='Status barrier '+String(i).padStart(2,'0');
    const queued=await call('coordination_status_request',{
      caller_tab_id,idempotency_key:key,summary,
    });
    assert.equal(queued.state,'QUEUED');
  }
  const replayCount=privateJournalTestHooks.replayPrivateJournal(
    fs.readFileSync(journal)).events.length;
  assert.equal(replayCount,19);
  const before=await call('coordination_pending',{caller_tab_id});
  assert.equal(before.events.length,19);
  assert.deepEqual(before.events.map(e=>e.entryType),
    ['CHILD_RESULT',...Array(18).fill('STATUS_REQUEST')]);
  await assert.rejects(call('close_worker',{caller_tab_id,tab_id:workerTabId}),
    /not ACKed worker result/,'worker closure needs FIFO processing first');
  workerOpen = false; // Result remains queued after the source tab closes.
  assert.equal((await call('coordination_start_delivery',{caller_tab_id})).armed,true);
  await delay(250);
  assert.equal(wakes.length,0,'busy manager receives no batch');
  managerBusy=false;
  for(let i=0;i<100&&wakes.length===0;i++)await delay(50);
  assert.equal(wakes.length,1);
  assert.equal(wakes[0].events.length,16,'first FIFO batch must obey cap');
  assert.equal(wakes[0].events[0].type,'CHILD_RESULT');
  let firstDelivered=false;
  for(let i=0;i<100;i++){
    const snapshot=await call('coordination_pending',{caller_tab_id});
    firstDelivered=snapshot.events.slice(0,16).every(e=>e.phase==='DELIVERED')&&
      snapshot.events.slice(16).every(e=>e.phase==='QUEUED');
    if(firstDelivered)break;
    await delay(40);
  }
  assert.equal(firstDelivered,true,'unprocessed first batch holds second batch');
  await delay(200);
  assert.equal(wakes.length,1,'backpressure prevents overtaking without ACK');
  const ack1=await call('coordination_ack_batch',{
    caller_tab_id,batch_id:wakes[0].batch_id,
    event_ids:wakes[0].events.map(e=>e.event_id),
  });
  assert.equal(ack1.processed.length,16);
  for(let i=0;i<100&&wakes.length<2;i++)await delay(50);
  assert.equal(wakes.length,2,'second batch released after first ACK');
  assert.equal(wakes[1].events.length,3);
  let secondDelivered=false;
  for(let i=0;i<100;i++){
    const snapshot=await call('coordination_pending',{caller_tab_id});
    secondDelivered=snapshot.events.slice(16).every(e=>e.phase==='DELIVERED');
    if(secondDelivered)break;
    await delay(40);
  }
  assert.equal(secondDelivered,true);
  const ack2=await call('coordination_ack_batch',{
    caller_tab_id,batch_id:wakes[1].batch_id,
    event_ids:wakes[1].events.map(e=>e.event_id),
  });
  assert.equal(ack2.processed.length,3);
  assert.equal(ackCount,2);
  assert.ok((await call('coordination_pending',{caller_tab_id})).events
    .every(e=>e.phase==='PROCESSED'));
  const closed=await call('close_worker',{caller_tab_id,tab_id:workerTabId});
  assert.equal(closed.closed,workerTabId);
  assert.equal(closed.parent_reviewed,true);
});
