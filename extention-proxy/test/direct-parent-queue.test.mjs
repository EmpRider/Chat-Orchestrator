// Real Proxy/MCP/WebSocket integration with a simulated browser extension.
// Verifies direct-edge authorization and durable Child -> Parent FIFO delivery.
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

const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
const route='https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
test('D-072/D-073 direct Child clarification and message survive busy Parent; sibling writes denied',{
  timeout:30000,
},async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-orch-parent-fifo-'));
  fs.writeFileSync(path.join(dir,'coordination.events.journal'),'');
  const browser=randomUUID(),parentInc=randomUUID(),childInc=randomUUID(),taskId=randomUUID();
  const server=spawn(process.execPath,['server.js'],{
    cwd:path.resolve(import.meta.dirname||path.dirname(new URL(import.meta.url).pathname),'..'),
    env:{...process.env,PORT:'0',HOST:'127.0.0.1',
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
    let output='';
    const timer=setTimeout(()=>reject(Error('Server startup timeout: '+output)),9000);
    server.stdout.on('data',(buf)=>{
      output+=String(buf);
      const match=/listening on http:\/\/[^:]+:(\d+)/.exec(output);
      if(match){clearTimeout(timer);resolve(Number(match[1]));}
    });
    server.stderr.on('data',(buf)=>{output+=String(buf);});
    server.once('exit',(code)=>{clearTimeout(timer);reject(Error('Proxy exited '+code+': '+output));});
  });
  client=new Client({name:'direct-parent-fifo-test',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+port+'/mcp')));
  bridge=new WebSocket('ws://127.0.0.1:'+port+'/bridge');
  const wakes=[];
  let busy=true;
  bridge.on('message',(raw)=>{
    const m=JSON.parse(String(raw));
    if(m.type!=='call')return;
    const tabId=m.params?.tab_id;
    const inc=tabId===201?childInc:parentInc;
    let result;
    switch(m.method){
      case 'inspect_tab':
        result={tab_id:tabId,site:'chatgpt',browser_session_id:browser,
          incarnation_id:inc,route_hash:createHash('sha256').update(
            [browser,tabId,inc,'chatgpt'].join(':')).digest('hex'),
          parent_approved:tabId===101,is_managed_worker:tabId===201};
        break;
      case 'attest_profile_manager':result={tab_id:tabId,browser_session_id:browser,
        incarnation_id:inc,connection_generation:1};break;
      case 'recover_owned_children':result=[];break;
      case 'spawn_worker':result={tab_id:201,incarnation_id:childInc,
        prepared:true,reused_tab:false};break;
      case 'start_prepared_worker':result={task_id:taskId,tab_id:201,status:'running'};break;
      case 'hold_child_for_context':result={tab_id:201,task_id:taskId,
        status:'WAITING_FOR_PARENT_CONTEXT',origin_parent_url:route};break;
      case 'manager_state':result={tab_id:m.params.__trustedPrincipal.callerTabId,
        browser_session_id:browser,
        incarnation_id:m.params.__trustedPrincipal.sessionIncarnationId,
        state:busy?'busy':'idle',ready:!busy,conversation_route:route};break;
      case 'wake_manager':wakes.push(m.params);result={submitted:true,uncertain:false};break;
      case 'manager_processed':result={processed:true};break;
      default:result={ok:true};
    }
    bridge.send(JSON.stringify({type:'result',id:m.id,ok:true,result}));
  });
  await new Promise((resolve,reject)=>{bridge.once('open',resolve);bridge.once('error',reject);});
  bridge.send(JSON.stringify({type:'register_session',browser_session_id:browser,
    connection_generation:1,proxy_session_id:'direct-parent-test'}));
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Handshake timeout')),4000);
    const listener=(raw)=>{if(JSON.parse(String(raw)).type==='session_registered'){
      clearTimeout(timer);bridge.off('message',listener);resolve();
    }};
    bridge.on('message',listener);
  });
  bridge.send(JSON.stringify({type:'session_ready'}));
  async function pair(tabId,inc){
    const code=randomUUID(),id=randomUUID();
    const ack=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Pairing offer timeout')),4000);
      const listener=(raw)=>{
        const m=JSON.parse(String(raw));
        if(m.type==='pairing_offer_ack'&&m.request_id===id){
          clearTimeout(timer);bridge.off('message',listener);
          m.ok?resolve():reject(Error(m.error));
        }
      };
      bridge.on('message',listener);
    });
    bridge.send(JSON.stringify({type:'pairing_offer',request_id:id,code,
      tab_id:tabId,incarnation_id:inc,route_hash:createHash('sha256').update(
        [browser,tabId,inc,'chatgpt'].join(':')).digest('hex')}));
    await ack;
    const response=await client.callTool({name:'pair_conversation',arguments:{
      code,idempotency_key:randomUUID()}});
    assert.equal(response.isError,undefined,response.content?.[0]?.text);
    return JSON.parse(response.content[0].text).agent_credential;
  }
  async function call(name,credential,args={}){
    const response=await client.callTool({name,arguments:{
      agent_credential:credential,idempotency_key:randomUUID(),
      browser_session_id:browser,...args}});
    if(response.isError)throw Error(response.content[0].text);
    return JSON.parse(response.content[0].text);
  }
  const parentCredential=await pair(101,parentInc);
  const created=await call('spawn_worker',parentCredential,{
    caller_tab_id:101,site:'chatgpt',task:'Investigate this simple question',wait_seconds:0,
  });
  assert.equal(created.tab_id,201);
  const childCredential=await pair(201,childInc);
  // Parent is busy and has not explicitly invoked register_manager.
  const clarification=await call('request_parent_context',childCredential,{
    caller_tab_id:201,task_id:taskId,question:'Which specification version?',});
  assert.equal(clarification.state,'QUEUED');
  assert.equal(clarification.task_status,'WAITING_FOR_PARENT_CONTEXT');
  const message=await call('send_to_tab',childCredential,{
    caller_tab_id:201,tab_id:101,text:'Please check the context request'});
  assert.equal(message.state,'QUEUED');
  assert.equal(message.queued_for,'direct_parent');
  assert.equal(message.task_created,false);
  await assert.rejects(call('send_to_tab',childCredential,{
    caller_tab_id:201,tab_id:301,text:'Sibling not allowed'}),/direct child/);
  const pending=await call('coordination_pending',parentCredential,{caller_tab_id:101});
  assert.equal(pending.events.length,2);
  assert.deepEqual(pending.events.map((item)=>item.entryType),
    ['STATUS_REQUEST','STATUS_REQUEST']);
  assert.equal(wakes.length,0,'busy Parent may not receive an interrupting prompt');
  busy=false;
  await call('coordination_start_delivery',parentCredential,{caller_tab_id:101});
  for(let i=0;i<75&&wakes.length<1;i++)await sleep(40);
  assert.equal(wakes.length,1);
  assert.equal(wakes[0].origin_parent_url,route,'clarification returns to the task origin');
  assert.equal(wakes[0].events.length,1,'different conversation destinations retain FIFO');
  for(let i=0;i<75;i++){
    const current=await call('coordination_pending',parentCredential,{caller_tab_id:101});
    if(current.events[0]?.phase==='DELIVERED')break;
    await sleep(40);
  }
  await call('coordination_ack_batch',parentCredential,{caller_tab_id:101,
    batch_id:wakes[0].batch_id,event_ids:wakes[0].events.map((event)=>event.event_id)});
  for(let i=0;i<75&&wakes.length<2;i++)await sleep(40);
  assert.equal(wakes.length,2,'direct Parent message follows review of clarification');
  assert.match(wakes[1].events[0].summary,/CHILD_MESSAGE/);
});
