import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';

function makeNode() {
  const listeners=new Map();
  let text='';
  return {
    children:[],style:{},value:'',disabled:false,hidden:false,
    get textContent(){return text;},
    set textContent(value){text=String(value);this.children=[];},
    append(...nodes){this.children.push(...nodes);},
    setAttribute(key,value){this[key]=value;},
    addEventListener(type,listener){listeners.set(type,listener);},
    dispatch(type){return listeners.get(type)?.();},
  };
}

test('queue actions expose persistent per-row results and errors across polling renders',async()=>{
  const elements=new Map();
  const element=(id)=>{
    if(!elements.has(id))elements.set(id,makeNode());
    return elements.get(id);
  };
  const browserSessionId=randomUUID(),batchId=randomUUID();
  const snapshot={
    storageReady:true,phases:{QUEUED:1,UNCERTAIN:1},
    seats:[],tabHierarchy:[],toolCalls:[],completionAlerts:[],
    queue:[{eventId:randomUUID(),type:'CHILD_RESULT',phase:'UNCERTAIN',
      managerTabId:101,browserSessionId,principalId:randomUUID(),
      batchId,seq:1}],
  };
  const state={
    phase:'running',ngrokPhase:'stopped',ngrokAuthConfigured:false,
    error:'',ngrokError:'',extensionConnected:true,routeVerified:false,
    domain:'',publicPath:'/mcp',port:8787,profile:'default',
    coordinationSnapshot:snapshot,
  };
  let listener;
  const calls=[];
  let release;
  const bridge={
    onState(cb){listener=cb;},
    status:async()=>state,
    focusQueueManager:async()=>({focused:true}),
    recoverQueueBatch:async(tab,session,batch,action,reason)=>{
      calls.push({tab,session,batch,action,reason});
      if(action==='recheck')throw Error('Manager tab unavailable');
      if(action==='retry_draft')return new Promise(resolve=>{release=resolve;});
      return {phase:'SKIPPED',draft_cleanup_required:true,ledger_synced:false};
    },
  };
  const document={getElementById:element,createElement:makeNode};
  const window={bridge,confirm:()=>true,prompt:()=> 'Original manager tab is unavailable',
    addEventListener(){}};
  const source=readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),
    '..','desktop','renderer.js'),'utf8');
  runInNewContext(source,{document,window,Map,Set});
  await new Promise(resolve=>setImmediate(resolve));
  const row=()=>element('queue-items').children[0];
  const button=(title)=>row().children.find(node=>node.textContent===title);
  const feedback=()=>row().children.find(node=>node.className==='queue-recovery-feedback');
  assert.ok(button('Recheck'));
  await button('Recheck').dispatch('click');
  assert.equal(calls.at(-1).action,'recheck');
  assert.match(feedback().textContent,/Recovery failed: Manager tab unavailable/);
  listener({...state,coordinationSnapshot:{...snapshot}});
  assert.match(feedback().textContent,/Manager tab unavailable/,
    'polling must not erase the recovery error');

  const retry=button('Retry exact draft').dispatch('click');
  assert.ok(release,'retry must be routed to the actual IPC bridge');
  assert.equal(button('Recheck').disabled,true,'avoid duplicate clicks during in-flight action');
  release({phase:'DELIVERED',verified:true});
  await retry;
  assert.equal(button('Recheck').disabled,false);
  assert.match(feedback().textContent,/Sent user turn verified/);
  await button('Skip batch').dispatch('click');
  assert.equal(calls.at(-1).action,'skip');
  assert.equal(calls.at(-1).reason,'Original manager tab is unavailable');
  assert.match(feedback().textContent,/draft cleanup needs manual inspection/);
  assert.equal(calls.every(call=>call.tab===101&&call.session===browserSessionId&&
    call.batch===batchId),true,'buttons use exact original recipient and batch');
});

test('D-012 closure warning includes a Child waiting for Parent context',()=>{
  const source=readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),
    '..','desktop','renderer.js'),'utf8');
  const begin=source.indexOf('const closureFirstShown=');
  const end=source.indexOf('async function refreshAgentClosures()');
  assert.ok(begin>=0 && end>begin,'closure renderer must be present');
  const elements=new Map();
  const document={getElementById(id){
    if(!elements.has(id))elements.set(id,makeNode());
    return elements.get(id);
  }};
  const context={document,Map,Date};
  runInNewContext('const $=(id)=>document.getElementById(id);'+
    'const currentState={phase:"running",extensionConnected:true};'+
    source.slice(begin,end),context);
  runInNewContext(`closureSnapshot=[{
    id:'pending-parent',status:'pending',kind:'parent',title:'Parent Agent',
    oldTabId:101,url:'https://chatgpt.com/c/saved',createdAt:Date.now()-10000,
    descendants:[
      {tabId:201,parentTabId:101,title:'Request Run Token',state:'waiting_for_parent_context'},
      {tabId:202,parentTabId:101,title:'MCP Task Setup',state:'done'}
    ]}];renderAgentClosureDialog();`,context);
  const warning=document.getElementById('closure-warning').textContent;
  assert.match(warning,/1 descendant Agent\(s\).*Parent-context-dependent work/);
  assert.doesNotMatch(warning,/No active descendant tasks/);
  assert.match(document.getElementById('closure-descendants').textContent,
    /waiting_for_parent_context/);
});

test('D-044 manual status UI displays evidence and descendants, serializes clicks and preserves waiting state',async()=>{
  const elements=new Map();
  const element=(id)=>{
    if(!elements.has(id))elements.set(id,makeNode());
    return elements.get(id);
  };
  const taskId=randomUUID(),browserSessionId=randomUUID(),childTaskId=randomUUID();
  const alert={
    task_id:taskId,tab_id:201,browser_session_id:browserSessionId,
    status:'running',completion_evidence:'UNKNOWN',manual_required:true,
    check_count:4,last_observation:{state:'IDLE_RESPONSE_UNVERIFIED',evidence:'NONE'},
    pending_descendants:true,pending_descendant_tasks:[
      {tab_id:301,task_id:childTaskId,status:'running',parent_reviewed:false}],
  };
  const snapshot={storageReady:true,phases:{},seats:[],tabHierarchy:[],
    queue:[],toolCalls:[],completionAlerts:[alert]};
  const state={phase:'running',ngrokPhase:'stopped',ngrokAuthConfigured:false,
    error:'',ngrokError:'',extensionConnected:true,domain:'',
    publicPath:'/mcp',port:8787,profile:'default',coordinationSnapshot:snapshot};
  let listener,release;
  const calls=[];
  const bridge={
    onState(cb){listener=cb;},status:async()=>state,
    setCompletionStatus:(task,status,session)=>{
      calls.push({task,status,session});
      return new Promise(resolve=>{release=resolve;});
    },
  };
  const document={getElementById:element,createElement:makeNode};
  const window={bridge,addEventListener(){}};
  const source=readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),
    '..','desktop','renderer.js'),'utf8');
  runInNewContext(source,{document,window,Map,Set});
  await new Promise(resolve=>setImmediate(resolve));
  const row=()=>element('completion-alerts').children[0];
  const item=(name)=>row().children.find(el=>el.textContent===name);
  assert.match(row().children[0].textContent,/IDLE_RESPONSE_UNVERIFIED/);
  assert.match(row().children[1].textContent,/tab 301/);
  assert.match(row().children[1].textContent,new RegExp(childTaskId));
  const first=item('Completed').dispatch('click');
  assert.equal(calls.length,1);
  assert.equal(calls[0].task,taskId);
  assert.equal(calls[0].session,browserSessionId);
  assert.equal(item('In Progress').disabled,true);
  await item('In Progress').dispatch('click');
  assert.equal(calls.length,1,'no second decision during an unresolved request');
  release({task_id:taskId,status:'waiting_for_children',pending_descendants:true});
  await first;
  assert.match(element('message').textContent,/waiting for descendant review/i);
  listener({...state,coordinationSnapshot:{...snapshot,completionAlerts:[
    {...alert,status:'waiting_for_children',completion_evidence:'USER_CONFIRMED',
      manual_required:false}]}});
  assert.equal(item('Completed'),undefined,'a deferred task cannot be confirmed twice');
  assert.equal(item('In Progress'),undefined);
  assert.match(row().children[0].textContent,/USER_CONFIRMED/);
  listener({...state,coordinationSnapshot:{...snapshot,completionAlerts:[
    {...alert,status:'done',completion_evidence:'USER_CONFIRMED',
      manual_required:false,pending_descendants:false,
      pending_descendant_tasks:[],notification_pending:true}]}});
  assert.match(row().children[0].textContent,/Parent FIFO journal receipt NOT confirmed/);
  assert.equal(item('Completed'),undefined,'journal reconciliation must never re-run a completion choice');
});
