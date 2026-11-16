// Source-only coverage: graceful, duplicated shutdown must release our own
// journal lock even when an HTTP keep-alive connection was recently used.
// Run in the owner's final coordinated regression pass, never against a live profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,existsSync,rmSync,mkdirSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import http from 'node:http';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('D-039 FIFO journal remains in persistent profile across clean Desktop/Proxy restarts',{
  timeout:35000,
},(t)=>{
  const base=mkdtempSync(path.join(tmpdir(),'chat-orch-journal-persist-'));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const runtime=path.join(base,'ephemeral');
  const profile=path.join(base,'persisted-profile');
  const journal=path.join(profile,'coordination.events.journal');
  const lock=journal+'.lock';
  mkdirSync(runtime,{recursive:true});
  mkdirSync(profile,{recursive:true});
  writeFileSync(journal,'',{flag:'wx'});
  const script=[
    "import {startServer,stopServer} from './server.js';",
    'await startServer();',
    'await stopServer();',
    "console.log('CLEAN_STOP');",
  ].join('\n');
  for(let i=0;i<2;i++){
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{
      cwd:root,encoding:'utf8',timeout:14000,
      env:{...process.env,HOST:'127.0.0.1',PORT:'0',
        CHAT_ORCH_PROFILE_DIR:runtime,CHAT_ORCH_JOURNAL_DIR:profile,
        CHAT_ORCH_PRIVATE_COORDINATION:'1'},
    });
    assert.equal(result.status,0,result.stderr||result.error?.message||result.stdout);
    assert.match(result.stdout,/CLEAN_STOP/);
    assert.equal(existsSync(journal),true,'profile journal survives process stop');
    assert.equal(existsSync(lock),false,'owned lock released after each clean stop');
    assert.equal(statSync(journal).size,0);
    assert.equal(existsSync(path.join(runtime,'coordination.events.journal')),false,
      'runtime directory must not receive the persistent FIFO');
  }
});

test('graceful duplicate stop releases private journal lock with HTTP keep-alive', {
  timeout:25000,
}, async(t)=>{
  const profile=mkdtempSync(path.join(tmpdir(),'chat-orch-graceful-stop-'));
  const journal=path.join(profile,'coordination.events.journal');
  const lock=journal+'.lock';
  writeFileSync(journal,'');
  const script=[
    "import {startServer,stopServer} from './server.js';",
    'const addr=await startServer();',
    "console.log('READY '+addr.port);",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.once('data',async()=>{",
    '  try {',
    '    await Promise.all([stopServer(),stopServer()]);',
    "    console.log('STOPPED');",
    '    process.exitCode=0;',
    '  } catch(error) {',
    "    console.error('SHUTDOWN_ERROR '+error.message);",
    '    process.exitCode=1;',
    '  }',
    '  process.stdin.pause();',
    '});',
  ].join('\n');
  const proc=spawn(process.execPath,['--input-type=module','-e',script],{
    cwd:root,
    env:{...process.env,PORT:'0',HOST:'127.0.0.1',
      CHAT_ORCH_PROFILE_DIR:profile,CHAT_ORCH_PRIVATE_COORDINATION:'1'},
    stdio:['pipe','pipe','pipe'],
  });
  t.after(()=>{
    if(proc.exitCode===null && proc.signalCode===null)proc.kill();
    rmSync(profile,{recursive:true,force:true});
  });
  let stdout='',stderr='';
  proc.stdout.on('data',(chunk)=>{stdout+=chunk;});
  proc.stderr.on('data',(chunk)=>{stderr+=chunk;});
  const port=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Proxy did not become ready: '+stdout+' '+stderr)),9000);
    const check=()=>{
      const match=stdout.match(/READY (\d+)/);
      if(match){clearTimeout(timer);proc.stdout.off('data',check);resolve(Number(match[1]));}
    };
    proc.stdout.on('data',check);
    proc.once('exit',(code)=>{clearTimeout(timer);reject(new Error('Proxy exited '+code+': '+stderr));});
    check();
  });
  assert.equal(existsSync(lock),true,'journal must be owned before shutdown');
  const agent=new http.Agent({keepAlive:true});
  try{
    const response=await new Promise((resolve,reject)=>{
      http.get({host:'127.0.0.1',port,path:'/health',agent},(res)=>{
        res.resume();
        res.on('end',()=>resolve(res.statusCode));
      }).once('error',reject);
    });
    assert.equal(response,200);
    const exited=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Graceful stop timeout: '+stdout+' '+stderr)),12000);
      proc.once('exit',(code)=>{clearTimeout(timer);resolve(code);});
    });
    proc.stdin.write('stop\n');
    const exit=await exited;
    assert.equal(exit,0,'graceful shutdown must succeed: '+stdout+' '+stderr);
    assert.match(stdout,/STOPPED/);
    assert.equal(existsSync(lock),false,'successful shutdown must remove only its owned lock');
    assert.equal(existsSync(journal),true,'journal data must remain intact');
  } finally {agent.destroy();}
});
