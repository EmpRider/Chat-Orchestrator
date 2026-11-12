// Manual Windows packaged smoke: isolated temporary profile, tokenless local settings handshake.
// Never touches the live default profile, its Ngrok auth, or port 8787.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import WebSocket from 'ws';

if (process.platform !== 'win32') throw new Error('Windows portable smoke only');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const currentVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const executable = process.env.CHAT_ORCH_PACKAGED_EXE || path.join(root, 'dist', 'Chat Orchestrator ' + currentVersion + '.exe');
if (!existsSync(executable)) throw new Error('Build portable EXE before running packaged smoke');
const dataDir = mkdtempSync(path.join(tmpdir(), 'chat-orchestrator-smoke-settings-'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listener = net.createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
assert.ok(port > 1024 && port !== 8787);
const env = {...process.env, CHAT_ORCH_PACKAGED_SMOKE: '1', CHAT_ORCH_E2E_MODE:'1',
  CHAT_ORCH_E2E_DATA_DIR: dataDir, CHAT_ORCH_E2E_PORT: String(port),
  CHAT_ORCH_PACKAGED_SMOKE_EXIT_MS:'22000', CHAT_ORCH_DIAGNOSTICS:'1'};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [], {env, stdio:'ignore', windowsHide:true});
let ws;
try {
  let active = false;
  for(let i=0;i<100;i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if(res.ok) {active=true;break;}
    } catch {}
    await delay(350);
  }
  assert.ok(active, 'Packaged isolated proxy must listen on test port');
  assert.ok(!existsSync(path.join(dataDir,'extension-bridge.token')),
    'Packaged proxy must not create an obsolete extension credential');
  ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  const snapshot = new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Settings snapshot timed out')),8000);
    ws.on('message',(raw)=>{
      const msg=JSON.parse(String(raw));
      if(msg.type==='session_registered') ws.send(JSON.stringify({type:'session_ready'}));
      if(msg.type==='settings_snapshot') {clearTimeout(timer);resolve(msg);}
    });
    ws.once('error',reject);
  });
  await once(ws,'open');
  ws.send(JSON.stringify({type:'register_session',browser_session_id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    connection_generation:1}));
  const msg = await snapshot;
  assert.equal(msg.schema,1);
  assert.ok(msg.revision>0);
  assert.ok(msg.settings.promptModules.core.length>10);
  assert.ok(msg.settings.promptModules.queue.length>10);
  ws.send(JSON.stringify({type:'settings_applied',revision:msg.revision}));
  ws.close();
  let stopped=false;
  for(let i=0;i<90;i++) {
    await delay(350);
    try { await fetch(`http://127.0.0.1:${port}/health`); }
    catch {stopped=true;break;}
  }
  assert.ok(stopped,'Packaged smoke must auto-stop its isolated port');
  console.log('PACKAGED_SETTINGS_SMOKE_PASS port='+port+' revision='+msg.revision);
} finally {
  try {ws?.terminate();} catch {}
  // EXE launcher might exit before Electron; the bounded smoke timer owns shutdown.
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([once(child, 'exit').catch(() => {}), delay(3000)]);
  }
  // Windows antivirus and Electron child shutdown may briefly hold the isolated temp profile.
  rmSync(dataDir, {recursive:true, force:true, maxRetries:20, retryDelay:250});
}
