import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createCallerIdentity} from '../caller-identity.mjs';
import {createAgentBindingStore} from '../agent-binding-store.mjs';

test('restart preserves encrypted Agent credential and persistent revocation',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-orch-bindings-'));
  try {
    const store=createAgentBindingStore(dir);
    const first=createCallerIdentity({onChange:store.save});
    const code=crypto.randomUUID(), browserSessionId=crypto.randomUUID();
    const incarnationId=crypto.randomUUID(), routeHash='f'.repeat(64),tabId=123;
    first.offer({code,browserSessionId,tabId,incarnationId,routeHash,socket:{}});
    const bound=first.bind({code});
    const encrypted=fs.readFileSync(path.join(dir,'mcp-agent-bindings.bin'));
    assert.equal(encrypted.includes(Buffer.from(bound.agentCredential)),false);
    const second=createCallerIdentity({onChange:store.save});
    second.restore(store.load());
    assert.equal(second.getByCredential(bound.agentCredential)?.tabId,tabId);
    assert.equal(second.getByCredential(bound.agentCredential)?.agentId,bound.agentId);
    assert.equal(second.revokeTab(browserSessionId,tabId),1);
    const third=createCallerIdentity({onChange:store.save});
    third.restore(store.load());
    assert.equal(third.getByCredential(bound.agentCredential),null);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('tampering with encrypted Agent bindings is detected',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-orch-corrupt-binding-'));
  try {
    const store=createAgentBindingStore(dir);
    store.save([]);
    fs.appendFileSync(path.join(dir,'mcp-agent-bindings.bin'),'tampered');
    assert.throws(()=>store.load(),/authenticat|invalid|corrupt/i);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
