import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function launch(directory) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: '0', HOST: '127.0.0.1', CHAT_ORCH_PROFILE_DIR: directory,
      CHAT_ORCH_PRIVATE_COORDINATION: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (data) => { output += data; });
  proc.stderr.on('data', (data) => { output += data; });
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  return { proc, exited, output: () => output };
}

async function ready(run) {
  for (let i = 0; i < 100; i++) {
    const port = Number(run.output().match(/listening on http:\/\/[^:]+:(\d+)/)?.[1] || 0);
    if (port) return port;
    if (run.proc.exitCode !== null) break;
    await sleep(50);
  }
  assert.fail('Proxy did not start: ' + run.output());
}

async function stop(run) {
  if (run.proc.exitCode === null && run.proc.signalCode === null) run.proc.kill('SIGKILL');
  await run.exited;
}

test('private disk preflight recovers only a verified dead owner after forced termination', {
  timeout: 25000,
}, async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-journal-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'coordination.events.journal');
  const lock = file + '.lock';
  // Explicit provisioning is a prerequisite, not a durable power-loss guarantee.
  fs.writeFileSync(file, '');
  const first = launch(folder);
  t.after(() => stop(first));
  const port = await ready(first);
  const health = await (await fetch('http://127.0.0.1:' + port + '/health')).json();
  assert.equal(health.coordination.enabled, false, 'no false operational dispatch claim');
  assert.equal(health.coordination.storageReady, true);
  assert.ok(fs.existsSync(lock), 'private single-writer owner lock exists');
  const originalJournal = fs.readFileSync(file);
  await stop(first);

  const second = launch(folder);
  t.after(() => stop(second));
  const restartedPort = await ready(second);
  assert.equal((await (await fetch('http://127.0.0.1:' + restartedPort + '/health')).json())
    .coordination.storageReady, true);
  assert.deepEqual(fs.readFileSync(file), originalJournal, 'recovery must not modify the journal');
  assert.ok(fs.existsSync(lock), 'restarted proxy owns a new lock');
});

test('a live journal owner cannot be displaced by another proxy', {timeout:15000}, async(t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-live-lock-'));
  const journal = path.join(folder, 'coordination.events.journal');
  fs.writeFileSync(journal, '');
  const first = launch(folder);
  const secondRuns = [];
  t.after(async() => {
    await Promise.all([stop(first), ...secondRuns.map(stop)]);
    fs.rmSync(folder, {recursive:true,force:true});
  });
  const port = await ready(first);
  const owner = fs.readFileSync(journal + '.lock');
  const second = launch(folder);
  secondRuns.push(second);
  assert.equal(await second.exited, 1, second.output());
  assert.deepEqual(fs.readFileSync(journal + '.lock'), owner);
  assert.equal((await fetch('http://127.0.0.1:' + port + '/health')).status, 200);
});

for (const unknown of ['', 'unknown owner', '{"version":1,"pid":0}',
  JSON.stringify({version:1,pid:process.pid,hostname:os.hostname(),nonce:'invalid'})]) {
  test('unknown journal owner remains protected: ' + JSON.stringify(unknown), {timeout:12000}, async(t) => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-unknown-lock-'));
    const journal = path.join(folder, 'coordination.events.journal');
    fs.writeFileSync(journal, '');
    fs.writeFileSync(journal + '.lock', unknown);
    const run = launch(folder);
    t.after(async() => { await stop(run); fs.rmSync(folder,{recursive:true,force:true}); });
    assert.equal(await run.exited, 1, run.output());
    assert.equal(fs.readFileSync(journal + '.lock','utf8'), unknown);
    assert.equal(fs.statSync(journal).size, 0);
  });
}

test('concurrent crash recovery admits only one journal writer', {timeout:20000}, async(t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-recovery-race-'));
  const journal = path.join(folder, 'coordination.events.journal');
  fs.writeFileSync(journal, '');
  const runs = [launch(folder)];
  t.after(async() => {
    await Promise.all(runs.map(stop));
    fs.rmSync(folder,{recursive:true,force:true});
  });
  await ready(runs[0]);
  await stop(runs[0]);
  const contenders = [launch(folder), launch(folder), launch(folder)];
  runs.push(...contenders);
  const outcomes = await Promise.all(contenders.map(async(run) => {
    try { await ready(run); return true; } catch { return false; }
  }));
  assert.equal(outcomes.filter(Boolean).length, 1, contenders.map(run=>run.output()).join('\n'));
  assert.equal(fs.statSync(journal).size, 0);
});

test('standalone termination signal drains journal and releases lock', {timeout:15000}, async(t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-signal-stop-'));
  const journal = path.join(folder, 'coordination.events.journal');
  fs.writeFileSync(journal, '');
  // Windows process.kill is forceful; emitting in-process tests the same installed
  // signal handler without pretending it is an OS console-event integration test.
  const entry = new URL('../server.js',import.meta.url).href;
  const script = `process.argv[1]=${JSON.stringify(fileURLToPath(new URL('../server.js',import.meta.url)))};
    await import(${JSON.stringify(entry)});
    process.stdin.once('data',()=>{process.emit('SIGINT');process.emit('SIGTERM');process.stdin.pause();});`;
  const proc = spawn(process.execPath,['--input-type=module','-e',script],{
    cwd:ROOT,env:{...process.env,PORT:'0',HOST:'127.0.0.1',
      CHAT_ORCH_PROFILE_DIR:folder,CHAT_ORCH_PRIVATE_COORDINATION:'1'},
    stdio:['pipe','pipe','pipe'],
  });
  let output='';
  proc.stdout.on('data',chunk=>output+=chunk);
  proc.stderr.on('data',chunk=>output+=chunk);
  const run={proc,exited:new Promise(resolve=>proc.once('exit',resolve)),output:()=>output};
  t.after(async()=>{await stop(run);fs.rmSync(folder,{recursive:true,force:true});});
  await ready(run);
  proc.stdin.write('stop\n');
  for(let i=0;i<120 && fs.existsSync(journal+'.lock');i++)await sleep(50);
  assert.equal(fs.existsSync(journal+'.lock'),false,'termination handler did not release journal lock');
  assert.equal(await run.exited,0,output);
});

test('explicit graceful stop flushes journal and releases only its own lock', {
  timeout: 25000,
}, async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-graceful-lock-'));
  t.after(() => fs.rmSync(folder, {recursive:true,force:true}));
  const journal = path.join(folder,'coordination.events.journal');
  const lock = journal + '.lock';
  fs.writeFileSync(journal,'');
  const script = [
    "import {startServer, stopServer} from './server.js';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const address=await startServer();",
    "const lock=path.join(process.env.CHAT_ORCH_PROFILE_DIR,'coordination.events.journal.lock');",
    "if(!fs.existsSync(lock)) throw new Error('Private journal lock not acquired');",
    "const response=await fetch('http://127.0.0.1:'+address.port+'/health');",
    "if(!response.ok) throw new Error('Health endpoint unavailable');",
    "await stopServer();",
    "if(fs.existsSync(lock)) throw new Error('Graceful stop left owner lock');",
    "console.log('JOURNAL_GRACEFUL_STOP_OK');",
  ].join('\n');
  const proc=spawn(process.execPath,['--input-type=module','-e',script],{
    cwd:ROOT,env:{...process.env,PORT:'0',HOST:'127.0.0.1',
      CHAT_ORCH_PROFILE_DIR:folder,CHAT_ORCH_PRIVATE_COORDINATION:'1'},
    stdio:['ignore','pipe','pipe'],
  });
  t.after(()=>proc.kill());
  let output='';
  proc.stdout.on('data',(chunk)=>{output+=chunk;});
  proc.stderr.on('data',(chunk)=>{output+=chunk;});
  const code=await new Promise((resolve)=>proc.once('exit',resolve));
  assert.equal(code,0,output);
  assert.match(output,/JOURNAL_GRACEFUL_STOP_OK/);
  assert.equal(fs.existsSync(lock),false,'graceful stop releases its own owner lock');
});
