// Isolated real Proxy/MCP/WebSocket integration. No live browser tabs touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import WebSocket from 'ws';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const pause=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));

test('operator can Skip held FIFO when paired manager tab is unavailable; Recheck cannot bypass attestation',{
  timeout:20000,
},async(t)=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'chat-orch-queue-recovery-'));
  fs.writeFileSync(path.join(profile,'coordination.events.journal'),'');
  process.env.PORT='0';
  process.env.HOST='127.0.0.1';
  process.env.CHAT_ORCH_PROFILE_DIR=profile;
  process.env.CHAT_ORCH_SETTINGS_DIR=profile;
  process.env.CHAT_ORCH_PRIVATE_COORDINATION='1';
  delete process.env.CHAT_ORCH_EXTENSION_PROFILE_TOKEN;
  const {startServer,stopServer,desktopAction}=await import('../server.js');
  let ws,client;
  t.after(async()=>{
    await client?.close().catch(()=>{});
    ws?.terminate();
    await stopServer();
    fs.rmSync(profile,{recursive:true,force:true});
  });
  const address=await startServer();
  const browser=randomUUID(),incarnation=randomUUID();
  let managerUnavailable=false;
  const wakeups=[];
  ws=new WebSocket('ws://127.0.0.1:'+address.port+'/bridge');
  const sessionReady=new Promise((resolve,reject)=>{
    ws.on('message',raw=>{
      const packet=JSON.parse(String(raw));
      if(packet.type==='session_registered'){
        ws.send(JSON.stringify({type:'session_ready'}));
        resolve();
      }
      if(packet.type!=='call')return;
      const p=packet.params||{};
      let reply;
      try{
        switch(packet.method){
          case 'inspect_all_tabs':reply=[{tab_id:101,site:'chatgpt'}];break;
          case 'inspect_tab':
            reply={tab_id:p.tab_id,site:'chatgpt',browser_session_id:browser,
              incarnation_id:incarnation,
              route_hash:createHash('sha256').update(
                [browser,p.tab_id,incarnation,'chatgpt'].join(':')).digest('hex'),
              parent_approved:true,is_managed_worker:false};
            break;
          case 'attest_profile_manager':
            reply={tab_id:p.tab_id,browser_session_id:browser,
              incarnation_id:incarnation,connection_generation:1};
            break;
          case 'recover_owned_children':reply=[];break;
          case 'manager_state':
            if(managerUnavailable)throw Error('Manager tab unavailable; select a supported chat tab');
            reply={tab_id:101,browser_session_id:browser,incarnation_id:incarnation,
              state:'idle',ready:true};
            break;
          case 'wake_manager':
            wakeups.push(p);
            reply={submitted:false,uncertain:true};
            break;
          case 'clear_skipped_manager_batch':
          case 'resolve_manager_recovery':
            if(managerUnavailable)throw Error('Manager tab unavailable');
            reply={ok:true,recorded:true,cleared:true};
            break;
          default:reply={ok:true};
        }
        ws.send(JSON.stringify({type:'result',id:packet.id,ok:true,result:reply}));
      }catch(error){
        ws.send(JSON.stringify({type:'result',id:packet.id,ok:false,error:error.message}));
      }
    });
    ws.once('open',()=>ws.send(JSON.stringify({
      type:'register_session',browser_session_id:browser,
      connection_generation:1,proxy_session_id:'queue-recovery-fixture',
    })));
    ws.once('error',reject);
  });
  await sessionReady;
  client=new Client({name:'queue-recovery-fixture',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(
    new URL('http://127.0.0.1:'+address.port+'/mcp')));
  const pairingCode=randomUUID(),requestId=randomUUID();
  const pairingAck=new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('Pairing ACK timed out')),4000);
    const observe=raw=>{
      const packet=JSON.parse(String(raw));
      if(packet.type!=='pairing_offer_ack'||packet.request_id!==requestId)return;
      clearTimeout(timeout);ws.off('message',observe);
      packet.ok?resolve():reject(Error(packet.error));
    };
    ws.on('message',observe);
  });
  ws.send(JSON.stringify({type:'pairing_offer',request_id:requestId,
    code:pairingCode,tab_id:101,incarnation_id:incarnation,
    route_hash:createHash('sha256').update([browser,101,incarnation,'chatgpt']
      .join(':')).digest('hex')}));
  await pairingAck;
  const paired=await client.callTool({name:'pair_conversation',
    arguments:{code:pairingCode,idempotency_key:randomUUID()}});
  assert.equal(paired.isError,undefined,JSON.stringify(paired.content));
  const agent_credential=JSON.parse(paired.content[0].text).agent_credential;
  async function call(name,args={}){
    const reply=await client.callTool({name,arguments:{browser_session_id:browser,
      caller_tab_id:101,agent_credential,idempotency_key:randomUUID(),...args}});
    if(reply.isError)throw Error(reply.content?.[0]?.text||'MCP error');
    return JSON.parse(reply.content[0].text);
  }
  await call('coordination_register_manager');
  await call('coordination_status_request',{summary:'Validate tab-independent operator skip'});
  let held;
  for(let attempt=0;attempt<80;attempt++){
    const pending=await call('coordination_pending');
    held=pending.events[0];
    if(held?.phase==='UNCERTAIN'&&wakeups.length)break;
    await pause(40);
  }
  assert.equal(held?.phase,'UNCERTAIN','fixture must create a held uncertain batch');
  const batch=wakeups[0].batch_id;
  managerUnavailable=true;
  await assert.rejects(desktopAction({action:'recover_queue_batch',tab_id:101,
    browser_session_id:browser,decision_id:batch,choice:'recheck'}),
  /Manager tab unavailable/,'Recheck needs the live paired tab');
  const skipped=await desktopAction({action:'recover_queue_batch',tab_id:101,
    browser_session_id:browser,decision_id:batch,choice:'skip',
    reason:'The original Parent tab is unavailable'});
  assert.equal(skipped.phase,'SKIPPED');
  assert.equal(skipped.retained_in_journal,true);
  assert.equal(skipped.automatically_delivered,false);
  assert.equal(skipped.draft_cleanup_required,true);
  assert.equal((await call('coordination_pending')).events[0].phase,'SKIPPED');
  assert.equal(wakeups.length,1,'Skip must never send another notification');
});
