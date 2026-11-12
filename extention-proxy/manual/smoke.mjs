import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';

const standard = process.argv.includes('--standard');
const server = fork(new URL('./server.mjs',import.meta.url),standard ? ['--standard'] : [],{env:{...process.env,MANUAL_TEST_PORT:'0'}});
const signal = AbortSignal.timeout(20000);
let socket;
try {
  const [{url}] = await once(server,'message',{signal});
  const post = (route,body) => fetch(url+route,{method:'POST',signal,headers:{
    'Content-Type':'application/json', Accept:'application/json, text/event-stream'},body:JSON.stringify(body)});
  async function rpc(method,params) {
    const raw = await (await post('/mcp',{jsonrpc:'2.0',id:1,method,params})).text();
    return JSON.parse(raw.split('\n').find(line=>line.startsWith('data:')).slice(5)).result;
  }
  assert.match(await (await fetch(url)).text(),/Extension workbench/);
  assert.equal((await rpc('tools/list',{})).tools.length,standard ? 7 : 18);
  const list = () => rpc('tools/call',{name:'list_tabs',arguments:{}});
  assert.equal((await list()).isError,true);
  const session = randomUUID();
  async function connect(generation) {
    socket = new WebSocket(url.replace('http:','ws:')+'/bridge');
    await once(socket,'open',{signal});
    const registered = once(socket,'message',{signal});
    socket.send(JSON.stringify({type:'register_session',browser_session_id:session,connection_generation:generation}));
    assert.equal(JSON.parse((await registered)[0]).type,'session_registered');
    socket.on('message',raw=>{
      const msg=JSON.parse(raw);
      if(msg.type==='call') socket.send(JSON.stringify({type:'result',id:msg.id,ok:true,result:[{tab_id:42}]}));
    });
    socket.send(JSON.stringify({type:'session_ready'}));
  }
  await connect(1);
  assert.deepEqual(JSON.parse((await list()).content[0].text),[{tab_id:42,browser_session_id:session}]);
  const dashboard = await fetch(url+'/manual/dashboard').then(res=>res.json());
  assert.equal(dashboard.extensionConnected,true);
  assert.equal(dashboard.storageReady,!standard);
  const settings = await fetch(url+'/manual/settings').then(res=>res.json());
  const applied = await (await post('/manual/settings',{...settings,enabled:false})).json();
  assert.equal(applied.settings.enabled,false);
  assert.equal((await post('/manual/desktop',{action:'unknown'})).status,400);
  const closed = once(socket,'close',{signal});
  await post('/manual/network',{mode:'offline'});
  await closed;
  assert.equal((await list()).isError,true);
  await post('/manual/network',{mode:'online'});
  await connect(2);
  assert.equal((await fetch(url+'/health').then(r=>r.json())).extensionConnected,true);
  const stream=await fetch(url+'/events',{signal});
  const reader=stream.body.getReader();
  let logs='';
  while(!logs.includes('WS → extension') || !logs.includes('WS ← extension')) logs+=new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.deepEqual(await (await post('/manual/clear',{})).json(),{cleared:true});
  assert.equal((await fetch(url+'/manual/settings',{headers:{Origin:'https://example.org'}})).status,403);
  console.log('PASS catalog, disconnected error, handshake, tab discovery, network controls, reconnect and raw frames');
} finally {
  socket?.terminate();
  if(server.connected) server.disconnect();
}
