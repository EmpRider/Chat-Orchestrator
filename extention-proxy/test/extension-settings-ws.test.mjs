import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('local extension WebSocket needs no token; settings flow from proxy only', { timeout: 20000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chat-orch-settings-'));
  const file = path.join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify({ agentSettings: { enabled: true, promptSchema: 2,
    promptModules: { queue: 'Private queue processing instructions' } } }));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', CHAT_ORCH_PROFILE_DIR: dir,
      CHAT_ORCH_PRIVATE_COORDINATION: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ws;
  t.after(() => { ws?.terminate(); server.kill(); rmSync(dir, { recursive: true, force: true }); });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Proxy start timeout: ' + output)), 8000);
    server.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const found = /listening on http:\/\/[^:]+:(\d+)/.exec(output);
      if (found) { clearTimeout(timer); resolve(Number(found[1])); }
    });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('Proxy exited: ' + code)); });
  });
  ws = new WebSocket('ws://127.0.0.1:' + port + '/bridge');
  const messages = [];
  ws.on('message', (buf) => { try { messages.push(JSON.parse(buf.toString())); } catch {} });
  await once(ws, 'open');
  ws.send(JSON.stringify({type:'register_session',browser_session_id:'11111111-1111-4111-8111-111111111111',
    connection_generation:1,proxy_session_id:'test-proxy-session'}));
  ws.send(JSON.stringify({type:'session_ready'}));
  await delay(160);
  const snapshot = messages.find((m) => m.type === 'settings_snapshot');
  assert.ok(snapshot, 'extension receives proxy-owned settings without a token');
  assert.equal(snapshot.settings.promptModules.queue, 'Private queue processing instructions');
  ws.send(JSON.stringify({ type: 'settings_snapshot', schema: 1, revision: 333,
    settings: { enabled: false, promptSchema: 2, promptModules: { queue: 'Attempted overwrite' } } }));
  await delay(100);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).agentSettings.promptModules.queue,
    'Private queue processing instructions', 'extension WebSocket must not overwrite desktop-owned settings');
});

test('runtime journal profile does not replace saved agent settings', { timeout: 20000 }, async (t) => {
  const runtime = mkdtempSync(path.join(tmpdir(), 'chat-orch-runtime-'));
  const saved = mkdtempSync(path.join(tmpdir(), 'chat-orch-saved-settings-'));
  const file = path.join(saved, 'settings.json');
  writeFileSync(file, JSON.stringify({agentSettings:{enabled:false}}));
  const server = spawn(process.execPath, ['server.js'], {
    cwd:root, env:{...process.env,PORT:'0',HOST:'127.0.0.1',
      CHAT_ORCH_PROFILE_DIR:runtime,CHAT_ORCH_SETTINGS_DIR:saved,CHAT_ORCH_PRIVATE_COORDINATION:'0'},
    stdio:['ignore','pipe','pipe'],
  });
  let ws;
  t.after(() => {
    ws?.terminate();server.kill();
    rmSync(runtime,{recursive:true,force:true});rmSync(saved,{recursive:true,force:true});
  });
  const port = await new Promise((resolve,reject) => {
    let output='';
    const timer=setTimeout(()=>reject(new Error('Proxy start timeout: '+output)),8000);
    server.stdout.on('data',(chunk)=>{
      output+=chunk.toString();
      const found=/listening on http:\/\/[^:]+:(\d+)/.exec(output);
      if(found){clearTimeout(timer);resolve(Number(found[1]));}
    });
    server.once('exit',(code)=>{clearTimeout(timer);reject(new Error('Proxy exited: '+code));});
  });
  ws=new WebSocket('ws://127.0.0.1:'+port+'/bridge');
  const messages=[];
  ws.on('message',(buf)=>{try{messages.push(JSON.parse(buf.toString()));}catch{}});
  await once(ws,'open');
  ws.send(JSON.stringify({type:'register_session',browser_session_id:'22222222-2222-4222-8222-222222222222',
    connection_generation:1,proxy_session_id:'test-proxy-session'}));
  ws.send(JSON.stringify({type:'session_ready'}));
  await delay(100);
  assert.equal(messages.find((m)=>m.type==='settings_snapshot')?.settings.enabled,false);
  const registered=messages.find((m)=>m.type==='session_registered');
  assert.match(registered?.proxy_session_id,/^[0-9a-f-]{36}$/i);
  assert.equal(JSON.parse(readFileSync(file,'utf8')).agentSettings.enabled,false);

  const browserB = '33333333-3333-4333-8333-333333333333';
  const wsB = new WebSocket('ws://127.0.0.1:'+port+'/bridge');
  const messagesB=[];
  wsB.on('message',(buf)=>{try{messagesB.push(JSON.parse(buf.toString()));}catch{}});
  await once(wsB,'open');
  wsB.send(JSON.stringify({type:'register_session',browser_session_id:browserB,
    connection_generation:1,proxy_session_id:registered.proxy_session_id}));
  wsB.send(JSON.stringify({type:'session_ready'}));
  await delay(100);
  assert.ok(messagesB.some((m)=>m.type==='settings_snapshot'),
    'second browser profile keeps a simultaneous extension socket');
  ws.terminate();
  await delay(50);
  wsB.send(JSON.stringify({type:'session_heartbeat',nonce:'multi-session-check'}));
  await delay(50);
  assert.ok(messagesB.some((m)=>m.type==='session_heartbeat_ack'&&m.nonce==='multi-session-check'),
    'closing the first browser socket does not replace the second');
  wsB.terminate();
});

test('multiple browser sessions stay independent and reject unknown session routing', {timeout:20000}, async(t)=>{
  const dir=mkdtempSync(path.join(tmpdir(),'chat-orch-multi-session-'));
  const server=spawn(process.execPath,['server.js'],{
    cwd:root,env:{...process.env,PORT:'0',HOST:'127.0.0.1',
      CHAT_ORCH_PROFILE_DIR:dir,CHAT_ORCH_PRIVATE_COORDINATION:'0'},
    stdio:['ignore','pipe','pipe'],
  });
  const sockets=[];
  const client=new Client({name:'multi-session-test',version:'1.0.0'});
  t.after(async()=>{
    await client.close().catch(()=>{});
    sockets.forEach((socket)=>socket.terminate());
    server.kill();rmSync(dir,{recursive:true,force:true});
  });
  const port=await new Promise((resolve,reject)=>{
    let output='';
    const timer=setTimeout(()=>reject(new Error('Proxy start timeout: '+output)),8000);
    server.stdout.on('data',(chunk)=>{
      output+=chunk.toString();
      const match=/listening on http:\/\/[^:]+:(\d+)/.exec(output);
      if(match){clearTimeout(timer);resolve(Number(match[1]));}
    });
    server.once('exit',(code)=>{clearTimeout(timer);reject(new Error('Proxy exited: '+code));});
  });
  const sessionA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const sessionB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const proxyUrl='ws://127.0.0.1:'+port+'/bridge';
  async function profile(session,tabId,proxySessionId){
    const socket=new WebSocket(proxyUrl);sockets.push(socket);
    const messages=[];
    socket.on('message',(raw)=>{
      const message=JSON.parse(raw.toString());messages.push(message);
      if(message.type==='call'){
        const result=message.method==='list_tabs'
          ? [{tab_id:tabId,site:'chatgpt',title:session}]
          : message.method==='read_chat' ? {profile:session}
          : {tab_id:tabId,site:'chatgpt',browser_session_id:session,
            incarnation_id:session,is_managed_worker:false,connection_generation:1};
        socket.send(JSON.stringify({type:'result',id:message.id,ok:true,result}));
      }
    });
    await once(socket,'open');
    socket.send(JSON.stringify({type:'register_session',browser_session_id:session,
      connection_generation:1,proxy_session_id:proxySessionId}));
    const deadline=Date.now()+3000;
    while(!messages.some((message)=>message.type==='session_registered')){
      if(Date.now()>deadline)throw new Error('Session registration timed out');
      await delay(10);
    }
    return {socket,messages,session:messages.find((message)=>message.type==='session_registered').proxy_session_id};
  }
  const first=await profile(sessionA,101,null);
  const second=await profile(sessionB,202,'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  assert.equal(second.messages.some((message)=>message.type==='settings_snapshot'),false,
    'stale session must reset before receiving settings');
  second.socket.send(JSON.stringify({type:'session_ready'}));
  const readyDeadline=Date.now()+3000;
  while(!second.messages.some((message)=>message.type==='settings_snapshot')){
    if(Date.now()>readyDeadline)throw new Error('Second profile settings timed out');
    await delay(10);
  }
  assert.equal(first.socket.readyState,WebSocket.OPEN,'stale second profile cannot disconnect first');
  assert.equal(second.socket.readyState,WebSocket.OPEN);
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+port+'/mcp')));
  async function list(args={}){
    const response=await client.callTool({name:'list_tabs',arguments:args});
    return response.isError ? {error:response.content[0].text} : JSON.parse(response.content[0].text);
  }
  assert.deepEqual((await list()).map((tab)=>[tab.browser_session_id,tab.tab_id]),
    [[sessionA,101],[sessionB,202]]);
  assert.deepEqual((await list({browser_session_id:sessionA})).map((tab)=>tab.tab_id),[101]);
  assert.deepEqual((await list({browser_session_id:sessionB})).map((tab)=>tab.tab_id),[202]);
  const routed=await client.callTool({name:'read_chat',arguments:{caller_tab_id:202,
    browser_session_id:sessionB,tab_id:202}});
  assert.equal(routed.isError,undefined);
  assert.equal(JSON.parse(routed.content[0].text).profile,sessionB);
  const ambiguous=await client.callTool({name:'read_chat',arguments:{caller_tab_id:202,tab_id:101}});
  assert.equal(ambiguous.isError,true,'target tab must not select the caller browser profile');
  assert.match((await list({browser_session_id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'})).error,
    /Selected browser session is disconnected or unknown/);
  assert.equal(first.socket.readyState,WebSocket.OPEN);
  assert.equal(second.socket.readyState,WebSocket.OPEN);
});
