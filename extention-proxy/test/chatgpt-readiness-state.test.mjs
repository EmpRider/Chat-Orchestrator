import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const content = readFileSync(new URL('../../extention/content.js',import.meta.url),'utf8');

function readinessHarness() {
  let onMessage;
  let readyState='loading';
  let bodyText='';
  let userTurn='';
  const input={
    tagName:'DIV',textContent:'',offsetParent:{},getClientRects(){return [{}];},
    closest(){return null;},
  };
  const document={
    get readyState(){return readyState;},
    querySelectorAll(selector){
      if(selector==='#prompt-textarea')return [input];
      if(selector.includes('[data-message-author-role="user"]'))
        return userTurn?[{innerText:userTurn,textContent:userTurn}]:[];
      return [];
    },
    body:{get innerText(){return bodyText;}},
  };
  const chrome={runtime:{onMessage:{addListener(fn){onMessage=fn;},removeListener(){}}}};
  runInNewContext(content,{document,window:{},chrome,
    location:{hostname:'chatgpt.com'},
    Event:class {constructor(type){this.type=type;}},
    setTimeout,clearTimeout});
  const ping=(expectedText)=>{let response;
    onMessage({cmd:'ping',expectedText},{},r=>{response=r;});return response;};
  return {
    ping,
    setDocumentComplete(){readyState='complete';},
    setBodyText(value){bodyText=value;},
    setDraft(value){input.textContent=value;},
    setUserTurn(value){userTurn=value;},
  };
}

test('ChatGPT composer state requires document completeness without network-idle tracking',()=>{
  const h=readinessHarness();
  assert.equal(h.ping().state,'loading');
  assert.equal(h.ping().ready,false);
  h.setDocumentComplete();
  assert.equal(h.ping().state,'idle');
  assert.equal(h.ping().ready,true);
  h.setBodyText('Your account changed. Send your message again\nRetry');
  assert.equal(h.ping().state,'uncertain');
  assert.equal(h.ping().ready,false);
});

test('only an exact assigned task draft can pass worker readiness',()=>{
  const h=readinessHarness();
  h.setDocumentComplete();
  const expected='<system_instructions>Task A</system_instructions>\n<task>do work</task>';
  h.setDraft(expected);
  assert.equal(h.ping().state,'draft');
  assert.equal(h.ping().ready,false);
  assert.equal(h.ping('A different task').ready,false);
  const allowed=h.ping(expected);
  assert.equal(allowed.ready,true);
  assert.equal(allowed.matchingDraft,true);
  h.setUserTurn(expected);
  assert.equal(h.ping(expected).ready,false,
    'a matching user turn could be an earlier submission and must not be repeated');
});

test('ChatGPT account-change warning after click is never reported as a completed worker reply', {
  timeout:8000,
}, async()=>{
  let onMessage;
  let pageText='';
  let clicks=0;
  let editOps=0;
  let resolveCompletion;
  const completion=new Promise(resolve=>{resolveCompletion=resolve;});
  const input={
    tagName:'DIV',textContent:'Synthetic worker task',offsetParent:{},getClientRects(){return [{}];},
    focus(){},closest(selector){return selector==='form'?form:null;},
  };
  const button={
    disabled:false,offsetParent:{},getClientRects(){return [{}];},
    getBoundingClientRect(){return {left:100,top:100,width:32,height:32};},
    contains(node){return node===this;},
    closest(){return null;},getAttribute(){return null;},
    click(){clicks++;input.textContent='';
      pageText='Your account changed. Send your message again\\nRetry';},
  };
  function query(selector) {
    if(selector.includes(','))return [...new Set(selector.split(',').flatMap(s=>query(s.trim())))];
    if(selector==='#prompt-textarea')return [input];
    if(selector==='button[data-testid="send-button"]')return [button];
    return [];
  }
  const form={querySelectorAll:query};
  const listeners=new Map();
  const document={
    readyState:'complete',querySelectorAll:query,
    createRange(){return {selectNodeContents(){}};},
    elementFromPoint(){return button;},
    execCommand(command,_display,value) {
      editOps++;
      if(command==='delete')input.textContent='';
      if(command==='insertText')input.textContent+=value;
      if(command==='insertLineBreak')input.textContent+='\\n';
    },
    body:{get innerText(){return pageText;}},
  };
  const selection={removeAllRanges(){},addRange(){}};
  const chrome={runtime:{
    onMessage:{addListener(fn){onMessage=fn;},removeListener(){}},
    async sendMessage(report){
      if(report?.type==='browser_page_settled') return {ok:true,ready:true};
      if(report?.type==='composer_send_click') throw new Error('Unexpected debugger Send request');
      resolveCompletion(report);return {ok:true};
    },
  }};
  runInNewContext(content,{document,chrome,window:{innerWidth:800,innerHeight:600,
    getSelection(){return selection;}},
    location:{hostname:'chatgpt.com'},
    Event:class {constructor(type){this.type=type;}},
    setTimeout,clearTimeout});
  let resolveSubmit;
  const submission=new Promise(resolve=>{resolveSubmit=resolve;});
  const returned=onMessage({
    cmd:'run_prompt',taskId:'00000000-0000-4000-8000-000000000001',
    receiptNonce:'00000000-0000-4000-8000-000000000002',
    text:'Synthetic worker task',
    timeoutMs:1200,
  },{},resolveSubmit);
  assert.equal(returned,true,'submission acknowledgment uses async message channel');
  const dispatchReply=await submission;
  assert.equal(dispatchReply.ok,false);
  assert.equal(dispatchReply.uncertain,true);
  const report=await completion;
  assert.equal(editOps,0,'existing identical worker draft must not be rewritten');
  assert.equal(clicks,1,'must not resend a prompt after an account-change error');
  assert.equal(report.type,'task_done');
  assert.equal(report.ok,false);
  assert.equal(report.uncertain,true);
  assert.match(report.error,/account changed/i);
  assert.equal(report.text,undefined,'page error text must not become worker output');
});
