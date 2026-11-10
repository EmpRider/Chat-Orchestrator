import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';

const source=readFileSync(new URL('../../extention/content.js',import.meta.url),'utf8');

function composerHarness({textarea,extraEnabledButton,neverEnableSend=false,networkBusyAfterInput=false}) {
  let messageHandler;
  let submitted='';
  let primaryClicks=0;
  let secondaryClicks=0;
  let trustedEvents=0;
  let networkChecks=0;
  let form;
  let input;
  class FakeTextArea {
    constructor() {this._value='';this.tagName='TEXTAREA';this.offsetParent={};}
    get value(){return this._value;}
    set value(v){this._value=v;}
    focus(){}
    select(){this.selected=true;}
    getClientRects(){return [{}];}
    closest(sel){return sel==='form'?form:null;}
    dispatchEvent(event){if(event.type==='input'&&event.isTrusted)trustedEvents++;}
  }
  input=textarea?new FakeTextArea():{
    textContent:'',tagName:'DIV',offsetParent:{},getClientRects:()=>[{}],
    focus(){},closest(sel){return sel==='form'?form:null;},
  };
  const primary={
    disabled:textarea,offsetParent:{},getClientRects(){return [{}];},
    getBoundingClientRect(){return {left:100,top:100,width:32,height:32};},
    contains(node){return node===this;},
    closest(){return null;},
    getAttribute(name){return name==='data-testid'?'send-button':null;},
    click(){primaryClicks++;submitted=textarea?input.value:input.textContent;
      if(textarea)input.value='';else input.textContent='';},
  };
  const secondary={
    disabled:false,offsetParent:{},getClientRects(){return [{}];},
    getBoundingClientRect(){return {left:200,top:100,width:32,height:32};},
    contains(node){return node===this;},
    closest(){return null;},
    getAttribute(name){return name==='aria-label'?'Send message':null;},
    click(){secondaryClicks++;},
  };
  function query(selector) {
    if(selector.includes(','))return [...new Set(selector.split(',').flatMap(s=>query(s.trim())))];
    if(selector==='#prompt-textarea')return [input];
    if(selector==='button[data-testid="send-button"]')return [primary];
    if(selector==='button[aria-label*="send" i]' ||
       selector==='button[aria-label="Send message"]')
      return extraEnabledButton?[secondary]:[];
    if(selector==='[data-message-author-role="user"]')return submitted
      ?[{textContent:submitted,innerText:submitted}]:[];
    return [];
  }
  form={querySelectorAll:query};
  const document={
    readyState:'complete',
    querySelectorAll:query,
    elementFromPoint(x){return x>175?secondary:primary;},
    createRange(){return {selectNodeContents(){}};},
    execCommand(command,_show,value) {
      if(command==='delete'){
        if(textarea)input.value='';else input.textContent='';
      }
      if(command==='insertText'){
        if(textarea)input.value=value;else input.textContent+=value;
        if(!neverEnableSend)primary.disabled=false;
        trustedEvents++;
      }
      if(command==='insertLineBreak'&&!textarea)input.textContent+='\n';
      return true;
    },
    body:{get innerText(){return submitted;}},
  };
  const window={innerWidth:800,innerHeight:600,
    getSelection(){return {removeAllRanges(){},addRange(){}};}};
  const chrome={runtime:{onMessage:{
    addListener(fn){messageHandler=fn;},removeListener(){},
  },sendMessage:async(message)=>{
    if(message.type==='composer_send_click') throw new Error('DOM sending must not use CDP transport');
    networkChecks++;
    if(networkBusyAfterInput && trustedEvents>0) {
      return {ok:false,ready:false,error:'background request still pending'};
    }
    return {ok:true,ready:true};
  }}};
  runInNewContext(source,{
    document,window,chrome,
    location:{hostname:'chatgpt.com'},
    Event:class{constructor(type,options){this.type=type;this.isTrusted=false;this.bubbles=options?.bubbles;}},
    HTMLTextAreaElement:FakeTextArea,
    setTimeout,clearTimeout,
  });
  return {
    call:async(text)=>{
      return new Promise((resolve,reject)=>{
        const r=messageHandler({cmd:'submit_manager_batch',text},{},resolve);
        if(r!==true)reject(new Error('Expected async response'));
      });
    },
    info:()=>({primaryClicks,secondaryClicks,trustedEvents,submitted,
      draft:textarea?input.value:input.textContent,networkChecks}),
  };
}


function batch() {
  return '<queue_batch>{"batch_id":"'+randomUUID()+'","events":[]}</queue_batch>';
}

test('textarea uses native browser editing to enable controlled composer before sending', {timeout:10000},async()=>{
  const h=composerHarness({textarea:true,extraEnabledButton:false});
  const text=batch();
  const result=await h.call(text);
  assert.equal(result.submitted,true,JSON.stringify(result));
  assert.deepEqual(h.info(),{primaryClicks:1,secondaryClicks:0,trustedEvents:1,
    submitted:text,draft:'',networkChecks:1});
});

test('active composer prefers its exact send control over other enabled send-like controls', {timeout:10000},async()=>{
  const h=composerHarness({textarea:false,extraEnabledButton:true});
  const text=batch();
  const result=await h.call(text);
  assert.equal(result.submitted,true,JSON.stringify(result));
  const info=h.info();
  assert.equal(info.primaryClicks,1);
  assert.equal(info.secondaryClicks,0);
});

test('disabled composer Send never clicks and clears its own unsent draft', {timeout:12000}, async()=>{
  const h=composerHarness({textarea:true,extraEnabledButton:false,neverEnableSend:true});
  const result=await h.call(batch());
  assert.equal(result.submitted,undefined);
  assert.equal(h.info().primaryClicks,0);
  assert.equal(h.info().secondaryClicks,0);
  assert.equal(h.info().draft,'', 'unsent draft must not block same-tab follow-up');
});

test('prompt still sends when a background fetch starts after the draft is inserted', {timeout:10000},async()=>{
  const h=composerHarness({textarea:true,extraEnabledButton:false,networkBusyAfterInput:true});
  const text=batch();
  const result=await h.call(text);
  assert.equal(result.submitted,true,JSON.stringify(result));
  const resultState=h.info();
  assert.equal(resultState.primaryClicks,1);
  assert.equal(resultState.submitted,text);
  assert.equal(resultState.draft,'');
  assert.equal(resultState.networkChecks,1,
    'CDP readiness must not be required again after the page accepts the draft');
});
