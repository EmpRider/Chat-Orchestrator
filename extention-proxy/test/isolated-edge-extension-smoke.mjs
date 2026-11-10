// Explicit manual smoke: isolated, disposable Edge profile and Electron45 only.
// Never point the profile/ports at a user's production browser or app.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const origin = 'http://127.0.0.1:8899';
const edgeCdp = 'http://127.0.0.1:9341';
const desktopCdp = 'http://127.0.0.1:9339';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (fn, label, maxMs = 18000) => {
  const end = Date.now() + maxMs;
  let last;
  while (Date.now() < end) {
    try { const out = await fn(); if (out) return out; } catch (err) { last = err; }
    await sleep(160);
  }
  throw new Error(label + (last ? ': ' + last.message : ''));
};
async function debuggerFor(port, predicate) {
  const target = await wait(async () => {
    const data = await (await fetch(port + '/json/list')).json();
    return data.find(predicate);
  }, 'CDP target unavailable');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let seq = 0;
  const waiting = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    const slot = waiting.get(msg.id);
    if (slot) {
      waiting.delete(msg.id);
      clearTimeout(slot.timer);
      msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result);
    }
  });
  async function call(method, params = {}) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(method + ' timed out')); }, 12000);
      waiting.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expr) {
    const result = await call('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ': ' +
        (result.exceptionDetails.exception?.description || 'renderer error'));
    }
    return result.result?.value;
  }
  return { call, evaluate, close: () => ws.close(), target };
}
const extension = await debuggerFor(edgeCdp, (t) =>
  t.type === 'service_worker' && /^chrome-extension:\/\//.test(t.url) && t.url.endsWith('/background.js'));
const desktop = await debuggerFor(desktopCdp, (t) =>
  t.type === 'page' && t.url.includes('/extention-proxy/desktop/index.html'));
let client;
try {
  const startup = await (await fetch(origin + '/health')).json();
  assert.equal(startup.coordination.storageReady, true);
  // The disposable Edge profile may reconnect before CDP attaches on repeat runs.
  const setExpression = 'chrome.storage.local.set(' + JSON.stringify({
    serverUrl: 'ws://127.0.0.1:8899/bridge',
  }) + ')';
  await extension.evaluate(setExpression);
  await wait(async () => (await (await fetch(origin + '/health')).json()).extensionConnected,
    'isolated real Edge extension did not connect');
  const tabs = await extension.evaluate('chrome.tabs.query({url:["https://chatgpt.com/*"]})');
  const manager = tabs.find((t) => t.id > 0);
  assert.ok(manager, 'No isolated ChatGPT tab in Edge profile');
  // No manual manager selection: the proxy registers this root on the first
  // explicit caller-scoped operation.
  assert.equal(await desktop.evaluate('document.getElementById("token-value")'), null,
    'desktop must not show bridge token controls');
  client = new Client({ name: 'real-edge-extension-smoke', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp')));
  async function call(name, args = {}) {
    const result = await client.callTool({ name,
      arguments: {caller_tab_id:manager.id,...args} });
    if (result.isError) throw new Error(result.content[0]?.text || name + ' rejected');
    return JSON.parse(result.content[0].text);
  }
  const registered = await call('coordination_register_manager');
  assert.equal(registered.registered, true);
  assert.equal(registered.manager_tab_id, manager.id);
  let liveWorker = 'not-requested';
  let liveCount = 0;
  let workspaceWindowId = null;
  let rootGroupId = null;
  let firstWorker = null;
  let fixingTaskId = null;
  const fullWorkflow = process.env.CHAT_ORCH_LIVE_WORKFLOW === '1';
  const nestedWorkflow = process.env.CHAT_ORCH_LIVE_NESTED === '1';
  const recoveryWorkflow = process.env.CHAT_ORCH_LIVE_RECOVERY === '1';
  let nestedCompleted = false;
  let independentRootCompleted = false;
  let recoveryCompleted = false;
  let key;
  let queued;
  const fullThreeChildSmoke = process.env.CHAT_ORCH_LIVE_WORKER_COUNT === '3';
  if (process.env.CHAT_ORCH_LIVE_WORKER_SMOKE === '1') {
    await extension.evaluate('chrome.storage.local.set({taskTimeoutMin:1,maxWorkers:10,maxTasksPerHour:100})');
    const expected = fullThreeChildSmoke ? 3 : 1;
    for (let child = 1; child <= expected; child++) {
      const spawned = await call('spawn_worker', {
        site: 'chatgpt', role: 'specialist', keep_open: true, wait_seconds: 0,
        task: 'Isolation smoke only. Reply with the exact text P0_E2E_OK_' + child + ' and nothing else.',
      });
      assert.ok(spawned.task_id && spawned.tab_id > 0);
      if (!firstWorker) firstWorker = spawned;
      // A real Edge run must use one unfocused workspace, not one window per worker.
      const placement = await extension.evaluate(`(async () => {
        const worker = await chrome.tabs.get(${spawned.tab_id});
        const {workspaceWindow,workspaceGroups} = await chrome.storage.session.get([
          'workspaceWindow','workspaceGroups'
        ]);
        const group = await chrome.tabGroups.get(worker.groupId);
        const anchor = await chrome.tabs.get(workspaceWindow.anchorTabId);
        return {windowId:worker.windowId,groupId:worker.groupId,
          groupTitle:group.title,anchorUrl:anchor.url,anchorWindowId:anchor.windowId,
          workspaceWindowId:workspaceWindow.windowId,active:worker.active,
          groupCount:Object.keys(workspaceGroups || {}).length};
      })()`);
      assert.equal(placement.active,false,'worker must open as an inactive tab');
      assert.equal(placement.windowId,placement.workspaceWindowId);
      assert.equal(placement.anchorWindowId,placement.windowId);
      assert.match(placement.anchorUrl,/^chrome-extension:\/\/.+\/workspace\.html$/);
      assert.equal(placement.groupTitle,'Chat Orchestrator · Root '+manager.id);
      if (workspaceWindowId !== null) {
        assert.equal(placement.windowId,workspaceWindowId,'no extra windows for next worker');
        assert.equal(placement.groupId,rootGroupId,'same-root workers share group');
      }
      workspaceWindowId=placement.windowId;
      rootGroupId=placement.groupId;
      assert.equal(placement.groupCount,1,'single root requires one group');
      liveWorker = spawned.status;
      for (let i = 0; i < 6 && liveWorker === 'running'; i++) {
        const status = await call('get_result', { task_id: spawned.task_id, wait_seconds: 10 });
        liveWorker = status.status;
      }
      if (liveWorker !== 'done') {
        throw new Error('Isolated child ' + child + ' did not complete; status=' + liveWorker);
      }
      liveCount++;
      await wait(async () => {
        const next = await call('coordination_pending');
        return next.events.filter((item) => item.entryType === 'CHILD_RESULT').length === liveCount
          ? next : null;
      }, 'live child ' + child + ' did not reach durable parent queue', 20000);
      if (fullThreeChildSmoke && child === 1) {
        key = randomUUID();
        queued = await call('coordination_status_request', {
          idempotency_key: key, summary: 'Interleaved isolated status request after child one',
        });
      }
    }
  }
  if (fullWorkflow) {
    assert.ok(firstWorker, 'full workflow requires live worker');
    const denied = await call('close_worker',{tab_id:firstWorker.tab_id}).then(
      () => false,()=>true);
    assert.equal(denied,true,'unacknowledged worker result must block close');
    const fix = await call('send_to_tab',{
      tab_id:firstWorker.tab_id,
      text:'E2E fixing task on the SAME conversation. Reply with exact text P0_FIX_DONE and nothing else.',
      wait_seconds:0,
    });
    assert.equal(fix.tab_id,firstWorker.tab_id,'fix must reuse child tab');
    assert.notEqual(fix.task_id,firstWorker.task_id,'fix needs a new internal task UUID');
    fixingTaskId=fix.task_id;
    let finish=fix;
    for (let i=0;i<8 && finish.status==='running';i++)
      finish=await call('get_result',{task_id:fix.task_id,wait_seconds:10});
    assert.equal(finish.status,'done','same-tab fixing task must complete');
    await wait(async()=>{
      const state=await call('coordination_pending');
      return state.events.filter((entry)=>entry.entryType==='CHILD_RESULT').length===liveCount+1;
    },'fixing task result must reach durable queue',20000);
  }
  if (nestedWorkflow) {
    assert.ok(firstWorker,'nested test requires a completed first child');
    const nestedManager=await call('coordination_register_manager',{
      caller_tab_id:firstWorker.tab_id,
    });
    assert.equal(nestedManager.registered,true,'managed child can become a parent');
    const grandchild=await call('spawn_worker',{
      caller_tab_id:firstWorker.tab_id,site:'chatgpt',role:'specialist',
      task:'Nested isolated E2E grandchild. Reply only P0_GRANDCHILD_OK.',
      keep_open:true,wait_seconds:0,
    });
    assert.equal(grandchild.parent_tab_id,firstWorker.tab_id);
    assert.equal(grandchild.root_tab_id,manager.id);
    let grandchildState=grandchild;
    for(let i=0;i<8 && grandchildState.status==='running';i++)
      grandchildState=await call('get_result',{
        caller_tab_id:firstWorker.tab_id,task_id:grandchild.task_id,wait_seconds:10,
      });
    assert.equal(grandchildState.status,'done','grandchild should complete');
    const group1=await extension.evaluate('chrome.tabs.get('+firstWorker.tab_id+')');
    const group2=await extension.evaluate('chrome.tabs.get('+grandchild.tab_id+')');
    assert.equal(group2.windowId,group1.windowId);
    assert.equal(group2.groupId,group1.groupId,'grandchild stays in original root group');
    const parentDenied=await call('close_worker',{tab_id:firstWorker.tab_id}).then(
      ()=>false,()=>true);
    assert.equal(parentDenied,true,'parent cannot close worker with live descendants');
    nestedCompleted=true;
    const secondRoot=await extension.evaluate(`(async()=>{
      const existing=await chrome.tabs.get(${manager.id});
      return chrome.tabs.create({
        windowId:existing.windowId,url:'https://chatgpt.com/',active:false
      });
    })()`);
    assert.ok(secondRoot?.id && secondRoot.id!==manager.id);
    await wait(async()=>{
      const tab=await extension.evaluate('chrome.tabs.get('+secondRoot.id+')');
      return tab?.url?.startsWith('https://chatgpt.com/') ? true : false;
    },'independent root ChatGPT tab did not navigate',20000);
    const secondManager=await call('coordination_register_manager',{
      caller_tab_id:secondRoot.id,
    });
    assert.equal(secondManager.registered,true);
    const independent=await call('spawn_worker',{
      caller_tab_id:secondRoot.id,site:'chatgpt',role:'specialist',
      task:'Separate root isolated E2E child. Reply only P0_ROOT2_OK.',
      keep_open:true,wait_seconds:0,
    });
    assert.equal(independent.parent_tab_id,secondRoot.id);
    assert.equal(independent.root_tab_id,secondRoot.id);
    let independentState=independent;
    for(let i=0;i<8 && independentState.status==='running';i++)
      independentState=await call('get_result',{
        caller_tab_id:secondRoot.id,task_id:independent.task_id,wait_seconds:10,
      });
    assert.equal(independentState.status,'done','second root worker should complete');
    const secondWorker=await extension.evaluate('chrome.tabs.get('+independent.tab_id+')');
    assert.equal(secondWorker.windowId,group1.windowId,
      'independent roots share the dedicated managed window');
    assert.notEqual(secondWorker.groupId,group1.groupId,
      'independent roots require distinct native tab groups');
    const wrongRootDenied=await call('get_result',{
      task_id:independent.task_id,
    }).then(()=>false,()=>true);
    assert.equal(wrongRootDenied,true,'first root cannot read second root tasks');
    const wrongCloseDenied=await call('close_worker',{
      tab_id:grandchild.tab_id,
    }).then(()=>false,()=>true);
    assert.equal(wrongCloseDenied,true,'grandchild is not first root direct child');
    independentRootCompleted=true;
  }
  if (recoveryWorkflow) {
    assert.ok(firstWorker,'recovery needs a completed worker');
    const original=await call('get_result',{task_id:firstWorker.task_id});
    assert.equal(original.status,'done');
    await extension.evaluate('chrome.tabs.remove('+firstWorker.tab_id+')');
    await wait(async()=>{
      const record=await extension.evaluate(`(async()=>{
        const result=await chrome.storage.session.get('lostWorkers');
        return result.lostWorkers?.[${JSON.stringify(firstWorker.task_id)}] || null;
      })()`);
      return record?.tabId===firstWorker.tab_id ? record : null;
    },'closed child conversation was not saved for recovery',20000);
    const recovered=await call('reopen_child',{task_id:firstWorker.task_id});
    assert.equal(recovered.status,'REATTACHED');
    assert.equal(recovered.execution_resumed,false,'original task must not replay automatically');
    assert.equal(recovered.parent_tab_id,manager.id);
    assert.equal(recovered.root_tab_id,manager.id);
    assert.notEqual(recovered.tab_id,firstWorker.tab_id);
    const recoveredTab=await extension.evaluate('chrome.tabs.get('+recovered.tab_id+')');
    assert.equal(recoveredTab.windowId,workspaceWindowId);
    const recoveredGroup=await extension.evaluate('chrome.tabGroups.get('+recoveredTab.groupId+')');
    assert.equal(recoveredGroup.windowId,workspaceWindowId);
    assert.equal(recoveredGroup.title,'Chat Orchestrator · Root '+manager.id,
      'recoveries preserve root grouping even if the last old tab closed and group ID changed');
    const oldResult=await call('get_result',{task_id:firstWorker.task_id});
    assert.equal(oldResult.status,'done','original terminal task is not rewritten');
    recoveryCompleted=true;
  }
  if (!queued) {
    key = randomUUID();
    queued = await call('coordination_status_request', {
      idempotency_key: key, summary: 'Isolated live Edge extension verification only',
    });
  }
  assert.equal(queued.state, 'QUEUED');
  const repeated = await call('coordination_status_request', {
    idempotency_key: key,
    summary: fullThreeChildSmoke ? 'Interleaved isolated status request after child one'
      : 'Isolated live Edge extension verification only',
  });
  assert.equal(repeated.event_id, queued.event_id);
  let wakeDelivered = false;
  let wakeUncertain = false;
  if (process.env.CHAT_ORCH_LIVE_WAKE === '1') {
    const expected = fullThreeChildSmoke
      ? ['CHILD_RESULT', 'STATUS_REQUEST', 'CHILD_RESULT', 'CHILD_RESULT',
          ...(fullWorkflow ? ['CHILD_RESULT'] : [])]
      : liveCount === 1 ? ['CHILD_RESULT', ...(fullWorkflow ? ['CHILD_RESULT'] : []),
          'STATUS_REQUEST'] : ['STATUS_REQUEST'];
    assert.equal((await call('coordination_start_delivery')).armed, true);
    const sent = await wait(async () => {
      const now = await call('coordination_pending');
      return now.events.length === expected.length &&
        now.events.every((item) => ['DELIVERED', 'UNCERTAIN'].includes(item.phase)) ? now : null;
    }, 'live Edge manager batch outcome remained unresolved', 30000);
    assert.deepEqual(sent.events.map((item) => item.entryType), expected);
    wakeDelivered = sent.events.every((item) => item.phase === 'DELIVERED');
    wakeUncertain = sent.events.every((item) => item.phase === 'UNCERTAIN');
    assert.ok(wakeDelivered || wakeUncertain, 'mixed queue delivery outcome');
  }
  let queuePromptVisible = false;
  if (wakeDelivered || wakeUncertain) {
    for (let i = 0; i < 12; i++) {
      const chat = await call('read_chat', {tab_id:manager.id,last_n:10}).catch(() => null);
      const transcript = chat?.transcript || '';
      if (transcript.includes('<queue_batch') && transcript.includes('STATUS_REQUEST')) {
        queuePromptVisible = true;
        break;
      }
      await sleep(250);
    }
  }
  let managerDomPromptVisible = false;
  let managerComposerStillContainsQueue = false;
  if (wakeDelivered || wakeUncertain) {
    const page = await debuggerFor(edgeCdp, (target) =>
      target.type === 'page' && /^https:\/\/chatgpt\.com\//.test(target.url || ''));
    try {
      const probe = await page.evaluate(`({
        body: Boolean(document.body?.innerText.includes('queue_batch')),
        composer: [...document.querySelectorAll('#prompt-textarea, textarea, [contenteditable="true"]')]
          .some((el) => String(el.value || el.innerText || '').includes('queue_batch'))
      })`);
      managerDomPromptVisible = Boolean(probe?.body);
      managerComposerStillContainsQueue = Boolean(probe?.composer);
    } finally { page.close(); }
  }
  const pending = await call('coordination_pending');
  assert.ok(pending.events.some((item) => item.ref === queued.event_id));
  let ackedCount = 0, reviewedClose = false;
  if (fullWorkflow) {
    assert.equal(wakeDelivered,true,'full workflow requires confirmed batch delivery');
    const batch=await call('coordination_pending');
    assert.ok(batch.events.every((entry)=>entry.phase==='DELIVERED'));
    const batchId=batch.events[0].leaseNonce;
    assert.ok(batchId && batch.events.every((entry)=>entry.leaseNonce===batchId));
    const resultEvent=batch.events.find((entry)=>entry.entryType==='CHILD_RESULT');
    const immutable=await call('coordination_get_report',{event_id:resultEvent.ref});
    assert.ok(immutable,'original immutable report must be retrievable for review');
    const acknowledged=await call('coordination_ack_batch',{
      batch_id:batchId,event_ids:batch.events.map((entry)=>entry.ref),
    });
    ackedCount=acknowledged.processed.length;
    assert.equal(ackedCount,batch.events.length);
    assert.ok((await call('coordination_pending')).events.every((entry)=>entry.phase==='PROCESSED'));
    const closed=await call('close_worker',{tab_id:firstWorker.tab_id});
    assert.equal(closed.closed,firstWorker.tab_id);
    reviewedClose=closed.parent_reviewed===true;
    assert.equal(reviewedClose,true,'parent closes without Saga task ID');
  }
  const list = await call('list_tabs');
  assert.ok(list.some((tab) => tab.tab_id === manager.id && tab.role === 'orchestrator'));
  const denial = await call('close_worker', { tab_id: manager.id }).then(
    () => false, () => true);
  assert.equal(denial, true, 'manager tab must never be closable via worker method');
  const stillConnected = (await (await fetch(origin + '/health')).json()).extensionConnected;
  assert.equal(stillConnected, true, 'profile stays connected without a revocable MCP credential');
  let managerDiagnostics = null;
  if (wakeUncertain) {
    const observation = await extension.evaluate(
      'chrome.tabs.sendMessage(' + manager.id + ', {cmd:"diagnose"})').catch(() => null);
    managerDiagnostics = observation ? {
      input: observation.input, send: observation.send, user: observation.user,
      composer: observation.composer, sendButton: observation.sendButton,
      generating: observation.generating, buttons: observation.hints?.buttons,
    } : { unavailable: true };
  }
  console.log('REAL_EDGE_EXTENSION_SMOKE_PASS ' + JSON.stringify({
    realEdge: true, realElectron45: true, extensionConnected: true,
    managerTabId: manager.id, profileSelected: true, durableStatus: true,
    deduplicated: true, noProxyAuth: true,
    managerChatIdle: registered.observation === 'idle', liveWorker, liveCount, wakeDelivered, wakeUncertain,
    queuePromptVisible, managerDomPromptVisible, managerComposerStillContainsQueue, managerDiagnostics,
    fullWorkflow,fixingTaskId,ackedCount,reviewedClose,nestedCompleted,independentRootCompleted,
    recoveryCompleted,
  }));
} finally {
  if (client) await client.close().catch(() => {});
  extension.close();
  desktop.close();
}
