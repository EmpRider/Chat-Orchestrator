import fs from 'node:fs';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {normalizeAgentSettings} from '../agent-settings.mjs';
import {preparePrivateJournal} from '../desktop/coordination-storage.mjs';

const port = Number(process.env.MANUAL_TEST_PORT || 8787);
const hosts = new Set();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-manual-'));
Object.assign(process.env, {PORT:String(port), HOST:'127.0.0.1', CHAT_ORCH_PROFILE_DIR:profile,
  CHAT_ORCH_SETTINGS_DIR:profile, CHAT_ORCH_PRIVATE_COORDINATION:process.argv.includes('--standard') ? '0' : '1'});
preparePrivateJournal(path.join(profile, 'coordination.events.journal'));
const {app, httpServer, wss, desktopAction, inspectDashboard, refreshExtensionSettings, startServer, stopServer} = await import('../server.js');

const clients = new Set();
const history = [];
let bytes = 0;
let online = true;
function record(kind, payload, ws) {
  const line = JSON.stringify({at:new Date().toISOString(), kind, session:ws?.browserSessionId, payload});
  history.push(line);
  bytes += line.length;
  while (history.length > 1 && (history.length > 500 || bytes > 2_000_000)) bytes -= history.shift().length;
  for (const res of clients) res.write('data: ' + line + '\n\n');
}
function status() {
  return {online, sessions:[...wss.clients].filter(ws => ws.readyState === 1 && ws.browserSessionId).map(ws => ws.browserSessionId)};
}
wss.prependListener('connection', ws => {
  record('WS open', {}, ws);
  const send = ws.send;
  ws.send = function(data, ...args) {
    const result = send.call(this, data, ...args);
    record('WS → extension', String(data), ws);
    return result;
  };
  ws.on('message', data => {
    record('WS ← extension', data.toString(), ws);
    if (!ws.browserSessionId) queueMicrotask(() => record('Connection', status()));
  });
  ws.on('error', err => record('WS error', err.message, ws));
  ws.on('close', (code, reason) => {
    record('WS close', {code,reason:reason.toString()}, ws);
    record('Connection', status());
  });
});

// Wrap the shared listeners only for this loopback test instance.
const [upgrade] = httpServer.listeners('upgrade');
httpServer.off('upgrade', upgrade);
httpServer.on('upgrade', (req,socket,head) => {
  const origin = req.headers.origin;
  if (!online || !hosts.has(req.headers.host) || (origin && !/^(chrome|moz)-extension:\/\//.test(origin))) {
    socket.destroy();
    return;
  }
  upgrade(req,socket,head);
});
const ui = express();
httpServer.off('request',app);
httpServer.on('request',ui);
ui.use((req,res,next) => {
  if (!hosts.has(req.headers.host) || (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) ||
      (req.method === 'POST' && !req.is('application/json'))) return res.sendStatus(403);
  res.set({'Cache-Control':'no-store','X-Frame-Options':'DENY',
    'Content-Security-Policy':"default-src 'self'; frame-ancestors 'none'; object-src 'none'"});
  next();
});
ui.use(express.static(fileURLToPath(new URL('./public/',import.meta.url))));
ui.get('/events',(req,res) => {
  res.set({'Content-Type':'text/event-stream','Cache-Control':'no-store'});
  res.flushHeaders();
  for (const line of history) res.write('data: ' + line + '\n\n');
  res.write('data: ' + JSON.stringify({kind:'Connection',at:new Date().toISOString(),payload:status()}) + '\n\n');
  clients.add(res);
  res.on('close',() => clients.delete(res));
});
ui.use('/manual',express.json({limit:'200kb'}));
ui.get('/manual/dashboard',async (_req,res,next) => {
  try { res.json(await inspectDashboard()); } catch (err) { next(err); }
});
ui.post('/manual/network',(req,res) => {
  const {mode,session} = req.body;
  if (!['offline','online','disconnect'].includes(mode)) return res.sendStatus(400);
  if (mode !== 'disconnect') online = mode === 'online';
  const sockets = [...wss.clients].filter(ws => !session || session === ws.browserSessionId);
  if (mode === 'disconnect' && !sockets.length) return res.status(409).json({error:'No matching socket'});
  if (mode !== 'online') for (const ws of mode === 'offline' ? wss.clients : sockets) ws.close(4010,'Manual disconnect');
  record('Connection',status());
  res.json(status());
});
ui.post('/manual/clear',(_req,res) => {
  history.length = bytes = 0;
  res.json({cleared:true});
});
ui.post('/manual/desktop',async (req,res) => {
  try { res.json(await desktopAction(req.body)); }
  catch (err) {res.status(400).json({error:err.message});}
});
let settings = normalizeAgentSettings({});
ui.get('/manual/settings',(_req,res) => res.json(settings));
ui.post('/manual/settings',(req,res) => {
  try {
    const next = normalizeAgentSettings(req.body);
    fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({agentSettings:next}));
    settings = next;
    res.json({revision:refreshExtensionSettings(),settings});
  } catch (err) {res.status(400).json({error:err.message});}
});
ui.use(app);
try {
  const address = await startServer();
  hosts.add('localhost:' + address.port);
  hosts.add('127.0.0.1:' + address.port);
  const url = 'http://127.0.0.1:' + address.port;
  console.log('Manual tester: ' + url);
  if (process.argv.includes('--open') && process.platform === 'win32') {
    spawn('explorer.exe',[url],{windowsHide:true,stdio:'ignore'}).on('error',err => console.error(err.message)).unref();
  }
  process.send?.({url});
  async function shutdown() {
    for (const res of clients) res.end();
    await stopServer();
    fs.rmSync(profile,{recursive:true,force:true});
  }
  process.once('disconnect',shutdown);
  process.once('SIGINT',shutdown);
  process.once('SIGTERM',shutdown);
} catch (err) {
  fs.rmSync(profile,{recursive:true,force:true});
  console.error(err.code === 'EADDRINUSE' ? 'Port ' + port + ' is in use. Stop the other listener and launch the tester again.' : err.message);
  process.exitCode = 1;
}
