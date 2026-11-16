import test from 'node:test';
import assert from 'node:assert/strict';
import {createCallerIdentity} from '../caller-identity.mjs';

const browser='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const incarnation='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const code1='11111111-1111-4111-8111-111111111111';
const code2='22222222-2222-4222-8222-222222222222';
const offer=(code,socket)=>({code,browserSessionId:browser,tabId:42,
  incarnationId:incarnation,routeHash:'a'.repeat(64),socket});

test('explicit pairing issues an opaque credential with stable Agent identity',()=>{
  const identity=createCallerIdentity();
  const socket={readyState:1};
  identity.offer(offer(code1,socket));
  const first=identity.bind({code:code1});
  assert.equal(first.agentCredential.length,64);
  assert.equal(identity.getByCredential(first.agentCredential).tabId,42);
  assert.throws(()=>identity.bind({code:code1}),/unavailable or expired/);
  identity.offer(offer(code2,socket));
  const rotated=identity.bind({code:code2});
  assert.equal(rotated.agentId,first.agentId,'tab remains the same logical Agent');
  assert.notEqual(rotated.agentCredential,first.agentCredential);
  assert.equal(identity.getByCredential(first.agentCredential),null);
  assert.ok(identity.getByCredential(rotated.agentCredential));
});
test('pairing offer expires and foreign/invalid capability is rejected',()=>{
  let now=0;
  const identity=createCallerIdentity({now:()=>now});
  identity.offer(offer(code1,{}));
  now=180001;
  assert.throws(()=>identity.bind({code:code1}),/expired/);
  assert.equal(identity.getByCredential('a'.repeat(64)),null);
});
