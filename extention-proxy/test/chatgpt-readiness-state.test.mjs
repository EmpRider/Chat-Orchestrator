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
  assert.equal(h.ping('A different task').whitespaceEquivalent,false);
  const rendered=h.ping(expected.replace('\n','  '));
  assert.equal(rendered.ready,false);
  assert.equal(rendered.whitespaceEquivalent,true,
    'whitespace-only mismatch is diagnosed, never authorized for automatic submission');
  const allowed=h.ping(expected);
  assert.equal(allowed.ready,true);
  assert.equal(allowed.matchingDraft,true);
  assert.equal(allowed.expectedLength,expected.length);
  h.setUserTurn(expected);
  assert.equal(h.ping(expected).ready,true,
    'an earlier identical user turn must not block a deliberate follow-up task');
});

test('a repeated identical follow-up submits a new user turn', {timeout:8000}, async()=>{
  let onMessage;
  let userTurns=1;
  let clicks=0;
  const text='Repeat this instruction';
  const input={tagName:'DIV',textContent:'',offsetParent:{},getClientRects(){return [{}];},
    focus(){},closest(selector){return selector==='form'?form:null;}};
  const button={disabled:false,offsetParent:{},getClientRects(){return [{}];},
    getBoundingClientRect(){return {left:100,top:100,width:32,height:32};},
    contains(node){return node===this;},closest(){return null;},getAttribute(){return null;},
    click(){clicks++;userTurns++;input.textContent='';}};
  function query(selector){
    if(selector.includes(','))return [...new Set(selector.split(',').flatMap(s=>query(s.trim())))];
    if(selector==='#prompt-textarea')return [input];
    if(selector==='button[data-testid="send-button"]')return [button];
    if(selector==='[data-message-author-role="user"]')return Array.from({length:userTurns},()=>({innerText:text,textContent:text,contains(){return false;}}));
    return [];
  }
  const form={querySelectorAll:query};
  const document={readyState:'complete',querySelectorAll:query,body:{innerText:''},
    elementFromPoint(){return button;},createRange(){return {selectNodeContents(){}};},
    execCommand(command,_display,value){
      if(command==='delete')input.textContent='';
      if(command==='insertText')input.textContent+=value;
      return true;
    }};
  const chrome={runtime:{onMessage:{addListener(fn){onMessage=fn;},removeListener(){}},
    async sendMessage(){return {ok:true,ready:true};}}};
  runInNewContext(content,{document,chrome,window:{innerWidth:800,innerHeight:600,
    getSelection(){return {removeAllRanges(){},addRange(){}};}},
    location:{hostname:'chatgpt.com'},Event:class {constructor(type){this.type=type;}},
    setTimeout,clearTimeout});
  const outcome=await new Promise(resolve=>onMessage({cmd:'run_prompt',taskId:'repeat',
    receiptNonce:'nonce',text,timeoutMs:1000},{},resolve));
  assert.equal(outcome.submitted,true,JSON.stringify(outcome));
  assert.equal(clicks,1);
  assert.equal(userTurns,2);
});

test('submission uses the composer mounted after page settling', {timeout:8000},async()=>{
  let onMessage,turns=0,clicks=0;
  const text='Worker task after hydration';
  const old={tagName:'DIV',textContent:'',offsetParent:{},getClientRects(){return [{}];},focus(){},closest(){return form;}};
  const fresh={...old,textContent:'',closest(){return form;}};
  let active=old;
  const button={disabled:false,offsetParent:{},getClientRects(){return [{}];},
    closest(){return null;},getAttribute(){return null;},
    click(){clicks++;if(active.textContent===text){turns++;active.textContent='';}}};
  function query(selector){
    if(selector.includes(','))return [...new Set(selector.split(',').flatMap(s=>query(s.trim())))];
    if(selector==='#prompt-textarea')return [active];
    if(selector==='button[data-testid="send-button"]')return [button];
    if(selector==='[data-message-author-role="user"]')return Array.from({length:turns},()=>({textContent:text}));
    return [];
  }
  const form={querySelectorAll:query};
  const document={readyState:'complete',querySelectorAll:query,body:{innerText:''},
    createRange(){return {selectNodeContents(){}};},
    execCommand(command,_show,value){
      if(command==='delete')active.textContent='';
      if(command==='insertText')active.textContent+=value;
      return true;
    }};
  const diagnostics=[];
  const chrome={runtime:{onMessage:{addListener(fn){onMessage=fn;},removeListener(){}},
    async sendMessage(msg){
      if(msg.type==='worker_diagnostic'){diagnostics.push(msg.diagnostic);return {ok:true};}
      if(msg.type==='browser_page_settled'){active=fresh;return {ok:true,ready:true};}
      return {ok:true};
    }}};
  runInNewContext(content,{document,chrome,window:{getSelection(){return {removeAllRanges(){},addRange(){}};}},
    location:{hostname:'chatgpt.com'},setTimeout,clearTimeout});
  const reply=await new Promise(resolve=>onMessage({cmd:'run_prompt',taskId:'hydration',
    receiptNonce:'receipt',text,timeoutMs:1000},{},resolve));
  assert.equal(reply.submitted,true,JSON.stringify(reply));
  assert.equal(clicks,1);
  assert.equal(turns,1);
  assert.equal(old.textContent,'');
  assert.ok(diagnostics.some((event)=>event.step==='submission_begin'));
  assert.ok(diagnostics.some((event)=>event.step==='page_settled'));
  assert.ok(diagnostics.some((event)=>event.step==='send_click'));
  assert.ok(diagnostics.every((event)=>!Object.hasOwn(event,'text') && !Object.hasOwn(event,'prompt')),
    'worker diagnostics must never include prompt content');
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
      if(report?.type==='worker_diagnostic')return {ok:true};
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
