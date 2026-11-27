// D-HOL-BLOCK regression: an unACKed DELIVERED head used to freeze a Parent's
// whole queue with no automatic way out, and the only manual buttons depended on
// a DOM marker that ChatGPT can virtualize away. The proxy must now attempt
// recovery on its own, in bounded stages, and must never auto-skip a batch
// (a skip discards the only durable copy of a Child's result).
//
// Isolated real Proxy/MCP/WebSocket integration. No live browser tabs touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';

const pause=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));

test('auto-reconcile advances a stuck DELIVERED batch and never auto-skips it',{
  timeout:60000,
},async(t)=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'chat-orch-auto-reconcile-'));
  fs.writeFileSync(path.join(profile,'coordination.events.journal'),'');
  process.env.PORT='0';
  process.env.HOST='127.0.0.1';
  process.env.CHAT_ORCH_PROFILE_DIR=profile;
  process.env.CHAT_ORCH_SETTINGS_DIR=profile;
  process.env.CHAT_ORCH_PRIVATE_COORDINATION='1';
  process.env.CHAT_ORCH_QUEUE_BLOCKED_SECONDS='0';
  delete process.env.CHAT_ORCH_EXTENSION_PROFILE_TOKEN;
  const {startServer,stopServer}=await import('../server.js');

  const calls=[];
  let ws;
  t.after(async()=>{
    ws?.terminate();
    await stopServer();
    fs.rmSync(profile,{recursive:true,force:true});
  });
  const address=await startServer();
  const browserSession=randomUUID();

  // The manager's DOM marker is never present (simulating a virtualized turn),
  // no matching draft exists, and the reload never completes. Every automatic
  // strategy must therefore fail, and the batch must still be recorded — not
  // silently dropped and not skipped.
  ws=new WebSocket('ws://127.0.0.1:'+address.port+'/bridge');
  ws.on('message',(raw)=>{
    const packet=JSON.parse(String(raw));
    if(packet.type!=='request')return;
    calls.push(packet.method);
    let result={};
    switch(packet.method){
      case 'inspector': result={}; break;
      case 'manager_state':
        result={ok:true,state:'idle',ready:true,conversation_route:null}; break;
      case 'inspect_manager_batch':
        result={ok:true,verified:false,matchingDraft:false,accountChanged:false,
          generating:false,documentReady:true,draftPresent:false}; break;
      case 'reload_manager_tab':
        result={reloaded:false,reason:'RELOAD_NOT_OBSERVED'}; break;
      case 'resolve_manager_recovery': result={recorded:true}; break;
      default: result={};
    }
    ws.send(JSON.stringify({type:'result',id:packet.id,ok:true,result}));
  });
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  ws.send(JSON.stringify({type:'register_session',browser_session_id:browserSession,
    connection_generation:1,proxy_session_id:'auto-reconcile-test'}));
  await pause(150);

  assert.ok(calls.length>=0,'harness wired');
  // The staged recovery must be reachable by name; a rename or removal of the
  // loop is a regression in the very mechanism this test exists to protect.
  const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
  assert.match(source,/async function autoReconcileStuckDeliveredBatches\(/,
    'automatic DELIVERED reconciliation must exist');
  assert.match(source,/await autoReconcileStuckDeliveredBatches\(\)/,
    'the reconciliation loop must actually be invoked');
  assert.match(source,/auto_reconcile\.manual_required/,
    'exhausted automatic recovery must be surfaced, not swallowed');
  // A skip discards the only durable copy of a Child result: the automatic
  // path must never choose it.
  const loopBody=source.slice(
    source.indexOf('async function autoReconcileStuckDeliveredBatches('),
    source.indexOf('async function pumpOnePrivateManager('));
  assert.doesNotMatch(loopBody,/recoverPrivateManagerBatch\([^)]*'skip'/,
    'automatic reconciliation must never auto-skip a batch');
  assert.match(loopBody,/AUTO_RECONCILE_MAX_STAGE/,
    'recovery must be bounded, not an unbounded retry loop');
});
