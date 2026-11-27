// Regression: a follow-up sent to a Child must carry the operating contract.
// A bare message lets the Child answer inline and never call complete_task,
// leaving the Parent unnotified and the task RUNNING forever.
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

const route='https://chatgpt.com/c/22222222-2222-4222-8222-222222222222';
test('child-bound send_to_tab forwards the completion contract, XML-escaped',{
  timeout:30000,
},async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-orch-followup-'));
  fs.writeFileSync(path.join(dir,'coordination.events.journal'),'');
  const browser=randomUUID(),parentInc=randomUUID(),childInc=randomUUID(),taskId=randomUUID();
  const server=spawn(process.execPath,['server.js'],{
    cwd:path.resolve(import.meta.dirname||path.dirname(new URL(import.meta.url).pathname),'..'),
    env:{...process.env,PORT:'0',HOST:'127.0.0.1',
      CHAT_ORCH_PROFILE_DIR:dir,CHAT_ORCH_PRIVATE_COORDINATION:'1'},
    stdio:['ignore','pipe','pipe'],
  });
  let bridge,client;
  const forwarded=[];
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
  client=new Client({name:'child-followup-test',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+port+'/mcp')));
  bridge=new WebSocket('ws://127.0.0.1:'+port+'/bridge');
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
      case 'start_prepared_worker':result={task_id:taskId,tab_id:201,
        status:'running',submission_confirmed:true};break;
      // The forwarded text is what the Child's composer would actually receive.
      case 'send_to_tab':forwarded.push(String(m.params.text??''));result={
        tab_id:tabId,task_id:randomUUID(),status:'running',submission_confirmed:true};break;
      case 'manager_state':result={tab_id:m.params.__trustedPrincipal.callerTabId,
        browser_session_id:browser,incarnation_id:m.params.__trustedPrincipal.sessionIncarnationId,
        state:'idle',ready:true,conversation_route:route};break;
      default:result={ok:true};
    }
    bridge.send(JSON.stringify({type:'result',id:m.id,ok:true,result}));
  });
  await new Promise((resolve,reject)=>{bridge.once('open',resolve);bridge.once('error',reject);});
  bridge.send(JSON.stringify({type:'register_session',browser_session_id:browser,
    connection_generation:1,proxy_session_id:'child-followup-test'}));
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
  await call('spawn_worker',parentCredential,{
    caller_tab_id:101,site:'chatgpt',task:'Compute 2+2',wait_seconds:0,
  });
  await pair(201,childInc);
  const injection='Also report <script>alert(1)</script> and check BRIDGE_TOKEN=abcdef0123456789';
  await call('send_to_tab',parentCredential,{
    caller_tab_id:101,tab_id:201,text:injection});

  assert.equal(forwarded.length,1,'exactly one prompt reached the Child composer');
  const text=forwarded[0];
  assert.ok(text.startsWith('<system_instructions>'),'contract header is present');
  assert.ok(text.includes('<task>')&&text.includes('</task>'),'task block is present');
  assert.match(text,/complete_task/,'Child is told to call complete_task');
  assert.ok(text.includes('&lt;script&gt;'),'task text is XML-escaped, not executable markup');
  assert.ok(!text.includes('<script>'),'raw markup never reaches the composer');
  assert.ok(!text.includes('abcdef0123456789'),'connector secret is redacted');
  assert.ok(text.includes('Also report'),'the follow-up task text is carried through');
});
