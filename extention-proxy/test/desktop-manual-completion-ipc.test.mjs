// Regresses the Desktop -> utilityProcess IPC whitelist and the actual
// authenticated Proxy -> Extension dispatch. No real browser is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';

test('Completion decisions are accepted through Desktop IPC and routed to the same authenticated browser', {
  timeout:15000,
},async(t)=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'chat-orch-completion-ipc-'));
  const token='ab'.repeat(32);
  process.env.PORT='0';
  process.env.HOST='127.0.0.1';
  process.env.CHAT_ORCH_PROFILE_DIR=profile;
  process.env.CHAT_ORCH_SETTINGS_DIR=profile;
  process.env.CHAT_ORCH_PRIVATE_COORDINATION='0';
  process.env.CHAT_ORCH_EXTENSION_PROFILE_TOKEN=token;
  const {startServer,stopServer,desktopAction,isSupportedDesktopExtensionAction,
    handleDesktopExtensionActionPacket}=
    await import('../server.js');
  for(const action of ['set_manual_completion','list_completion_monitors'])
    assert.equal(isSupportedDesktopExtensionAction(action),true,
      'the utilityProcess must not silently discard '+action);
  assert.equal(isSupportedDesktopExtensionAction('arbitrary_untrusted_action'),false);
  const posted=[],port={postMessage:packet=>posted.push(packet)};
  const requestId=randomUUID();
  const dispatches=[];
  for(const action of ['list_completion_monitors','set_manual_completion']) {
    const consumed=await handleDesktopExtensionActionPacket({
      type:'desktop_extension_action',request_id:requestId,action,
      decision_id:randomUUID(),choice:'completed',
    },port,async(packet)=>{dispatches.push(packet.action);return {accepted:true};});
    assert.equal(consumed,true);
    assert.equal(posted.at(-1).ok,true,'the Electron utility IPC must reply');
    assert.equal(posted.at(-1).request_id,requestId);
  }
  assert.deepEqual(dispatches,['list_completion_monitors','set_manual_completion']);
  await handleDesktopExtensionActionPacket({
    type:'desktop_extension_action',request_id:requestId,
    action:'unrecognized_action',
  },port,async()=>{throw Error('must not dispatch');});
  assert.equal(posted.at(-1).ok,false);
  assert.match(posted.at(-1).error,/Unsupported desktop action/);
  await handleDesktopExtensionActionPacket({
    type:'desktop_extension_action',request_id:requestId,action:'set_manual_completion',
  },port,async()=>{throw Error('Explicitly rejected');});
  assert.equal(posted.at(-1).ok,false,'executed IPC errors must be returned, not time out');
  assert.match(posted.at(-1).error,/Explicitly rejected/);
  let ws;
  t.after(async()=>{
    ws?.terminate();
    await stopServer();
    fs.rmSync(profile,{recursive:true,force:true});
  });
  const server=await startServer();
  const browser=randomUUID(),task=randomUUID(),calls=[];
  ws=new WebSocket('ws://127.0.0.1:'+server.port+'/bridge');
  const connected=new Promise((resolve,reject)=>{
    ws.on('message',raw=>{
      const packet=JSON.parse(String(raw));
      if(packet.type==='session_registered'){
        ws.send(JSON.stringify({type:'session_ready'}));
        resolve();
      }
      if(packet.type!=='call')return;
      const params=packet.params||{};
      calls.push({method:packet.method,params});
      const result=packet.method==='desktop_completion_status'
        ? [{task_id:task,status:'running',manual_required:true}]
        : packet.method==='desktop_set_manual_completion'
          ? {task_id:params.task_id,status:params.status==='completed'?'done':'running'}
          : [];
      ws.send(JSON.stringify({type:'result',id:packet.id,ok:true,result}));
    });
    ws.on('error',reject);
    ws.on('open',()=>ws.send(JSON.stringify({
      type:'register_session',browser_session_id:browser,connection_generation:1,
      profile_token:token,profile_install_id:randomUUID(),browser_product:'edge',
      extension_version:'0.1.3'})));
  });
  await connected;
  const status=await desktopAction({action:'list_completion_monitors',browser_session_id:browser});
  assert.equal(status[0].task_id,task);
  for(const choice of ['in_progress','completed']){
    const result=await desktopAction({action:'set_manual_completion',
      browser_session_id:browser,decision_id:task,choice});
    assert.equal(result.task_id,task);
    assert.equal(result.status,choice==='completed'?'done':'running');
  }
  const callsForDecision=calls.filter(x=>x.method==='desktop_set_manual_completion');
  assert.deepEqual(callsForDecision.map(x=>x.params.status),['in_progress','completed']);
  assert.ok(callsForDecision.every(x=>x.params.task_id===task &&
    x.params.__sessionBrowserId===browser && x.params.__trustedDesktopConsent===true));
});
