import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer as createNetServer} from 'node:net';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';
const transportKey='a'.repeat(64);

async function vacantPort() {
  const server=createNetServer();
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  await new Promise((resolve)=>server.close(resolve));
  return port;
}
async function socketConnect(url) {
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(url);
    ws.once('open',()=>resolve(ws));
    ws.once('error',reject);
  });
}

test('desktop ngrok upstream serves MCP but cannot expose local extension bridge', {timeout:18000},async(t)=>{
  const publicPort=await vacantPort();
  const child=spawn(process.execPath,['server.js'],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),
    env:{...process.env,HOST:'127.0.0.1',PORT:'0',
      CHAT_ORCH_PUBLIC_PORT:String(publicPort),CHAT_ORCH_PUBLIC_MCP_TOKEN:transportKey,
      CHAT_ORCH_PRIVATE_COORDINATION:'0'},
    stdio:['ignore','pipe','pipe'],
  });
  let client,agentClient,privateSocket;
  t.after(async()=>{
    await client?.close().catch(()=>{});
    await agentClient?.close().catch(()=>{});
    if (privateSocket?.readyState===WebSocket.OPEN) {
      await new Promise((resolve)=>{
        const timer=setTimeout(resolve,800);
        privateSocket.once('close',()=>{clearTimeout(timer);resolve();});
        privateSocket.close(1000,'test finished');
      });
    }
    if (child.exitCode===null && child.signalCode===null) {
      const stopped=new Promise((resolve)=>child.once('exit',resolve));
      child.kill();
      await Promise.race([stopped,new Promise((resolve)=>setTimeout(resolve,1200))]);
    }
  });
  const bridgePort=await new Promise((resolve,reject)=>{
    let output='';
    const timer=setTimeout(()=>reject(Error('Proxy did not start: '+output)),8000);
    child.stdout.on('data',(buf)=>{
      output+=buf.toString();
      const match=/listening on http:\/\/[^:]+:(\d+)/.exec(output);
      if(match){clearTimeout(timer);resolve(Number(match[1]));}
    });
    child.stderr.on('data',(buf)=>{output+=buf.toString();});
    child.once('exit',(code)=>{clearTimeout(timer);reject(Error('Proxy exited '+code+': '+output));});
  });
  assert.notEqual(bridgePort,publicPort);
  const anonymous=await fetch('http://127.0.0.1:'+publicPort+'/mcp',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}})});
  assert.equal(anonymous.status,401,'public MCP must not accept anonymous connections');
  const incorrect=await fetch('http://127.0.0.1:'+publicPort+'/mcp',{
    method:'POST',headers:{'Content-Type':'application/json',
      Authorization:'Bearer '+'b'.repeat(64)},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}})});
  assert.equal(incorrect.status,401);
  const postJson={method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}})};
  const base='http://127.0.0.1:'+publicPort;
  for(const path of [
    '/mcp/agent',
    '/mcp/agent?token='+transportKey,
    '/mcp/agent/'+'b'.repeat(64),
    '/mcp/agent/'+'x'.repeat(64),
    '/mcp/agent/'+transportKey+'/',
    '/mcp/agent/'+transportKey+'?token='+transportKey,
    '/mcp/agent/'+transportKey+'?extra=1',
  ]){
    const response=await fetch(base+path,postJson);
    assert.equal(response.status,401,'invalid URL token must be rejected: '+
      path.replace(/[a-f0-9]{64}/gi,'[hidden]'));
    assert.equal(response.headers.get('Cache-Control'),'no-store');
    assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');
    assert.equal(response.headers.get('WWW-Authenticate'),null,
      'No-auth client must not be challenged to provide an unavailable Bearer header');
    assert.doesNotMatch(await response.text(),new RegExp(transportKey));
  }
  const legacyQuery=await fetch(base+'/mcp?token='+transportKey,postJson);
  assert.equal(legacyQuery.status,401,'legacy /mcp must require the Bearer header, not URL tokens');
  const noUrlToken=await fetch(base+'/mcp/agent',{
    ...postJson,headers:{...postJson.headers,Authorization:'Bearer '+transportKey},
  });
  assert.equal(noUrlToken.status,401,'agent URL endpoint must not silently fall back to Bearer');
  const withTokenGet=await fetch(base+'/mcp/agent/'+transportKey);
  assert.equal(withTokenGet.status,405,'stateless Streamable HTTP transport remains POST-only');
  const withoutTokenGet=await fetch(base+'/mcp/agent');
  assert.equal(withoutTokenGet.status,401);
  for(const inaccessible of ['/mcp/agent/debug?token='+transportKey,
    '/bridge?token='+transportKey,'/admin?token='+transportKey]){
    const response=await fetch(base+inaccessible);
    assert.equal(response.status,inaccessible.startsWith('/mcp/agent/')?401:404,
      'URL token never grants access to other paths');
  }
  const health=await fetch('http://127.0.0.1:'+publicPort+'/health');
  assert.equal(health.ok,true);
  for(const forbidden of ['/oauth/authorize','/oauth/token',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource']){
    const response=await fetch('http://127.0.0.1:'+publicPort+forbidden);
    assert.equal(response.status,404,
      'Static Bearer-only MCP must not expose OAuth routes: '+forbidden);
  }
  const rejectUpgrade=await new Promise((resolve,reject)=>{
    const request=http.request({
      hostname:'127.0.0.1',port:publicPort,path:'/bridge',
      headers:{Connection:'Upgrade',Upgrade:'websocket',
        'Sec-WebSocket-Version':'13',
        'Sec-WebSocket-Key':'dGhlIHNhbXBsZSBub25jZQ=='},
    },(response)=>{response.resume();resolve(response.statusCode);});
    request.once('upgrade',(_response,socket)=>{
      socket.destroy();
      reject(Error('PUBLIC /bridge unexpectedly accepted websocket'));
    });
    request.once('error',reject);
    request.end();
  });
  assert.ok([404,426].includes(rejectUpgrade));
  privateSocket=await socketConnect('ws://127.0.0.1:'+bridgePort+'/bridge');
  client=new Client({name:'public-port-isolation-test',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(
    new URL('http://127.0.0.1:'+publicPort+'/mcp'),{
      requestInit:{headers:{Authorization:'Bearer '+transportKey}},
    }));
  const tools=(await client.listTools()).tools;
  assert.ok(tools.some((tool)=>tool.name==='pair_conversation'));
  // Simulate the ChatGPT custom-MCP form: the URL is the only credential, and
  // the client never supplies Authorization or a custom request header.
  agentClient=new Client({name:'url-token-mcp-test',version:'1.0.0'});
  await agentClient.connect(new StreamableHTTPClientTransport(
    new URL(base+'/mcp/agent/'+transportKey)));
  const urlTools=(await agentClient.listTools()).tools;
  assert.ok(urlTools.some((tool)=>tool.name==='pair_conversation'));
  assert.ok(urlTools.some((tool)=>tool.name==='spawn_worker'));
});

test('occupied public port fails startup instead of exposing a half-started bridge', {timeout:12000},async(t)=>{
  const blocker=createNetServer();
  await new Promise((resolve,reject)=>blocker.once('error',reject)
    .listen(0,'127.0.0.1',resolve));
  t.after(()=>blocker.close());
  const publicPort=blocker.address().port;
  const child=spawn(process.execPath,['server.js'],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),
    env:{...process.env,PORT:'0',HOST:'127.0.0.1',
      CHAT_ORCH_PUBLIC_PORT:String(publicPort),CHAT_ORCH_PUBLIC_MCP_TOKEN:transportKey,
      CHAT_ORCH_PRIVATE_COORDINATION:'0'},
    stdio:['ignore','pipe','pipe'],
  });
  t.after(()=>child.kill());
  let output='';
  child.stdout.on('data',(buf)=>{output+=buf.toString();});
  child.stderr.on('data',(buf)=>{output+=buf.toString();});
  const code=await Promise.race([
    new Promise((resolve)=>child.once('exit',(exitCode)=>resolve(exitCode))),
    new Promise((_resolve,reject)=>setTimeout(()=>reject(new Error('Startup did not fail closed')),7000)),
  ]);
  assert.notEqual(code,0,'public HTTP port bind error must prevent successful startup');
  assert.doesNotMatch(output,/MCP server listening on http:/,
    'do not advertise local extension bridge until the public upstream is ready');
});
