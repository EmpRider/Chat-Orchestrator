import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDiagnostics,classifyDiagnosticError} from '../diagnostics.mjs';

test('LogLayer diagnostics redact sensitive input and correlate safe fields',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-orch-logging-'));
  try {
    const log=createDiagnostics({component:'proxy',directory:dir,level:'debug'});
    const traceId='12345678-1234-4234-8234-123456789abc';
    log.info('identity.registry_mismatch',{
      traceId,tabId:269061258,mismatchField:'incarnationId',
      token:'SECRET_TOKEN',prompt:'PRIVATE CHAT TEXT',
      url:'https://chatgpt.com/c/private',error:'SECRET ERROR',
    });
    const entry=JSON.parse(fs.readFileSync(log.path,'utf8').trim());
    assert.equal(entry.msg,'identity.registry_mismatch');
    assert.equal(entry.data.tabId,269061258);
    assert.equal(entry.data.traceId,traceId);
    assert.equal(entry.data.mismatchField,'incarnationId');
    assert.ok(!('prompt' in entry.data) && !('token' in entry.data));
    assert.ok(!('url' in entry.data) && !('error' in entry.data));
    assert.doesNotMatch(JSON.stringify(entry),/SECRET|PRIVATE CHAT|chatgpt\.com/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('diagnostics rotate and logging failure does not affect the caller',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-orch-logging-'));
  try {
    const log=createDiagnostics({component:'proxy',directory:dir,level:'debug',maxBytes:600});
    for(let i=0;i<70;i++)log.info('fifo.pump_held',{tabId:5,count:i});
    assert.ok(fs.existsSync(log.path));
    assert.ok(fs.existsSync(log.path+'.1'));
    assert.ok(fs.existsSync(log.path+'.2'));
    assert.ok(fs.statSync(log.path).size<=600);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
  const failedDir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-orch-unwritable-log-'));
  try {
    const fileInsteadOfFolder=path.join(failedDir,'not-a-folder');
    fs.writeFileSync(fileInsteadOfFolder,'leave me unchanged');
    const log=createDiagnostics({component:'proxy',directory:fileInsteadOfFolder});
    assert.doesNotThrow(()=>log.warn('fifo.ack_rejected',{batchSize:16}));
    assert.equal(fs.readFileSync(fileInsteadOfFolder,'utf8'),'leave me unchanged');
  } finally {fs.rmSync(failedDir,{recursive:true,force:true});}
});

test('diagnostic classifier returns categories, never source error messages',()=>{
  assert.equal(classifyDiagnosticError(new Error(
    'Caller tab session/incarnation changed; secret prompt text')),'identity_changed');
  assert.equal(classifyDiagnosticError(new Error('Batch processing ACK does not match')),'ack_rejected');
  assert.equal(classifyDiagnosticError(new Error('Opaque credential failed')),'operation_failed');
});
