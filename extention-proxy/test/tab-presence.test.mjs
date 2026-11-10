import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOpenChatTabs, annotateTabPresence} from '../tab-presence.mjs';

const saved = [
  {tabId:269061263,parentTabId:null,rootTabId:269061263,site:'chatgpt',phase:'root'},
  {tabId:269061070,parentTabId:null,rootTabId:269061070,site:'chatgpt',phase:'root'},
  {tabId:269061258,parentTabId:null,rootTabId:269061258,site:'chatgpt',phase:'root'},
];

test('three saved roots are not three open tabs',()=>{
  const observed={status:'observed',tabs:normalizeOpenChatTabs([
    {tab_id:269061258,site:'chatgpt',role:'unregistered',active:true},
  ])};
  const entries=annotateTabPresence(saved,observed);
  assert.equal(entries.length,3,'saved records must not be deleted');
  assert.deepEqual(entries.map((entry)=>entry.presence),
    ['not_open','not_open','open_unverified']);
  assert.deepEqual(saved.map((entry)=>entry.tabId),
    [269061263,269061070,269061258]);
});

test('open unregistered tabs do not fabricate roots',()=>{
  const observation={status:'observed',tabs:normalizeOpenChatTabs([
    {tab_id:12345,site:'chatgpt'},
  ])};
  assert.equal(annotateTabPresence(saved,observation).filter(
    (entry)=>entry.presence==='open_unverified').length,0);
});

test('site change flags possible tab reuse; matching IDs are not attestation',()=>{
  const observation={status:'observed',tabs:normalizeOpenChatTabs([
    {tab_id:269061258,site:'claude'},
  ])};
  assert.equal(annotateTabPresence(saved,observation)[2].presence,'site_mismatch');
  assert.equal(annotateTabPresence(saved,{status:'observed',tabs:[
    {tabId:269061258,site:'chatgpt'},
  ]})[2].presence,'open_unverified');
});

test('unavailable browser observation never marks roots closed',()=>{
  for(const observation of [undefined,{status:'unavailable',tabs:[]}]){
    assert.ok(annotateTabPresence(saved,observation).every(
      (entry)=>entry.presence==='unknown'));
  }
  assert.throws(()=>normalizeOpenChatTabs(null),/unavailable/);
});

test('tab discovery strips duplicates and sensitive content',()=>{
  const out=normalizeOpenChatTabs([
    {tab_id:17,site:'chatgpt',title:'private title',url:'https://chatgpt.com/c/private'},
    {tab_id:17,site:'chatgpt'}, {tab_id:-5,site:'chatgpt'},
    {tab_id:18,site:'untrusted'}, {tab_id:19,site:'gemini'},
  ]);
  assert.deepEqual(out,[{tabId:17,site:'chatgpt'},{tabId:19,site:'gemini'}]);
  assert.doesNotMatch(JSON.stringify(out),/private title|\/c\/private/);
});
