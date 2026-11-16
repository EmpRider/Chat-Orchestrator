import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import WebSocket from 'ws';

const dir=fileURLToPath(new URL('..',import.meta.url));
const token='a'.repeat(64);
const session='11111111-1111-4111-8111-111111111111';

async function attempt(port,key) {
  const ws=new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Session handshake timed out')),4000);
    ws.once('open',()=>ws.send(JSON.stringify({
      type:'register_session',browser_session_id:session,
      connection_generation:1,proxy_session_id:null,
      ...(key==null?{}:{profile_token:key}),
    })));
    ws.on('message',(raw)=>{
      const message=JSON.parse(raw.toString());
      if(message.type==='session_registered') {
        clearTimeout(timeout);ws.close();resolve({accepted:true,code:null});
      }
    });
    ws.once('close',(code)=>{
      clearTimeout(timeout);
      resolve({accepted:false,code});
    });
    ws.once('error',(error)=>{clearTimeout(timeout);reject(error);});
  });
}

test('installed profile rejects missing or incorrect extension connection key', {timeout:15000},async(t)=>{
  const server=spawn(process.execPath,['server.js'],{
    cwd:dir,env:{...process.env,PORT:'0',HOST:'127.0.0.1',
      CHAT_ORCH_EXTENSION_PROFILE_TOKEN:token,CHAT_ORCH_PRIVATE_COORDINATION:'0'},
    stdio:['ignore','pipe','pipe'],
  });
  t.after(()=>server.kill());
  const port=await new Promise((resolve,reject)=>{
    let output='';
    const timer=setTimeout(()=>reject(Error('Proxy start timeout')),8000);
    server.stdout.on('data',(chunk)=>{
      output+=chunk.toString();
      const match=/listening on http:\/\/[^:]+:(\d+)/.exec(output);
      if(match){clearTimeout(timer);resolve(Number(match[1]));}
    });
    server.once('exit',(code)=>{clearTimeout(timer);reject(Error('Server exit '+code+': '+output));});
  });
  const noKey=await attempt(port,null);
  assert.equal(noKey.accepted,false);
  assert.equal(noKey.code,4002);
  const wrong=await attempt(port,'b'.repeat(64));
  assert.equal(wrong.accepted,false);
  assert.equal(wrong.code,4002);
  const correct=await attempt(port,token);
  assert.equal(correct.accepted,true);
});
