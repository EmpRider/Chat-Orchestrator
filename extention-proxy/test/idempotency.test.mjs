import test from 'node:test';
import assert from 'node:assert/strict';
import {createIdempotencyLedger} from '../idempotency.mjs';

const KEY='11ab1111-2222-4333-8444-555555555555';
test('same-key retries share one in-flight operation and original result',async()=>{
  const ledger=createIdempotencyLedger();
  let calls=0;
  const args={idempotency_key:KEY,tab_id:12};
  const op=async()=>{calls++;await new Promise((r)=>setTimeout(r,10));return {tab_id:12,nonce:'first'};};
  const [a,b]=await Promise.all([
    ledger.execute('s1','spawn_worker',args,op),
    ledger.execute('s1','spawn_worker',{tab_id:12,idempotency_key:KEY},op),
  ]);
  assert.deepEqual(a,b);
  assert.equal(calls,1);
});
test('different operation with same key is rejected; other callers are isolated',async()=>{
  const ledger=createIdempotencyLedger();
  assert.equal(await ledger.execute('s1','read_chat',{idempotency_key:KEY},()=>1),1);
  await assert.rejects(ledger.execute('s1','send_to_tab',{idempotency_key:KEY},()=>2),
    /reused with a different/);
  assert.equal(await ledger.execute('s2','read_chat',{idempotency_key:KEY},()=>3),3);
});
test('fresh-key reads return a fresh snapshot, same-key returns first snapshot',async()=>{
  const ledger=createIdempotencyLedger();
  let value=1;
  const args={idempotency_key:KEY};
  assert.equal(await ledger.execute('s1','read_chat',args,()=>value),1);
  value=2;
  assert.equal(await ledger.execute('s1','read_chat',args,()=>value),1);
  assert.equal(await ledger.execute('s1','read_chat',{
    idempotency_key:'22ab2222-2222-4333-8444-555555555555'},()=>value),2);
});
