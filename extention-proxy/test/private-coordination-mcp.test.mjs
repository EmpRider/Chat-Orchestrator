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
      CHAT_ORCH_PROFILE_DIR: dir, CHAT_ORCH_PRIVATE_COORDINATION: '1',
      // Report an unACKed DELIVERED head as blocked immediately, so this test
      // exercises the projection without waiting out the production bound.
      CHAT_ORCH_QUEUE_BLOCKED_SECONDS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bridge;
  let client;
  let pmClient;
  t.after(async () => {
    await pmClient?.close().catch(() => {});
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
  let reportUnverifiedSubmission = false;
  let reconciledVisible=false;
  let advancePreparedTab=false;
  let nextPreparedWorkerId=204;
  let loseStartupAck=false;
  let spawnPreparations=0;
  let workerTabId = 201;
  let workerIncarnation = initialWorkerIncarnation;
  const tabIncarnations = {201: initialWorkerIncarnation}; // per-tab stable identity
  const workerTabs = new Set([201]); // every tab that was ever a worker; stays managed when workerTabId advances
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
        // Each live tab keeps a stable incarnation. Returning one shared
        // workerIncarnation for every tab made a replaced Child look unchanged
        // (or unchanged ones look replaced) depending on mock mutation order.
        const incarnation=tabId===101?managerIncarnation
          :(tabIncarnations[tabId]||=crypto.randomUUID());
        result = {tab_id:tabId,site:'chatgpt',browser_session_id:browserSession,
          incarnation_id:incarnation,
          route_hash:createHash('sha256').update([browserSession,tabId,incarnation,'chatgpt'].join(':')).digest('hex'),
          parent_approved:tabId===101,
          is_managed_worker:workerTabs.has(tabId)};
        break;
      }
      case 'recover_owned_children': result=[];break;
      case 'manager_state':
        assert.equal(m.params.__sessionBrowserId,browserSession,'manager state uses caller session socket');
        result = { tab_id: managerAttestationMismatch ? 999 : 101,
          state: managerLoading ? 'loading' : managerBusy ? 'busy' : 'idle',
          ready: !managerLoading && !managerBusy,
          browser_session_id: browserSession, incarnation_id: managerIncarnation };
        break;
      case 'attest_profile_manager':
        result = {tab_id:m.params.tab_id,browser_session_id:browserSession,
          incarnation_id:m.params.tab_id===101?managerIncarnation:workerIncarnation,
          connection_generation:1};
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
        spawnPreparations++;
        if(advancePreparedTab){
          workerTabId=nextPreparedWorkerId;
          workerIncarnation=randomUUID();
          tabIncarnations[workerTabId]=workerIncarnation;
          workerTabs.add(workerTabId);
          advancePreparedTab=false;
        }
        result = {tab_id:workerTabId,incarnation_id:workerIncarnation,
          prepared:true,reused_tab:false};
        break;
      case 'start_prepared_worker':
        if(loseStartupAck) {
          loseStartupAck=false;
          bridge.send(JSON.stringify({type:'result',id:m.id,ok:false,
            error:'Lost startup transport receipt after Child submitted the prompt'}));
          return;
        }
        if (rejectBeforeSubmission) {
          bridge.send(JSON.stringify({type:'result',id:m.id,ok:false,
            error:'Worker composer contains a different unsent draft',
            error_code:'COMPOSER_DRAFT_MISMATCH'}));
          return;
        }
        result = {task_id:taskId,tab_id:workerTabId,status:'running',
          submission_confirmed:!reportUnverifiedSubmission};
        break;
      case 'verify_worker_submission':
        if(m.params.tab_id===203)
          assert.equal(m.params.__trustedPrincipal.callerTabId,101,
            'a nested PM must reconcile its original Parent-owned send with the original Parent scope');
        result={task_id:m.params.task_id,tab_id:m.params.tab_id,status:'uncertain',
          verified:reconciledVisible,submission_confirmed:reconciledVisible};
        break;
      case 'confirm_child_pairing_submission':
        assert.equal(m.params.tab_id,203);
        assert.equal(m.params.worker_incarnation_id,workerIncarnation);
        assert.equal(m.params.__sessionBrowserId,browserSession);
        assert.equal(m.params.__verifiedChildPairing,true);
        reconciledVisible=true;
        result={task_id:taskId,tab_id:203,status:'running',
          verified:true,submission_confirmed:true};
        break;
      case 'complete_task':
        assert.equal(principal?.callerTabId,203,
          'the original PM tab must complete its own task with its own authenticated credential');
        reconciledVisible=true;
        result={task_id:taskId,tab_id:203,status:'done',submission_confirmed:true};
        break;
      case 'inspect_worker_tasks':
        result = {tab_id:m.params.tab_id,worker_incarnation_id:workerIncarnation,
          tasks:rejectBeforeSubmission ? [] : [{task_id:taskId,status:'done',parent_reviewed:true}]};
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
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Extension handshake unavailable')),4000);
    const onMessage=(raw)=>{
      if(JSON.parse(raw.toString()).type==='session_registered') {
        clearTimeout(timer);bridge.off('message',onMessage);resolve();
      }
    };
    bridge.on('message',onMessage);
  });
  bridge.send(JSON.stringify({type:'session_ready'}));
  const pairingCode=randomUUID();
  const pairingAck=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Pairing ACK unavailable')),4000);
    const onMessage=(raw)=>{
      const m=JSON.parse(raw.toString());
      if(m.type==='pairing_offer_ack') {
        clearTimeout(timer);bridge.off('message',onMessage);
        if(m.ok)resolve();else reject(Error(m.error));
      }
    };
    bridge.on('message',onMessage);
  });
  bridge.send(JSON.stringify({type:'pairing_offer',request_id:randomUUID(),code:pairingCode,
    tab_id:101,incarnation_id:managerIncarnation,
    route_hash:createHash('sha256').update([browserSession,101,managerIncarnation,'chatgpt'].join(':')).digest('hex')}));
  await pairingAck;
  const paired=await client.callTool({name:'pair_conversation',arguments:{
    code:pairingCode,idempotency_key:randomUUID()}});
  assert.equal(paired.isError,undefined,'the approved Parent must pair');
  const credential=JSON.parse(paired.content[0].text).agent_credential;
  async function call(name, args = {}) {
    const out = await client.callTool({name,arguments:{browser_session_id:browserSession,
      agent_credential:credential,idempotency_key:randomUUID(),...args}});
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
  tabIncarnations[workerTabId] = workerIncarnation;
  workerTabs.add(workerTabId);
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
  // The prompt that actually reaches the browser must carry the closure contract.
  // Asserting it here (not just in agent-settings) proves the fix survives the real
  // delivery path: pump -> composeAgentPrompt -> wake_manager -> extension submit.
  // Without it a Parent reviews, ACKs and idles while its reviewed Children keep
  // holding worker slots until spawn fails with SUB_AGENT_LIMIT_REACHED.
  assert.match(wakes[0].prompt_text,/close_worker/,
    'the delivered CHILD_RESULT prompt must instruct close_worker');
  assert.match(wakes[0].prompt_text,/SUB_AGENT_LIMIT_REACHED/,
    'the delivered prompt must state the slot-exhaustion consequence');
  assert.match(wakes[0].prompt_text,/review_task/,
    'closure is gated on review; the prompt must still instruct review_task first');
  let firstDelivered=false;
  for(let i=0;i<100;i++){
    const snapshot=await call('coordination_pending',{caller_tab_id});
    firstDelivered=snapshot.events.slice(0,16).every(e=>e.phase==='DELIVERED')&&
      snapshot.events.slice(16).every(e=>e.phase==='QUEUED');
    if(firstDelivered)break;
    await delay(40);
  }
  assert.equal(firstDelivered,true,'unprocessed first batch holds second batch');
  // D-HOL-BLOCK: an unACKed DELIVERED head freezes this Parent's whole queue, and
  // nothing used to say so — the Parent waited forever while every later event,
  // including a Child's blocking question, sat QUEUED. The projection must name
  // the blocking ref and repeat the one action that clears it.
  const blockedSnapshot=await call('coordination_pending',{caller_tab_id});
  assert.equal(blockedSnapshot.queue_blocked.ref,wakes[0].events[0].event_id,
    'the blocked head must be named by ref');
  assert.equal(blockedSnapshot.queue_blocked.phase,'DELIVERED');
  assert.equal(blockedSnapshot.queue_blocked.lease_nonce,wakes[0].batch_id,
    'the blocking ACK batch must be named so the Parent can re-send it');
  assert.match(blockedSnapshot.queue_blocked.action,/coordination_ack_batch/,
    'the block must state the recovery action, not just the symptom');
  assert.equal(blockedSnapshot.queue_depth,19);
  await delay(200);
  assert.equal(wakes.length,1,'backpressure prevents overtaking without ACK');
  const ack1=await call('coordination_ack_batch',{
    caller_tab_id,batch_id:wakes[0].batch_id,
    event_ids:wakes[0].events.map(e=>e.event_id),
  });
  assert.equal(ack1.processed.length,16);
  // The projection must stop reporting a block the moment the head moves on.
  // The threshold is 0 here, so the head the pump releases next (batch 2) is
  // itself instantly reportable as blocked. Assert on THIS batch's ref, not on
  // the absence of any block: otherwise the test races its own delivery.
  const afterAck=(await call('coordination_pending',{caller_tab_id})).queue_blocked;
  assert.notEqual(afterAck?.ref,wakes[0].events[0].event_id,
    'a processed head must not be reported as blocked');
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
  // An extension reply that merely says RUNNING is not submission proof.
  // The first ambiguous startup leaves the FIFO held and a later concurrent
  // spawn must be rejected before it even creates another browser tab.
  workerTabId=203;
  workerIncarnation=randomUUID();
  tabIncarnations[workerTabId]=workerIncarnation;
  workerTabs.add(workerTabId);
  reportUnverifiedSubmission=true;
  await assert.rejects(call('spawn_worker',{caller_tab_id,site:'chatgpt',
    task:'Ambiguous send, must not advance FIFO',wait_seconds:0}),
  /outcome UNCERTAIN/);
  const preparationsAtHold=spawnPreparations;
  reportUnverifiedSubmission=false;
  await assert.rejects(call('spawn_worker',{caller_tab_id,site:'chatgpt',
    task:'Must remain queued behind unverified send',wait_seconds:0}),
  /Spawn FIFO is HELD/);
  assert.equal(spawnPreparations,preparationsAtHold,
    'blocked FIFO never creates another worker tab after uncertain submission');
  // Real PM is itself a paired Child. A nested TL spawn comes from PM's
  // credential, which MUST NOT be used to inspect its own original prompt:
  // that task is owned by the Parent that spawned PM.
  const pmPairCode=randomUUID();
  const pmPairRequest=randomUUID();
  const pmAck=new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('PM pairing ACK missing')),4000);
    const onMessage=(raw)=>{
      const packet=JSON.parse(raw.toString());
      if(packet.type!=='pairing_offer_ack'||packet.request_id!==pmPairRequest)return;
      clearTimeout(timeout);bridge.off('message',onMessage);
      if(packet.ok)resolve();else reject(new Error(packet.error));
    };
    bridge.on('message',onMessage);
  });
  bridge.send(JSON.stringify({type:'pairing_offer',request_id:pmPairRequest,
    code:pmPairCode,tab_id:203,incarnation_id:workerIncarnation,
    route_hash:createHash('sha256')
      .update([browserSession,203,workerIncarnation,'chatgpt'].join(':')).digest('hex')}));
  await pmAck;
  pmClient=new Client({name:'nested-pm-fifo-test',version:'1.0.0'});
  await pmClient.connect(new StreamableHTTPClientTransport(
    new URL('http://127.0.0.1:'+port+'/mcp')));
  const pmPair=await pmClient.callTool({name:'pair_conversation',arguments:{
    code:pmPairCode,idempotency_key:randomUUID()}});
  assert.equal(pmPair.isError,undefined);
  const pmCredential=JSON.parse(pmPair.content[0].text).agent_credential;
  const callPm=async(name,args={})=>{
    const reply=await pmClient.callTool({name,arguments:{
      browser_session_id:browserSession,caller_tab_id:203,
      agent_credential:pmCredential,idempotency_key:randomUUID(),...args}});
    if(reply.isError)throw new Error(reply.content[0].text);
    return JSON.parse(reply.content[0].text);
  };
  // Pairing is sufficient independent proof BEFORE PM completes. Without
  // this, a real PM could never spawn TL/reviewers while its own task remains
  // active under an incorrectly HELD session-wide FIFO.
  assert.equal(reconciledVisible,true,'paired PM proves the original setup was delivered');
  advancePreparedTab=true;
  const resumed=await callPm('spawn_worker',{site:'chatgpt',
    task:'PM launches TL while PM is still working',wait_seconds:0});
  assert.equal(resumed.tab_id,204);
  assert.equal(resumed.submission_confirmed,true);
  assert.equal(spawnPreparations,preparationsAtHold+1);
  // Catalog LC-15 (was NOT_EXECUTED, and had no test at any level until this
  // one): close_worker on a tab with active grandchildren must refuse BEFORE it
  // looks at task status. This is the exact gate guard()'s closable predicate
  // now mirrors — a reviewed-but-subtree-owning Child must never be advertised
  // as closable, or the Parent walks into a second failure.
  await assert.rejects(call('close_worker',{caller_tab_id,tab_id:203}),
    /Child has descendants; close or reconcile them before closing this tab/,
    'a Child that still owns a Grandchild must be refused regardless of its own task state');
  // PM remains active and can continue delegating/reviewing. It is NOT
  // required to complete its own task just to release this submission gate.
  // If the STARTUP transport ACK vanishes entirely, the Proxy has no
  // task_id to record in its FIFO hold. The Child may independently pair
  // and COMPLETE before the Parent retries. A single DONE task on the
  // original unchanged tab must remain eligible for read-only recovery.
  workerTabId=205;
  workerIncarnation=randomUUID();
  tabIncarnations[workerTabId]=workerIncarnation;
  workerTabs.add(workerTabId);
  loseStartupAck=true;
  await assert.rejects(call('spawn_worker',{caller_tab_id,site:'chatgpt',
    task:'The PM already completed despite a lost startup ACK',wait_seconds:0}),
  /outcome UNCERTAIN/);
  const preparationsWithLostAck=spawnPreparations;
  nextPreparedWorkerId=206;
  advancePreparedTab=true;
  const recoveredAfterLostAck=await call('spawn_worker',{caller_tab_id,site:'chatgpt',
    task:'The next reviewer starts after the completed PM is reconciled',wait_seconds:0});
  assert.equal(recoveredAfterLostAck.tab_id,206);
  assert.equal(recoveredAfterLostAck.submission_confirmed,true);
  assert.equal(spawnPreparations,preparationsWithLostAck+1,
    'recovering a DONE PM prompt never re-prepares the original worker');
});
