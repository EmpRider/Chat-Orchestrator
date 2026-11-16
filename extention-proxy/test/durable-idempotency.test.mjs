import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDurableIdempotencyLedger} from '../durable-idempotency.mjs';

const uuid='55555555-5555-4555-8555-555555555555';
const other='66666666-6666-4666-8666-666666666666';
test('encrypted first response replays across restart and survives bearer rotation',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'chat-orch-durable-idem-'));
  t.after(()=>fs.rm(dir,{force:true,recursive:true}));
  const file=path.join(dir,'operational.bin');
  let calls=0;
  const one=await createDurableIdempotencyLedger(file);
  const args={idempotency_key:uuid,agent_credential:'a'.repeat(64),tab_id:101};
  const original={content:[{type:'text',text:'sensitive synthetic first response'}]};
  const [a,b]=await Promise.all([
    one.execute('logical-agent','read_chat',args,async()=>{
      calls++;await new Promise((resolve)=>setTimeout(resolve,5));return original;
    }),
    one.execute('logical-agent','read_chat',args,async()=>{calls++;return {wrong:true};}),
  ]);
  assert.deepEqual(a,original);assert.deepEqual(b,original);
  assert.equal(calls,1);
  const bytes=await fs.readFile(file,'utf8');
  assert.doesNotMatch(bytes,/sensitive synthetic first response/);
  assert.doesNotMatch(bytes,/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  const restored=await createDurableIdempotencyLedger(file);
  const replay=await restored.execute('logical-agent','read_chat',
    {...args,agent_credential:'b'.repeat(64)},async()=>{calls++;return {wrong:true};});
  assert.deepEqual(replay,original);
  assert.equal(calls,1);
  await assert.rejects(restored.execute('logical-agent','read_chat',
    {...args,tab_id:202},async()=>({wrong:true})),/conflicting/);
  assert.deepEqual(await restored.execute('another-agent','read_chat',
    {...args,agent_credential:'c'.repeat(64)},async()=>({different:true})),{different:true});
  assert.deepEqual(await restored.execute('logical-agent','read_chat',
    {...args,idempotency_key:other},async()=>({fresh:true})),{fresh:true});
});

test('abandoned write-ahead reservation fails closed after a crash',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'chat-orch-durable-crash-'));
  t.after(()=>fs.rm(dir,{force:true,recursive:true}));
  const file=path.join(dir,'operational.bin');
  const ledger=await createDurableIdempotencyLedger(file);
  let signal;
  const never=new Promise((resolve)=>{signal=resolve;});
  const args={idempotency_key:uuid,tab_id:101};
  const pending=ledger.execute('logical-agent','spawn_worker',args,async()=>never);
  for(let i=0;i<100;i++){
    try {
      const text=await fs.readFile(file,'utf8');
      if(text.includes('UNKNOWN'))break;
    }catch{}
    await new Promise((resolve)=>setTimeout(resolve,5));
  }
  const nextProcess=await createDurableIdempotencyLedger(file);
  let duplicate=0;
  const result=await nextProcess.execute('logical-agent','spawn_worker',args,async()=>{
    duplicate++;return {spawned:true};
  });
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/UNKNOWN/);
  assert.equal(duplicate,0);
  signal({spawned:true});
  await pending;
});
