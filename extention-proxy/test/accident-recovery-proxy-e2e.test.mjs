// Local transport integration: real Proxy Desktop action / WebSocket /
// session tab registry. The extension/browser is a deterministic fixture.
// Never accesses the user's actual Chrome/Edge tabs or ChatGPT account.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';

const wait=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
async function availablePort(){
  const probe=net.createServer();
  await new Promise((resolve,reject)=>probe.once('error',reject)
    .listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;
  await new Promise((resolve)=>probe.close(resolve));
  return port;
}

test('D-021 Proxy Accident restores nested tabs via WebSocket and resumes without duplicate browser creations',{
  timeout:25000,
},async(t)=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'chat-orch-accident-integration-'));
  const port=await availablePort();
  const token='a'.repeat(64);
  Object.assign(process.env,{
    PORT:String(port),HOST:'127.0.0.1',
    CHAT_ORCH_PROFILE_DIR:profile,CHAT_ORCH_SETTINGS_DIR:profile,
    CHAT_ORCH_PRIVATE_COORDINATION:'0',
    CHAT_ORCH_EXTENSION_PROFILE_TOKEN:token,
  });
  delete process.env.CHAT_ORCH_PUBLIC_PORT;
  const {startServer,stopServer,desktopAction}=await import('../server.js');
  let socket;
  t.after(async()=>{
    socket?.terminate();
    await stopServer();
    fs.rmSync(profile,{recursive:true,force:true});
  });
  await startServer();
  const browserSession=randomUUID();
  const original={parent:101,child:201,grandchild:301};
  const parentUrl='https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
  const childUrl='https://chatgpt.com/c/22222222-2222-4222-8222-222222222222';
  const grandUrl='https://chatgpt.com/c/33333333-3333-4333-8333-333333333333';
  const closed={
    id:randomUUID(),browserSessionId:browserSession,kind:'parent',
    oldTabId:original.parent,incarnationId:randomUUID(),parentTabId:null,
    url:parentUrl,title:'Original Parent',status:'pending',
    createdAt:Date.now()-10000,descendants:[
      {tabId:201,parentTabId:101,incarnationId:randomUUID(),
        site:'chatgpt',lastUrl:childUrl,title:'Child'},
      {tabId:301,parentTabId:201,incarnationId:randomUUID(),
        site:'chatgpt',lastUrl:grandUrl,title:'Grandchild'},
    ],restoredDescendants:{},
  };
  const tabs=new Map();
  let nextTab=401;
  const creationCounts=new Map();
  let interruptGrandchildOnce=true;
  const requested=[];
  const handle=(method,p)=>{
    requested.push(method);
    switch(method){
      case 'inspect_all_tabs':
        return [...tabs.values()].map((tab)=>({...tab}));
      case 'desktop_list_agent_closures':
        return closed.status==='resolved'?[]:[{...closed}];
      case 'desktop_prepare_accident_restore':{
        assert.equal(closed.status,'pending');
        const id=nextTab++;
        tabs.set(id,{tab_id:id,site:'chatgpt',incarnation_id:randomUUID(),
          browser_session_id:browserSession,parent_approved:true,
          is_managed_worker:false,url:parentUrl});
        closed.candidateTabId=id;
        closed.candidateIncarnationId=tabs.get(id).incarnation_id;
        closed.status='restoring';
        creationCounts.set('parent',(creationCounts.get('parent')||0)+1);
        return {candidate_tab_id:id,new_incarnation_id:closed.candidateIncarnationId};
      }
      case 'inspect_tab': {
        if(!tabs.has(p.tab_id))throw new Error('Expected live tab not found');
        return {...tabs.get(p.tab_id)};
      }
      case 'desktop_commit_accident_restore':
        assert.equal(closed.status,'restoring');
        assert.equal(p.new_tab_id,closed.candidateTabId);
        closed.status='restoring_children';
        return {restored:true,descendant_restoration_pending:true,no_task_replay:true};
      case 'desktop_restore_closure_descendant': {
        assert.equal(closed.status,'restoring_children');
        assert.equal(p.decision_id,closed.id);
        const entry=closed.descendants.find((item)=>item.tabId===p.old_tab_id);
        assert.ok(entry);
        assert.equal(p.old_parent_tab_id,entry.parentTabId);
        const verifiedParent=tabs.get(p.new_parent_tab_id);
        assert.ok(verifiedParent);
        assert.equal(p.expected_parent_incarnation,verifiedParent.incarnation_id);
        if(entry.tabId===301 && interruptGrandchildOnce){
          interruptGrandchildOnce=false;
          throw new Error('Fixture: temporary failure before Grandchild creation');
        }
        const previous=closed.restoredDescendants[entry.tabId];
        if(previous){
          assert.equal(previous.parentTabId,p.new_parent_tab_id);
          return {old_tab_id:entry.tabId,tab_id:previous.tabId,
            incarnation_id:previous.incarnationId,created:false,reused:true,
            no_task_replay:true};
        }
        const id=nextTab++;
        const incarnation=randomUUID();
        tabs.set(id,{tab_id:id,site:'chatgpt',incarnation_id:incarnation,
          browser_session_id:browserSession,parent_approved:false,
          is_managed_worker:true,url:entry.lastUrl,owner:p.new_parent_owner});
        closed.restoredDescendants[entry.tabId]={
          tabId:id,incarnationId:incarnation,parentTabId:p.new_parent_tab_id,
        };
        creationCounts.set(entry.tabId,(creationCounts.get(entry.tabId)||0)+1);
        return {old_tab_id:entry.tabId,tab_id:id,
          incarnation_id:incarnation,created:true,reused:false,no_task_replay:true};
      }
      case 'desktop_finalize_accident_restore':
        if(Object.keys(closed.restoredDescendants).length!==2)
          throw new Error('Incomplete descendant restoration');
        closed.status='resolved';
        return {restored:true,descendants_verified:2,no_task_replay:true};
      case 'recover_owned_children':
        return [...tabs.values()].filter((tab)=>
          tab.is_managed_worker && tab.owner===p.owner_credential);
      default:throw new Error('Unexpected extension operation: '+method);
    }
  };
  socket=new WebSocket('ws://127.0.0.1:'+port+'/bridge');
  const handshake=new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Handshake not accepted')),5000);
    socket.on('message',(raw)=>{
      const message=JSON.parse(raw.toString());
      if(message.type==='session_registered'){
        clearTimeout(timeout);
        socket.send(JSON.stringify({type:'session_ready'}));
        resolve();
      }
      if(message.type==='call'){
        Promise.resolve().then(()=>handle(message.method,message.params))
          .then((result)=>socket.send(JSON.stringify({
            type:'result',id:message.id,ok:true,result,
          })))
          .catch((error)=>socket.send(JSON.stringify({
            type:'result',id:message.id,ok:false,error:error.message,
          })));
      }
    });
    socket.once('open',()=>socket.send(JSON.stringify({
      type:'register_session',browser_session_id:browserSession,
      connection_generation:1,profile_token:token,
    })));
    socket.once('error',reject);
  });
  await handshake;
  await wait(50); // Let Proxy's read-only initial inventory reconciliation finish.
  const args={action:'resolve_agent_closure',decision_id:closed.id,choice:'accident'};
  await assert.rejects(desktopAction(args),/temporary failure before Grandchild creation/);
  assert.equal(closed.status,'restoring_children');
  assert.equal(creationCounts.get('parent'),1);
  assert.equal(creationCounts.get(201),1);
  assert.equal(creationCounts.get(301),undefined);
  const finished=await desktopAction(args);
  assert.equal(finished.restoration_complete,true);
  assert.equal(finished.descendants_verified,2);
  assert.equal(finished.no_task_replay,true);
  assert.equal(closed.status,'resolved');
  assert.equal(creationCounts.get('parent'),1,'resume must reuse first Parent tab');
  assert.equal(creationCounts.get(201),1,'resume must reuse first Child tab');
  assert.equal(creationCounts.get(301),1);
  assert.equal(tabs.size,3);
  assert.equal(closed.restoredDescendants[301].parentTabId,
    closed.restoredDescendants[201].tabId);
  assert.ok(requested.includes('desktop_finalize_accident_restore'));
});
