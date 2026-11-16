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
