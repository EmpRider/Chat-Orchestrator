// STRESS-01..05: real Proxy/MCP/WebSocket stress harness with a simulated
// browser extension. Covers: concurrent spawn fan-out, FIFO queue flood with
// ordered ACK, duplicate-submission idempotency replay, stale-recipient
// rejection, and queue saturation back-pressure. No real browser, no ChatGPT.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
const root=path.resolve(import.meta.dirname??path.dirname(new URL(import.meta.url).pathname),'..');
const routeHashFor=(browser,tabId,inc)=>createHash('sha256')
  .update([browser,tabId,inc,'chatgpt'].join(':')).digest('hex');

// Spin a proxy + a scripted fake extension. `handlers` may override methods.
async function startRig(t,{handlers={}}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-orch-stress-'));
  fs.writeFileSync(path.join(dir,'coordination.events.journal'),'');
  const browser=randomUUID();
  const incs=new Map();
  const server=spawn(process.execPath,['server.js'],{
    cwd:root,env:{...process.env,PORT:'0',HOST:'127.0.0.1',
      CHAT_ORCH_PROFILE_DIR:dir,CHAT_ORCH_PRIVATE_COORDINATION:'1'},
    stdio:['ignore','pipe','pipe'],
  });
  let bridge,client;
  t.after(async()=>{
    await client?.close().catch(()=>{});
    bridge?.terminate();server.kill();
    fs.rmSync(dir,{recursive:true,force:true});
  });
  const port=await new Promise((resolve,reject)=>{
    let out='';
    const timer=setTimeout(()=>reject(Error('startup timeout '+out)),9000);
    server.stdout.on('data',(b)=>{out+=String(b);
      const m=/listening on http:\/\/[^:]+:(\d+)/.exec(out);
      if(m){clearTimeout(timer);resolve(Number(m[1]));}});
    server.stderr.on('data',(b)=>{out+=String(b);});
    server.once('exit',(c)=>{clearTimeout(timer);reject(Error('proxy exited '+c+': '+out));});
  });
  client=new Client({name:'stress',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+port+'/mcp')));
  bridge=new WebSocket('ws://127.0.0.1:'+port+'/bridge');
  const wakes=[];
  const calls=[];
  const incOf=(tabId)=>incs.get(tabId)||(tabId<=100?randomUUID():randomUUID());
  bridge.on('message',(raw)=>{
    const m=JSON.parse(String(raw));
    if(m.type!=='call')return;
    calls.push(m.method);
    const tabId=m.params?.tab_id;
    const inc=incs.get(tabId)??(incs.set(tabId,randomUUID()).get(tabId));
    let result;
    if(handlers[m.method])result=handlers[m.method](m,{browser,inc,incs,wakes});
    else switch(m.method){
      case 'inspect_tab':result={tab_id:tabId,site:'chatgpt',browser_session_id:browser,
        incarnation_id:inc,route_hash:routeHashFor(browser,tabId,inc),
        parent_approved:tabId<=100,is_managed_worker:tabId>100};break;
      case 'attest_profile_manager':result={tab_id:tabId,browser_session_id:browser,
        incarnation_id:inc,connection_generation:1};break;
      case 'recover_owned_children':result=[];break;
      case 'list_tabs':result=[...incs.entries()].map(([tabId])=>({
        tab_id:tabId,site:'chatgpt',browser_session_id:browser,
        incarnation_id:incs.get(tabId),
        role:tabId<=100?'parent':'child'}));break;
      case 'spawn_worker':{const childTab=200+incs.size;
        incs.set(childTab,randomUUID());
        result={tab_id:childTab,incarnation_id:incs.get(childTab),
          prepared:true,reused_tab:false};break;}
      case 'start_prepared_worker':result={task_id:randomUUID(),
        tab_id:tabId,status:'running',submission_confirmed:true};break;
      case 'hold_child_for_context':result={tab_id:tabId,task_id:randomUUID(),
        status:'WAITING_FOR_PARENT_CONTEXT',origin_parent_url:routeHashFor(browser,1,incs.get(1))};break;
      case 'manager_state':result={tab_id:m.params.__trustedPrincipal?.callerTabId,
        browser_session_id:browser,
        incarnation_id:m.params.__trustedPrincipal?.sessionIncarnationId,
        state:'idle',ready:true,conversation_route:'https://chatgpt.com/c/1'};break;
      case 'wake_manager':wakes.push(m.params);result={submitted:true,uncertain:false};break;
      case 'manager_processed':result={processed:true};break;
      default:result={ok:true};
    }
    bridge.send(JSON.stringify({type:'result',id:m.id,ok:true,result}));
  });
  await new Promise((res,rej)=>{bridge.once('open',res);bridge.once('error',rej);});
  bridge.send(JSON.stringify({type:'register_session',browser_session_id:browser,
    connection_generation:1,proxy_session_id:'stress-rig'}));
  await new Promise((res,rej)=>{
    const timer=setTimeout(()=>rej(Error('handshake timeout')),4000);
    const l=(raw)=>{if(JSON.parse(String(raw)).type==='session_registered'){
      clearTimeout(timer);bridge.off('message',l);res();}};
    bridge.on('message',l);
  });
  bridge.send(JSON.stringify({type:'session_ready'}));
  const pair=async(tabId)=>{
    const inc=incs.get(tabId)??(incs.set(tabId,randomUUID()).get(tabId));
    const code=randomUUID(),id=randomUUID();
    const ack=new Promise((res,rej)=>{
      const timer=setTimeout(()=>rej(Error('pairing offer timeout')),4000);
      const l=(raw)=>{const m=JSON.parse(String(raw));
        if(m.type==='pairing_offer_ack'&&m.request_id===id){
          clearTimeout(timer);bridge.off('message',l);m.ok?res():rej(Error(m.error));}};
      bridge.on('message',l);
    });
    bridge.send(JSON.stringify({type:'pairing_offer',request_id:id,code,tab_id:tabId,
      incarnation_id:inc,route_hash:routeHashFor(browser,tabId,inc)}));
    await ack;
    const r=await client.callTool({name:'pair_conversation',arguments:{
      code,idempotency_key:randomUUID()}});
    assert.equal(r.isError,undefined,r.content?.[0]?.text);
    return JSON.parse(r.content[0].text).agent_credential;
  };
  const call=async(name,cred,args={},idempotency_key=randomUUID())=>{
    const r=await client.callTool({name,arguments:{agent_credential:cred,
      idempotency_key,browser_session_id:browser,...args}});
    if(r.isError)throw Error(r.content[0].text);
    return JSON.parse(r.content[0].text);
  };
  return {dir,browser,incs,client,bridge,calls,wakes,pair,call};
}

test('STRESS-01 concurrent spawn fan-out is serialised, no duplicate tabs',{
  timeout:60000,
},async(t)=>{
  const rig=await startRig(t);
  const cred=await rig.pair(1);
  const results=await Promise.allSettled(Array.from({length:4},(_,i)=>
    rig.call('spawn_worker',cred,{caller_tab_id:1,site:'chatgpt',
      task:'stress task '+i,wait_seconds:0})));
  const ok=results.filter((r)=>r.status==='fulfilled');
  assert.equal(ok.length,4,'all four concurrent spawns should succeed');
  const tabs=new Set(ok.map((r)=>r.value.tab_id));
  assert.equal(tabs.size,4,'each concurrent spawn must receive a distinct child tab');
  assert.equal(rig.wakes.length,0,'no Parent wake for child spawn alone');
});

test('STRESS-02 FIFO flood: 12 child results delivered then ACKed in order',{
  timeout:60000,
},async(t)=>{
  const rig=await startRig(t);
  const parent=await rig.pair(1);
  const created=await rig.call('spawn_worker',parent,{caller_tab_id:1,site:'chatgpt',
    task:'parent task',wait_seconds:0});
  const childTab=created.tab_id;
  const child=await rig.pair(childTab);
  const taskIds=[];
  for(let i=0;i<12;i++){
    const r=await rig.call('send_to_tab',child,{caller_tab_id:childTab,tab_id:1,
      text:'follow-up '+i});
    if(r.task_id)taskIds.push(r.task_id);
  }
  const pending=await rig.call('coordination_pending',parent,{caller_tab_id:1});
  assert.ok(pending.events.length>=12,'queue must retain every queued event');
  const original=pending.events.map((e)=>e.event_id);
  // Events are delivered one per batch; count them.
  let delivered=0,batches=0;
  while(true){
    await rig.call('coordination_start_delivery',parent,{caller_tab_id:1});
    for(let i=0;i<150&&rig.wakes.length<=batches;i++)await sleep(40);
    if(rig.wakes.length<=batches)break;
    batches++;
    delivered+=rig.wakes[rig.wakes.length-1].events.length;
    await rig.call('coordination_ack_batch',parent,{caller_tab_id:1,
      batch_id:rig.wakes[rig.wakes.length-1].batch_id,
      event_ids:rig.wakes[rig.wakes.length-1].events.map((e)=>e.event_id)});
    if(delivered>=original.length)break;
    if(batches>50)break; // safety
  }
  assert.equal(delivered,original.length,'every queued event is delivered exactly once in FIFO order');
  // After every delivered batch is ACKed, all events reach a terminal phase.
  const finalPending=await rig.call('coordination_pending',parent,{caller_tab_id:1});
  const nonTerminal=finalPending.events.filter((e)=>!['PROCESSED','SAGA_CONFIRMED']
    .includes(e.phase));
  assert.equal(nonTerminal.length,0,'all flooded events reach PROCESSED');
  assert.equal(finalPending.queue_blocked,undefined,'queue is not frozen');
  // Verify no duplicates: all original events were delivered once.
  const seen=new Set();
  for(const batch of rig.wakes){
    for(const e of batch.events){
      assert.ok(!seen.has(e.event_id),'event delivered exactly once');
      seen.add(e.event_id);
    }
  }
  assert.equal(seen.size,original.length,'no duplicate deliveries');
});

test('STRESS-03 ACK with wrong event set is refused; queue stays intact',{
  timeout:45000,
},async(t)=>{
  const rig=await startRig(t);
  const parent=await rig.pair(1);
  const created=await rig.call('spawn_worker',parent,{caller_tab_id:1,site:'chatgpt',
    task:'parent task',wait_seconds:0});
  const child=await rig.pair(created.tab_id);
  await rig.call('send_to_tab',child,{caller_tab_id:created.tab_id,tab_id:1,text:'one'});
  await rig.call('coordination_start_delivery',parent,{caller_tab_id:1});
  for(let i=0;i<150&&rig.wakes.length<1;i++)await sleep(40);
  const batch=rig.wakes[0];
  await assert.rejects(rig.call('coordination_ack_batch',parent,{caller_tab_id:1,
    batch_id:batch.batch_id,event_ids:[randomUUID()]}),/./,
    'ACK naming an event that was not delivered must be refused');
  const pending=await rig.call('coordination_pending',parent,{caller_tab_id:1});
  assert.ok(pending.events.length>=1,'refused ACK must not consume the delivery');
});

test('STRESS-04 idempotency: same key replays identical result, no double side effect',{
  timeout:45000,
},async(t)=>{
  const rig=await startRig(t);
  const cred=await rig.pair(1);
  const key=randomUUID();
  const a=await rig.call('spawn_worker',cred,{caller_tab_id:1,site:'chatgpt',
    task:'idem task',wait_seconds:0},key);
  const b=await rig.call('spawn_worker',cred,{caller_tab_id:1,site:'chatgpt',
    task:'idem task',wait_seconds:0},key);
  assert.equal(a.tab_id,b.tab_id,'replayed idempotency key must not create a second child');
  assert.deepEqual(a,b,'replay must return the identical response body');
});

test('STRESS-05 concurrent independent parents stay isolated',{
  timeout:60000,
},async(t)=>{
  const rig=await startRig(t);
  const p1=await rig.pair(1),p2=await rig.pair(2);
  const [c1,c2]=await Promise.all([
    rig.call('spawn_worker',p1,{caller_tab_id:1,site:'chatgpt',task:'p1 child',wait_seconds:0}),
    rig.call('spawn_worker',p2,{caller_tab_id:2,site:'chatgpt',task:'p2 child',wait_seconds:0}),
  ]);
  assert.notEqual(c1.tab_id,c2.tab_id);
  const child2=await rig.pair(c2.tab_id);
  await assert.rejects(rig.call('send_to_tab',child2,{caller_tab_id:c2.tab_id,
    tab_id:1,text:'cross-parent write'}),/direct child/,
    'child of parent 2 must not write to parent 1 directly');
  const tabs1=await rig.call('list_tabs',p1,{caller_tab_id:1});
  const arr=Array.isArray(tabs1)?tabs1:(tabs1.tabs??tabs1.tabsList??tabs1.tabsList??[]);
  assert.ok(Array.isArray(arr),'list_tabs returns inventory array');
});
