import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';

const token='c'.repeat(64);
async function freePort(){
  const probe=net.createServer();
  await new Promise((resolve,reject)=>probe.once('error',reject).listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;
  await new Promise((resolve)=>probe.close(resolve));
  return port;
}
test('verified extension enrollment gates dangerous browser-wide Close action', {timeout:15000},async(t)=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'chat-orch-enrollment-test-'));
  const port=await freePort();
  Object.assign(process.env,{PORT:String(port),HOST:'127.0.0.1',
    CHAT_ORCH_PROFILE_DIR:directory,CHAT_ORCH_SETTINGS_DIR:directory,
    CHAT_ORCH_PRIVATE_COORDINATION:'0',CHAT_ORCH_EXTENSION_PROFILE_TOKEN:token});
  delete process.env.CHAT_ORCH_PUBLIC_PORT;
  const {startServer,stopServer,desktopAction}=await import('../server.js');
  let socket;
  t.after(async()=>{
    socket?.terminate();
    await stopServer();
    fs.rmSync(directory,{recursive:true,force:true});
  });
  await startServer();
  const browserSession=randomUUID();
  const installation=randomUUID();
  const received=[];
  socket=new WebSocket('ws://127.0.0.1:'+port+'/bridge');
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Handshake timed out')),5000);
    socket.on('message',(raw)=>{
      const msg=JSON.parse(raw.toString());
      if(msg.type==='session_registered'){
        clearTimeout(timeout);
        socket.send(JSON.stringify({type:'session_ready'}));
        resolve();
      }else if(msg.type==='call'){
        received.push(msg);
        let result=[];
        if(msg.method==='desktop_verify_managed_browser')
          result={browser_session_id:browserSession,profile_install_id:installation};
        if(msg.method==='desktop_close_managed_browser')
          result={scheduled:true,windows:1};
        if(msg.method==='desktop_update_readiness')
          result={ready:false,blockers:['Active Child task'],checked_at:Date.now()};
        socket.send(JSON.stringify({type:'result',id:msg.id,ok:true,result}));
      }
    });
    socket.on('error',reject);
    socket.on('open',()=>socket.send(JSON.stringify({
      type:'register_session',browser_session_id:browserSession,
      connection_generation:1,profile_token:token,profile_install_id:installation,
      browser_product:'edge',extension_version:'0.1.3',
    })));
  });
  const verified=await desktopAction({action:'verify_managed_browser'});
  assert.equal(verified.profile_install_id,installation);
  assert.equal(verified.browser_product,'edge');
  assert.equal(verified.extension_version,'0.1.3');
  await assert.rejects(desktopAction({action:'close_managed_browser'}),/mismatch/);
  await assert.rejects(desktopAction({action:'close_managed_browser',
    expected_profile_install_id:randomUUID(),expected_browser_product:'edge'}),/mismatch/);
  await assert.rejects(desktopAction({action:'close_managed_browser',
    expected_profile_install_id:installation,expected_browser_product:'chrome'}),/mismatch/);
  assert.equal(received.filter((call)=>call.method==='desktop_close_managed_browser').length,0,
    'invalid enrollment never reaches the extension closing primitive');
  const close=await desktopAction({action:'close_managed_browser',
    expected_profile_install_id:installation,expected_browser_product:'edge'});
  assert.equal(close.scheduled,true);
  assert.equal(received.at(-1).params.expected_profile_install_id,installation);
  const update=await desktopAction({action:'update_readiness'});
  assert.equal(update.ready,false);
});
