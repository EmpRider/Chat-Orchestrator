// LC-16 (P0): review_task is the gate that releases a reused Child's next
// independent task.
//
// Catalog:
//   Stimulus: Parent calls `review_task` after inspecting child result
//   Expected: Child may begin next independent task
//   Source:   server.js:2887-2904 (tool: :2925-2945; real gate: background.js:3100-3120)
//
// The gate is not in the tool, it is in the extension. background.js:1911-1930
// holds a new independent task on `unreviewedIndependentWork` — any task on the
// tab that is queued, unfinished, or `parentReviewed !== true`. review_task
// (:3100-3120) flips `parentReviewed` and then calls dispatchQueuedIndependent.
// So the causal claim this file must prove is an ORDERING, not a flag:
// the same dispatch attempt fails before the review and succeeds after it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {webcrypto} from 'node:crypto';

const source=readFileSync(new URL('../../extention/background.js',import.meta.url),'utf8')
  .replace(/\nconnect\(\);\s*$/, '\n');
const UUID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARENT_TAB=101;
const CHILD_TAB=201;

function setup() {
  const storage={browserSessionId:UUID,proxySessionId:UUID};
  const mockTabs=new Map([
    [PARENT_TAB,{id:PARENT_TAB,url:'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',status:'complete'}],
    [CHILD_TAB,{id:CHILD_TAB,url:'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222',status:'complete'}],
  ]);
  const localGet = async (query) => {
    const keys = typeof query === 'string' ? [query]
      : Array.isArray(query) ? query : Object.keys(query || {});
    return Object.fromEntries(keys.map((key) => [key, undefined]));
  };
  const chrome={
    storage:{
      session:{
        get:async()=>storage,
        set:async(d)=>Object.assign(storage,d),
        remove:async(keys)=>{for(const k of keys)delete storage[k];},
      },
      local:{get:localGet,set:async()=>{}},
      onChanged:{addListener(){}},
    },
    tabs:{get:async(id)=>mockTabs.get(id)||null,create:async()=>null,remove:async()=>{},
      query:async()=>[...mockTabs.values()],reload:async()=>{},
      onUpdated:{addListener(){}},onRemoved:{addListener(){}}},
    runtime:{id:'test-extension',getURL:(p)=>'chrome-extension://test/'+p,
      onMessage:{addListener(){}},onStartup:{addListener(){}},onInstalled:{addListener(){}}},
    alarms:{onAlarm:{addListener(){}},create(){}},
  };
  const ctx=createContext({chrome,crypto:webcrypto,TextEncoder,URL,console,
    setTimeout,clearTimeout,setInterval,clearInterval});
  runInContext(source,ctx);
  const evalCode=(js)=>runInContext(js,ctx);
  return {ctx,evalCode,ready:evalCode('stateReady')};
}

// One reviewed-able Child with one finished task, plus a second independent
// task the Parent wants to run on that same reused tab.
function arrange(h, {childStatus='done', reviewed=false}={}) {
  h.evalCode(`
    proxySettings={enabled:true,maxWorkers:10,maxTasksPerHour:100,taskTimeoutMin:60,
      connectorName:'PC1',promptSchema:2,promptModules:{}};
    proxySettingsRevision=1; wsState='connected';
    workers=[${CHILD_TAB}];
    workerParents={${CHILD_TAB}:${PARENT_TAB}};
    workerOwners={${CHILD_TAB}:'legacy'};
    workerIncarnations={${CHILD_TAB}:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
    tasks={
      child:{id:'child',tabId:${CHILD_TAB},site:'chatgpt',owner:'legacy',
        status:${JSON.stringify(childStatus)},result:'child ready',startedAt:1,
        parentReviewed:${reviewed}},
    };
    queuedIndependent=[]; queuedFollowups=[]; lostWorkers={};
    // The mutation surface: nothing below this line may ever reach a browser.
    started=[];
    startTask=async function(tabId,site,text,waitSecs,cfg,autoClose,owner,queuedTaskId){
      started.push({tabId,site,text,owner,queuedTaskId});
      // Faithful to startTask: the queued record becomes the running task.
      if (queuedTaskId && tasks[queuedTaskId]) tasks[queuedTaskId].status='running';
    };
  `);
}

const settle=async(h,ms=1000)=>{
  const deadline=Date.now()+ms;
  while(!h.evalCode('started.length') && Date.now()<deadline)
    await new Promise((r)=>setTimeout(r,10));
};

test('LC-16 an independent task cannot start on a reused Child until the Parent reviews',async()=>{
  const h=setup();await h.ready;
  arrange(h);
  // The precondition the gate is supposed to notice.
  assert.equal(h.evalCode('unreviewedIndependentWork')(CHILD_TAB),true);

  // The Parent asks for a second task on the same tab. It must be QUEUED,
  // not started — the finished-but-unreviewed task holds it.
  const queued=await h.evalCode('launchOrQueueIndependent')(
    CHILD_TAB,'chatgpt','second independent task',0,await h.evalCode('getConfig')(),'legacy');
  assert.equal(queued.status,'queued','an unreviewed Child must not accept a new task');
  assert.equal(h.evalCode('started.length'),0,'nothing may be dispatched before review');
  assert.equal(h.evalCode('queuedIndependent.length'),1);

  // Directly re-running the dispatch pump must also refuse — otherwise the
  // queue would drain by itself and review_task would be decorative.
  await h.evalCode('dispatchQueuedIndependent')(CHILD_TAB);
  assert.equal(h.evalCode('started.length'),0,
    'dispatchQueuedIndependent must refuse while the earlier task is unreviewed');
  assert.equal(h.evalCode('queuedIndependent.length'),1,'the held task stays held');

  // The catalog stimulus: the Parent reviews the Child's finished result.
  const reviewed=await h.evalCode('handleCall')('review_task',{task_id:'child',tab_id:CHILD_TAB});
  assert.equal(reviewed.reviewed,true);
  assert.equal(h.evalCode('tasks.child.parentReviewed'),true);

  // The catalog expectation: the Child may now begin the next independent task.
  await settle(h);
  assert.equal(h.evalCode('started.length'),1,
    'review_task must release exactly the one held independent task');
  assert.equal(h.evalCode('queuedIndependent.length'),0,'the queue must drain');
  const started=h.evalCode('started[0]');
  assert.equal(started.tabId,CHILD_TAB);
  assert.equal(started.text,'second independent task',
    'the released task must be the one the Parent queued, verbatim');
  // The queued record is the record that starts — it is not a fresh task.
  assert.ok(started.queuedTaskId,'the released task must carry its queued task id');
  assert.equal(h.evalCode('tasks['+JSON.stringify(started.queuedTaskId)+'].status'),'running',
    'the held record must transition out of queued when it is dispatched');
});

test('LC-16 review is refused while the Child task is still active, so it cannot unlock early',async()=>{
  // A control: without this, the first test would also pass if review_task
  // simply ignored task status.
  const h=setup();await h.ready;
  arrange(h,{childStatus:'running'});
  await assert.rejects(
    h.evalCode('handleCall')('review_task',{task_id:'child',tab_id:CHILD_TAB}),
    /still active, queued or uncertain/);
  assert.notEqual(h.evalCode('tasks.child.parentReviewed'),true);
  assert.equal(h.evalCode('unreviewedIndependentWork')(CHILD_TAB),true);
});

test('LC-16 review is refused from the wrong tab and from a non-owning caller',async()=>{
  const h=setup();await h.ready;
  arrange(h);
  // A sibling Child is owned and is a real worker, so the tab-identity gate —
  // not the ownership gate — is the one under test here.
  h.evalCode(`
    workers=[${CHILD_TAB},202];
    workerParents[202]=${PARENT_TAB};
    workerOwners[202]='legacy';
    workerIncarnations[202]='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  `);
  await assert.rejects(
    h.evalCode('handleCall')('review_task',{task_id:'child',tab_id:202}),
    /not the original or recovered Child tab/,
    'review is tab-bound: a sibling Child cannot review this one');
  // The Parent tab is not a worker at all, so it fails one gate earlier.
  await assert.rejects(
    h.evalCode('handleCall')('review_task',{task_id:'child',tab_id:PARENT_TAB}),
    /Only the direct owning Parent/);
  // A profile caller whose credential does not own the Child is refused too.
  h.evalCode(`approvedParents[${PARENT_TAB}]='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    managerIncarnations[${PARENT_TAB}]='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';`);
  await assert.rejects(
    h.evalCode('handleCall')('review_task',{task_id:'child',tab_id:CHILD_TAB,
      __trustedPrincipal:{mode:'profile',browserSessionId:UUID,
        credentialId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        callerTabId:PARENT_TAB,sessionIncarnationId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'}}),
    /Only the direct owning Parent/);
  assert.notEqual(h.evalCode('tasks.child.parentReviewed'),true,
    'no refused review may have side effects');
  assert.equal(h.evalCode('queuedIndependent.length'),0);
});
