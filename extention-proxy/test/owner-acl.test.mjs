// Offline negative tests: one shared transport connection, independent scoped MCP callers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import {composeAgentPrompt,normalizeAgentSettings} from '../agent-settings.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'extention', 'background.js'), 'utf8');
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const BROWSER_SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MANAGER_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MANAGER_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const principalA = { mode: 'scoped', role: 'pm', credentialId: A, callerTabId: 101,
  browserSessionId: BROWSER_SESSION, sessionIncarnationId: MANAGER_A };
const principalB = { mode: 'scoped', role: 'tl', credentialId: B, callerTabId: 102,
  browserSessionId: BROWSER_SESSION, sessionIncarnationId: MANAGER_B };
const principalBA = { ...principalA, role: 'ba',
  credentialId: '00000000-0000-4000-8000-000000000003' };
const tabs = [
  { id: 101, url: 'https://chatgpt.com/c/manager-a', title: 'A manager', active: true, windowId: 1 },
  { id: 102, url: 'https://chatgpt.com/c/manager-b', title: 'B manager', active: false, windowId: 2 },
  { id: 201, url: 'https://chatgpt.com/c/worker-a', title: 'A worker', active: false, windowId: 3 },
  { id: 202, url: 'https://chatgpt.com/c/worker-b', title: 'B worker', active: false, windowId: 4 },
];
const taskA = { id: 'a-result', tabId: 201, site: 'chatgpt', status: 'done', result: 'A private result', owner: 'credential:' + A, startedAt: Date.now() };
const taskB = { id: 'b-result', tabId: 202, site: 'chatgpt', status: 'done', result: 'B private result', owner: 'credential:' + B, startedAt: Date.now() };

test('all six Worker Tool operations enforce credential and tab ownership', async () => {
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]));
  const storage = {
    tasks: { [taskA.id]: taskA, [taskB.id]: taskB },
    workers: [201, 202],
    workerOwners: { 201: 'credential:' + A, 202: 'credential:' + B },
    workerIncarnations: { 201: '55555555-5555-4555-8555-555555555555', 202: '66666666-6666-4666-8666-666666666666' },
    taskLog: [], browserSessionId: BROWSER_SESSION,
    managerIncarnations: { 101: MANAGER_A, 102: MANAGER_B },
  };
  let managerSubmitCount = 0;
  let submittedBatchText = '';
  let nextWorkerTabId = 301;
  let removedCb, updatedCb;
  const chrome = {
    storage: {
      session: { get: async () => storage, set: async (next) => Object.assign(storage, next) },
      local: { get: async () => ({ enabled: true, token: '', maxWorkers: 10, maxTasksPerHour: 30, orchestratorTabId: 101 }) },
      onChanged: { addListener() {} },
    },
    tabs: {
      query: async () => [...tabById.values()],
      get: async (id) => tabById.get(id) ?? null,
      sendMessage: async (id, msg) => msg.cmd === 'ping'
        ? { ok: true, ready: true, state: 'idle' }
        : msg.cmd === 'observe_state'
        ? { ok: true, state: 'idle' }
        : msg.cmd === 'submit_manager_batch'
          ? (managerSubmitCount++, submittedBatchText = msg.text, { ok: true, submitted: true })
          : { ok: true, transcript: 'transcript for ' + id },
      remove: async (id) => { tabById.delete(id); },
      onRemoved: { addListener(fn) { removedCb=fn; } },
      onUpdated: { addListener(fn) { updatedCb=fn; } },
    },
    windows: { create: async ({ url }) => {
      const tabId = nextWorkerTabId++;
      const workerTab = { id: tabId, url, title: 'New independent worker', active: false, windowId: 9 };
      tabById.set(tabId, workerTab);
      return { tabs: [workerTab] };
    } },
    runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} } },
    alarms: { onAlarm: { addListener() {} }, create() {} },
  };
  const ctx = createContext({ chrome, crypto: webcrypto, URL, console, setTimeout, clearTimeout, setInterval, clearInterval });
  runInContext(source, ctx);
  const rawHandleCall = runInContext('handleCall', ctx);
  const settings=normalizeAgentSettings({});
  const handleCall=(method,args={})=>rawHandleCall(method,method==='spawn_worker'?
    {...args,prompt_text:composeAgentPrompt(settings,{kind:'task',task:args.task,operation:args.operation||'task'})}:
    method==='wake_manager'?{...args,prompt_text:composeAgentPrompt(settings,{kind:'queue',batchId:args.batch_id,events:args.events})}:args);
  const defaults = runInContext('DEFAULTS', ctx);
  assert.match(defaults.serverUrl, /\/bridge$/);
  assert.equal(runInContext('proxySettings', ctx), null, 'Extension starts fail-closed without proxy snapshot');
  runInContext("proxySettings = { enabled: true, maxWorkers: 10, maxTasksPerHour: 100, taskTimeoutMin: 60, promptSchema: 2, promptModules: {} }", ctx);
  assert.equal(runInContext('SITES.gemini.newChatUrl', ctx), 'https://gemini.google.com/app');
  const buildPrompt = runInContext('buildWorkerPrompt', ctx);
  const composed=composeAgentPrompt(settings,{kind:'task',task:'Investigate one scope'});
  assert.match(buildPrompt({},'Investigate one scope','','any-role',composed),/<task>/);
  assert.doesNotMatch(composed,/Council A|BA Watchdog|@AgentBridge|@Worker Tool/);
  const withOwner = (p, principal) => ({ ...p, __trustedPrincipal: principal });

  const ownTabs = await handleCall('list_tabs', withOwner({}, principalA));
  assert.deepEqual(Array.from(ownTabs, (t) => t.tab_id), [101, 201]);
  assert.deepEqual(Array.from(await handleCall('list_tabs', withOwner({}, principalB)), (t) => t.tab_id), [102, 202]);

  assert.equal((await handleCall('get_result', withOwner({ task_id: taskA.id }, principalA))).result, 'A private result');
  await assert.rejects(handleCall('get_result', withOwner({ task_id: taskA.id }, principalB)), /Unknown task_id/);
  await assert.rejects(handleCall('get_result', { task_id: taskA.id }), /Unknown task_id/);
  await assert.rejects(handleCall('read_chat', withOwner({ tab_id: 201 }, principalB)), /outside this caller scope/);
  await assert.rejects(handleCall('read_chat', withOwner({ tab_id: 102 }, principalA)), /outside this caller scope/);
  await assert.rejects(handleCall('send_to_tab', withOwner({ tab_id: 202, text: 'attack' }, principalA)), /owned by this caller/);
  await assert.rejects(handleCall('close_worker', withOwner({ tab_id: 202 }, principalA)), /outside this caller scope/);
  await assert.rejects(handleCall('spawn_worker', withOwner({
    site: 'chatgpt', task: 'attack', share_context_from: '202',
  }, principalA)), /outside this caller scope/);

  await assert.rejects(handleCall('spawn_worker', withOwner({
    site: 'chatgpt', role: 'watchdog', task: 'Unauthorized watchdog',
  }, principalA)), /Only an authenticated BA principal/);
  await assert.rejects(handleCall('spawn_worker', {
    site: 'chatgpt', role: 'watchdog', task: 'Legacy watchdog',
  }), /Only an authenticated BA principal/);
  const parentStart = Date.now();
  const independent = await handleCall('spawn_worker', withOwner({
    site: 'chatgpt', role: 'council_a', task: 'Council stage 1 independent proposal',
    keep_open: true, wait_seconds: 0,
  }, principalA));
  assert.equal(independent.status, 'running', 'parent yields without waiting for worker completion');
  assert.ok(Date.now() - parentStart < 2500, 'spawn returns promptly after accepted prompt');
  assert.ok(tabById.has(301), 'worker remains open while parent continues');
  assert.equal((await handleCall('get_result', withOwner({ task_id: independent.task_id }, principalA))).status, 'running');
  await assert.rejects(handleCall('get_result', withOwner({ task_id: independent.task_id }, principalB)), /Unknown task_id/);
  runInContext('finishTask', ctx)(independent.task_id, { status: 'done', result: 'Asynchronous child finished' });
  assert.equal((await handleCall('get_result', withOwner({ task_id: independent.task_id }, principalA))).result,
    'Asynchronous child finished');
  assert.ok(tabById.has(301), 'completion alone never auto-closes a worker');
  const councilFollowup = await handleCall('send_to_tab', withOwner({
    tab_id: 301, text: 'Council stage 2 same-tab peer review', wait_seconds: 0,
  }, principalA));
  assert.equal(councilFollowup.tab_id, 301, 'Council stages reuse the exact prior worker tab');
  assert.equal(councilFollowup.status, 'running');
  assert.equal(nextWorkerTabId, 302, 'a Council follow-up must not create another window');
  runInContext('finishTask', ctx)(councilFollowup.task_id, {
    status: 'done', result: 'Same-tab peer review complete',
  });
  const watchdog = await handleCall('spawn_worker', withOwner({
    site: 'chatgpt', role: 'watchdog', task: 'Independent BA-owned safety audit',
    keep_open: true, wait_seconds: 0,
  }, principalBA));
  assert.equal(watchdog.status, 'running');
  assert.ok(tabById.has(302));
  assert.ok(!Array.from(await handleCall('list_tabs', withOwner({}, principalA)),
    (t) => t.tab_id).includes(302), 'PM cannot access BA Watchdog worker');
  runInContext('finishTask', ctx)(watchdog.task_id, {
    status: 'done', result: 'BA-owned Watchdog reported independently',
  });

  // A PM remains assigned to the same epic, a TL to the same major task,
  // and each Council seat to the same parent across independent stages.
  const pmSeat = await handleCall('spawn_worker', withOwner({
    site: 'chatgpt', role: 'pm', role_scope: 'epic:15',
    task: 'PM stage 1', keep_open: true, wait_seconds: 0,
  }, principalA));
  assert.equal(pmSeat.reused_tab, false);
  assert.equal(pmSeat.status, 'running');
  await assert.rejects(handleCall('spawn_worker', withOwner({
    site: 'chatgpt', role: 'pm', role_scope: 'epic:15',
    task: 'Overtaking PM while active', keep_open: true,
  }, principalA)), /outstanding task/);
  assert.equal((await handleCall('read_chat', withOwner({}, principalBA))).transcript,
    'transcript for 101', 'BA may request status while PM descendants are active');
  runInContext('finishTask', ctx)(pmSeat.task_id, { status: 'done', result: 'Epic handoff ready' });
  const pmStage2 = await handleCall('spawn_worker', withOwner({
    site: 'chatgpt', role: 'pm', role_scope: 'epic:15',
    task: 'PM stage 2 same epic', keep_open: true,
  }, principalA));
  assert.equal(pmStage2.tab_id, pmSeat.tab_id);
  assert.equal(pmStage2.reused_tab, true);
  runInContext('finishTask', ctx)(pmStage2.task_id, { status: 'done', result: 'Epic stage 2' });
  assert.ok(Array.from(await handleCall('list_tabs', withOwner({}, principalA)),
    (t) => t.seat_scope).includes('epic:15'));

  const tlSeat = await handleCall('spawn_worker', withOwner({
    site: 'chatgpt', role: 'tl', role_scope: 'task:68',
    task: 'TL major-task stage 1', keep_open: true,
  }, principalB));
  assert.equal(tlSeat.reused_tab, false);
  runInContext('finishTask', ctx)(tlSeat.task_id, { status: 'done', result: 'Major-task stage 1' });
  const tlStage2 = await handleCall('spawn_worker', withOwner({
    site: 'chatgpt', role: 'tl', role_scope: 'task:68',
    task: 'TL major-task stage 2', keep_open: true,
  }, principalB));
  assert.equal(tlStage2.tab_id, tlSeat.tab_id);
  assert.equal(tlStage2.reused_tab, true);
  runInContext('finishTask', ctx)(tlStage2.task_id, { status: 'done', result: 'Major-task stage 2' });
  assert.ok(!Array.from(await handleCall('list_tabs', withOwner({}, principalA)),
    (t) => t.tab_id).includes(tlSeat.tab_id), 'PM must not see TL-owned seat');

  const councilSeat = await handleCall('spawn_worker', withOwner({
    site: 'chatgpt', role: 'council_b', role_scope: 'parent:68',
    task: 'Council initial position', keep_open: true,
  }, principalA));
  runInContext('finishTask', ctx)(councilSeat.task_id, { status: 'done', result: 'Frozen initial' });
  const councilStage2 = await handleCall('spawn_worker', withOwner({
    site: 'chatgpt', role: 'council_b', role_scope: 'parent:68',
    task: 'Anonymous peer review, same tab', keep_open: true,
  }, principalA));
  assert.equal(councilStage2.reused_tab, true);
  assert.equal(councilStage2.tab_id, councilSeat.tab_id);
  runInContext('finishTask', ctx)(councilStage2.task_id, { status: 'done', result: 'Peer review' });
  await assert.rejects(handleCall('spawn_worker', withOwner({
    site: 'chatgpt', role: 'pm', role_scope: 'task:68', task: 'Wrong Saga scope',
  }, principalA)), /Invalid role_scope/);
  await assert.rejects(handleCall('spawn_worker', {
    site: 'chatgpt', role: 'pm', role_scope: 'epic:15', task: 'No trusted owner',
  }), /scoped principal/);

  const self = await handleCall('read_chat', withOwner({}, principalA));
  assert.equal(self.transcript, 'transcript for 101');
  const bResult = await handleCall('get_result', withOwner({ task_id: taskB.id }, principalB));
  assert.equal(bResult.result, 'B private result');
  await assert.rejects(handleCall('close_worker', withOwner({ tab_id: 201 }, principalA)), /HELD until independent Saga verification/);
  assert.ok(tabById.has(201), 'even owned scoped worker must stay open before Saga proof');
  assert.ok(tabById.has(202), 'cross-owner closure did not happen');
  const batchId = '11111111-1111-4111-8111-111111111111';
  const event = {
    event_id: '22222222-2222-4222-8222-222222222222',
    type: 'CHILD_RESULT', summary: 'Complete', recorded_at: new Date().toISOString(),
  };
  const wake = await handleCall('wake_manager', withOwner({
    batch_id: batchId, events: [event],
  }, principalA));
  assert.equal(wake.submitted, true);
  assert.equal(managerSubmitCount, 1);
  assert.match(submittedBatchText, /For each CHILD_RESULT/);
  assert.match(submittedBatchText, /ordered batch/);
  assert.match(submittedBatchText, /event identifiers and original FIFO order/);
  await assert.rejects(handleCall('wake_manager', withOwner({
    batch_id: batchId, events: [event],
  }, principalA)), /pending or uncertain/);
  await assert.rejects(handleCall('manager_processed', withOwner({
    batch_id: batchId,
  }, principalB)), /No submitted batch/);
  assert.equal(managerSubmitCount, 1, 'no duplicate chat submission');
  assert.equal((await handleCall('manager_processed', withOwner({
    batch_id: batchId,
  }, principalA))).processed, true);
  // CHILD_TAB_LOST is a durable manager event, not a worker task or a new role.
  const lostBatchId = '55555555-5555-4555-8555-555555555555';
  const lostEvent = {
    event_id: '66666666-6666-4666-8666-666666666666',
    type: 'CHILD_TAB_LOST',
    summary: JSON.stringify({task_id:'original-child-task', child_tab_id:202,
      saved_url:'https://chatgpt.com/c/worker-b', status:'UNKNOWN',
      reason:'Tab removed; crash not proven'}),
    recorded_at: new Date().toISOString(),
  };
  const lostWake = await handleCall('wake_manager', withOwner({
    batch_id: lostBatchId, events: [lostEvent],
  }, principalA));
  assert.equal(lostWake.submitted, true);
  assert.equal(managerSubmitCount, 2);
  assert.match(submittedBatchText, /CHILD_TAB_LOST/);
  assert.match(submittedBatchText, /saved_url/);
  assert.match(submittedBatchText, /read_chat/);
  assert.match(submittedBatchText, /get_result/);
  assert.doesNotMatch(submittedBatchText, /@AgentBridge|When a task requires files/);
  assert.equal((await handleCall('manager_processed', withOwner({
    batch_id: lostBatchId,
  }, principalA))).processed, true);
  const competing = await Promise.allSettled([
    handleCall('wake_manager', withOwner({
      batch_id: '33333333-3333-4333-8333-333333333333', events: [event],
    }, principalA)),
    handleCall('wake_manager', withOwner({
      batch_id: '44444444-4444-4444-8444-444444444444', events: [event],
    }, principalA)),
  ]);
  assert.equal(competing.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(managerSubmitCount, 3, 'concurrent wakes submit only one additional batch');
  await assert.rejects(handleCall('close_verified_worker', withOwner({
    tab_id: 201, worker_incarnation_id: storage.workerIncarnations[201],
    saga_event_id: '77777777-7777-4777-8777-777777777777',
    saga_verified: false,
  }, principalA)), /Trusted Saga closure proof/);
  await assert.rejects(handleCall('close_verified_worker', withOwner({
    tab_id: 201, worker_incarnation_id: storage.workerIncarnations[202],
    saga_event_id: '77777777-7777-4777-8777-777777777777',
    saga_verified: true,
  }, principalA)), /incarnation mismatch/);
  const closure = await handleCall('close_verified_worker', withOwner({
    tab_id: 201, worker_incarnation_id: storage.workerIncarnations[201],
    saga_event_id: '77777777-7777-4777-8777-777777777777',
    saga_verified: true,
  }, principalA));
  assert.equal(closure.saga_verified, true);
  assert.equal(tabById.has(201), false, 'verified closure removed only owned worker tab');
  assert.equal((await handleCall('attest_manager_tab', { tab_id: 101 })).incarnation_id, MANAGER_A);
  // Integration smoke: unexpected child loss retains URL and owner-scoped task,
  // and reopens the original conversation without resuming work automatically.
  storage.tasks[taskB.id].workerIncarnationId = storage.workerIncarnations[202];
  await updatedCb(202,{url:'https://chatgpt.com/c/worker-b'},tabById.get(202));
  tabById.delete(202);
  await removedCb(202);
  await assert.rejects(handleCall('reopen_child',withOwner({task_id:taskB.id},principalA)),/caller scope/);
  const recovery=await handleCall('reopen_child',withOwner({task_id:taskB.id},principalB));
  assert.equal(recovery.status,'REATTACHED');
  assert.equal(recovery.old_tab_id,202);
  assert.equal(recovery.execution_resumed,false);
  assert.equal(recovery.saved_url,'https://chatgpt.com/c/worker-b');
  assert.ok(tabById.has(recovery.tab_id));
  assert.equal((await handleCall('read_chat',withOwner({tab_id:recovery.tab_id},principalB))).transcript,'transcript for '+recovery.tab_id);
  assert.equal((await handleCall('get_result',withOwner({task_id:taskB.id},principalB))).status,'done');
  assert.equal((await handleCall('reopen_child',withOwner({task_id:taskB.id},principalB))).reused,true);
  storage.managerIncarnations[101] = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  await assert.rejects(handleCall('list_tabs', withOwner({}, principalA)), /incarnation changed/);
  assert.deepEqual(Array.from(await handleCall('list_tabs', withOwner({}, principalB)), (t) => t.tab_id), [102, tlSeat.tab_id, recovery.tab_id]);
  runInContext("browserSessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'", ctx);
  await assert.rejects(handleCall('list_tabs', withOwner({}, principalB)), /incarnation changed/);



});
