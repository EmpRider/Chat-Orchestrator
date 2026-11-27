// DA cluster (P0/P1): the completion monitor must not treat "the page settled"
// as "the task answered".
//
// Catalog DA-01..DA-08 all describe the same mechanism from different angles.
// The defect (test-artifacts/failures/D-A-short-answer-never-completes.md):
// `uiCandidate.signature` is the settled assistant turn itself, so for any
// answer <=140 chars `normalized(lastAssistant).includes(signature)` is trivially
// true and the ONLY gate was `signature.length >= 12`. Answers of 12+ chars with
// no final-answer cue therefore auto-completed; answers under 12 chars never did.
//
// The fix makes both completion paths demand the same explicit cue, keeping
// their distinct length floors:
//   signature path:  >=12 chars + cue  (signature already proved same turn)
//   marker path:     >=24 chars + cue  (only this task's UUID in transcript)
//
// These tests drive the REAL extention/background.js in a node:vm context.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {webcrypto} from 'node:crypto';

const source=readFileSync(new URL('../../extention/background.js',import.meta.url),'utf8')
  .replace(/\nconnect\(\);\s*$/, '\n');
const UUID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TASK_ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TAB=201;
const ROUTE='https://chatgpt.com/c/22222222-2222-4222-8222-222222222222';

function setup() {
  const storage={browserSessionId:UUID,proxySessionId:UUID};
  const mockTabs=new Map([
    [101,{id:101,url:'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',status:'complete'}],
    [TAB,{id:TAB,url:ROUTE,status:'complete'}],
  ]);
  const chrome={
    storage:{session:{get:async()=>storage,set:async(d)=>Object.assign(storage,d),
      remove:async(keys)=>{for(const k of keys)delete storage[k];}},local:{
      get:async(q)=>typeof q==='string'?{[q]:undefined}
        :Array.isArray(q)?Object.fromEntries(q.map((k)=>[k,undefined])):{},
      set:async()=>{}},onChanged:{addListener(){}}},
    tabs:{get:async(id)=>mockTabs.get(id)||null,create:async()=>null,remove:async()=>{},
      reload:async()=>{},query:async()=>[...mockTabs.values()],
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

// Arrange one running task whose captured UI signature is `signature`, and make
// the reloaded tab report `transcript` as its assistant turn. Returns a runner
// that executes one monitor check.
async function arrange(h,{signature,transcript,route=ROUTE}) {
  h.evalCode(`
    workers=[${TAB}];
    workerIncarnations={${TAB}:'44444444-4444-4444-8444-444444444444'};
    tasks={${JSON.stringify(TASK_ID)}:{
      id:${JSON.stringify(TASK_ID)},tabId:${TAB},site:'chatgpt',status:'running',
      startedAt:1,owner:'legacy',
      workerIncarnationId:workerIncarnations[${TAB}],
      uiCandidate:{signature:${JSON.stringify(signature)},conversationRoute:${JSON.stringify(route)}},
      monitor:{step:0,nextCheckAt:0,manualRequired:false}}};
    pageSettling.waitForReady=async()=>({ready:true});
    // sleep() resolves on setTimeout; invoke immediately so one call = one check.
    // scheduleNextCompletionCheck only sets monitor.nextCheckAt, so nothing
    // re-enters inspectDueCompletion from here.
    setTimeout=(fn)=>{fn();return 1;};
    proxySettings={completionMonitor:{initialMinutes:5,retryMinutes:[5,3,1],
      hydrationSeconds:5,continuedMinutes:2}};
    tabMessage=async(id,msg)=>msg.cmd==='observe_state'
      ? {ok:true,state:'idle'}
      : {ok:true,transcript:'User: task\\n\\nAssistant: '+${JSON.stringify(transcript)}};
  `);
  await h.evalCode('inspectDueCompletion')(TASK_ID);
  return {
    status:()=>h.evalCode('tasks['+JSON.stringify(TASK_ID)+'].status'),
    evidence:()=>h.evalCode('tasks['+JSON.stringify(TASK_ID)+'].monitor.lastObservation'+
      '.evidence'),
    manualRequired:()=>h.evalCode('tasks['+JSON.stringify(TASK_ID)+'].monitor.manualRequired'),
    observations:()=>h.evalCode('tasks['+JSON.stringify(TASK_ID)+'].monitor.step'),
  };
}

// A control that would pass under the OLD code too: it proves the monitor is
// actually reaching the completion decision, so the refusals below are not
// vacuous (an early return would also leave the task running).
test('DA control: a 24+ char answer with an explicit cue does complete',async()=>{
  const h=setup();await h.ready;
  const m=await arrange(h,{
    signature:'The answer is 323, exactly. That is 17 times 19.',
    transcript:'The answer is 323, exactly. That is 17 times 19.'});
  assert.equal(m.status(),'done','a cued answer must still complete');
  assert.equal(h.evalCode('tasks['+JSON.stringify(TASK_ID)+'].completionEvidence'),'UI_INFERRED');
});

// DA-02: the 12-char signature path must stay green — but only with a cue.
// Both sides of the boundary are asserted, because the fix changed what the
// 12-char floor MEANS: it is no longer sufficient alone.
test('DA-02 a 12-char answer matching the signature completes only when it carries a cue',async()=>{
  // The catalog does not say DA-02's answer lacks a cue, and it cannot: DA-04
  // is the same signature path with the same absence of cue at 23 chars, so a
  // rule that completed one and refused the other would be length-decreasing.
  // "final answer" is exactly 12 characters and is itself a cue phrase.
  const cued='final answer';
  assert.equal(cued.length,12);
  assert.equal(/\b(?:final answer|final result|completed task|task completed|here is the result|the result is|the answer is)\b/i.test(cued),true);

  const h=setup();await h.ready;
  const m=await arrange(h,{signature:cued,transcript:cued});
  assert.equal(m.status(),'done');
  assert.equal(m.evidence(),'MATCHED_CALLBACK_SIGNATURE',
    'the signature path, not the marker fallback, must carry a 12-char answer');

  // The other side, pinned to the literal wave-6 fixture: `RESULT-12CHR` is
  // exactly 12 chars and self-matches, but carries no cue, so it must now stay
  // running. This is the tightening D-A required, and it supersedes the wave-6
  // record that this exact string completed via MATCHED_CALLBACK_SIGNATURE.
  const uncued='RESULT-12CHR';
  assert.equal(uncued.length,12);
  assert.equal(/\b(?:final answer|final result|completed task|task completed|here is the result|the result is|the answer is)\b/i.test(uncued),false);
  const h2=setup();await h2.ready;
  const m2=await arrange(h2,{signature:uncued,transcript:uncued});
  assert.equal(m2.status(),'running','a cue is required even at the 12-char floor');
  assert.equal(m2.evidence(),'NONE');
});

// DA-04 (FAIL before the fix): 23 chars, self-matching signature, no cue.
test('DA-04 a 23-char answer with no cue must NOT auto-complete',async()=>{
  const h=setup();await h.ready;
  const answer='ABCDE12345FGHIJ67890KLM';
  assert.equal(answer.length,23);
  const m=await arrange(h,{signature:answer,transcript:answer});
  assert.equal(m.status(),'running',
    'a settled page is not an answer: no cue means no completion');
  assert.equal(m.evidence(),'NONE');
});

// DA-07 (FAIL before the fix): the word "answer" alone is not the cue; the cue
// regex is phrase-level. 24 chars keeps every length gate satisfied so only the
// cue clause can refuse.
test('DA-07 a 24-char answer containing "answer" but not the cue phrase does not complete',async()=>{
  const h=setup();await h.ready;
  // Exactly the catalog's case: 24 chars, the word "answer" present, but the
  // cue regex is phrase-level ("the answer is") so a near-miss must not pass.
  const answer='my answer is ready right';
  assert.equal(answer.length,24);
  assert.ok(/\banswer\b/.test(answer));
  assert.equal(/\b(?:final answer|final result|completed task|task completed|here is the result|the result is|the answer is)\b/i.test(answer),false);
  const m=await arrange(h,{signature:answer,transcript:answer});
  assert.equal(m.status(),'running',
    'the cue regex is phrase-level; a near-miss must not complete');
  assert.equal(m.evidence(),'NONE');
});

// DA-08 (FAIL before the fix): a multi-line answer collapses to <=23 chars and
// still must not complete on its own.
test('DA-08 a multi-line short answer with no cue does not auto-complete',async()=>{
  const h=setup();await h.ready;
  // 3 lines, trimmed+collapsed total well under 24, no cue.
  const answer='line one\nline two\nok';
  assert.ok(answer.replace(/\s+/g,' ').trim().length<24);
  const m=await arrange(h,{
    signature:answer.replace(/\s+/g,' ').trim(),
    transcript:answer});
  assert.equal(m.status(),'running');
  assert.equal(m.evidence(),'NONE');
});

// DA-01: an answer below every length floor never completed and still must not,
// but the monitor must still be scheduling checks (it is a stall, not a crash).
test('DA-01 a 3-char answer stays running and keeps the monitor scheduled',async()=>{
  const h=setup();await h.ready;
  const m=await arrange(h,{signature:'391',transcript:'391'});
  assert.equal(m.status(),'running');
  assert.equal(m.evidence(),'NONE');
  assert.equal(m.observations(),1,'the monitor must have advanced exactly one step');
});

// An in-progress phrase disqualifies a settled turn even when it carries a cue
// and is long enough — the second half of D-042 that was previously unreachable
// for the signature path (the cue branch short-circuited before it).
test('an in-progress phrase disqualifies an otherwise-cued settled answer',async()=>{
  const h=setup();await h.ready;
  const answer='The final answer is still working, waiting for more input.';
  assert.ok(answer.length>=24);
  const m=await arrange(h,{signature:answer,transcript:answer});
  assert.equal(m.status(),'running',
    'a refusal phrase must override the cue');
  assert.equal(m.evidence(),'NONE');
});
