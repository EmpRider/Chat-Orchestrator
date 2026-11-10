import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';

const source=readFileSync(new URL('../../extention/content.js',import.meta.url),'utf8');

test('ChatGPT submits through the enabled composer button, not a preceding disabled match', {
  timeout:20000,
},async()=>{
  const batchId=randomUUID();
  const prompt='<system_instructions>Test only</system_instructions><queue_batch>{"batch_id":"'+
    batchId+'","events":[]}</queue_batch>';
  let listener;
  let submittedText='';
  let disabledClicks=0;
  let enabledClicks=0;
  const input={
    tagName:'DIV',textContent:'',offsetParent:{},
    getClientRects:()=>[{}],
    focus(){},
    closest(selector){return selector==='form'?form:null;},
  };
  const disabled={
    disabled:true,offsetParent:{},getClientRects:()=>[{}],
    getAttribute(name){return name==='data-testid'?'send-button':null;},
    closest:()=>null,
    click(){disabledClicks++;},
  };
  const enabled={
    disabled:false,offsetParent:{},getClientRects:()=>[{}],
    getBoundingClientRect(){return {left:100,top:100,width:32,height:32};},
    contains(node){return node===this;},
    getAttribute(name){return name==='aria-label'?'Send message':null;},
    closest:()=>null,
    click(){
      enabledClicks++;
      submittedText=input.textContent;
      input.textContent='';
    },
  };
  function query(selector) {
    if(selector.includes(','))return [...new Set(selector.split(',').flatMap(s=>query(s.trim())))];
    if(selector==='#prompt-textarea')return [input];
    if(selector==='button[data-testid="send-button"]')return [disabled];
    if(selector==='button[aria-label*="send" i]' ||
       selector==='button[aria-label="Send message"]')return [enabled];
    if(selector==='[data-message-author-role="user"]')return submittedText
      ?[{innerText:submittedText,textContent:submittedText}]:[];
    return [];
  }
  const form={querySelectorAll:query};
  const listeners=new Map();
  const document={
    title:'Synthetic ChatGPT composer',
    readyState:'complete',
    addEventListener(type,fn){listeners.set(type,fn);},
    dispatchEvent(event){
      if(event.type==='chat-orch:network-state-request') {
        listeners.get('chat-orch:network-state')?.({detail:{
          pendingRequests:0,lastNetworkActivityAt:Date.now()-3000,observedRequests:3,
        }});
      }
    },
    querySelectorAll:query,
    elementFromPoint(){return enabled;},
    createRange(){return {selectNodeContents(){}};},
    execCommand(command,_show,value){
      if(command==='delete')input.textContent='';
      if(command==='insertText')input.textContent+=value;
      if(command==='insertLineBreak')input.textContent+='\n';
      return true;
    },
    body:{get innerText(){return submittedText;}},
  };
  const selection={removeAllRanges(){},addRange(){}};
  const window={innerWidth:800,innerHeight:600,getSelection(){return selection;}};
  const chrome={runtime:{onMessage:{
    addListener(fn){listener=fn;},removeListener(){},
  },sendMessage:async(msg)=>{
    if(msg.type==='composer_send_click') throw new Error('Unexpected debugger Send request');
    return {ok:true,ready:true};
  }}};
  runInNewContext(source,{document,window,chrome,Event:class Event{constructor(type){this.type=type;}},
    location:{hostname:'chatgpt.com'},setTimeout,clearTimeout});
  assert.equal(typeof listener,'function');
  const result=await new Promise((resolve,reject)=>{
    const async=listener({cmd:'submit_manager_batch',text:prompt},{},resolve);
    if(async!==true)reject(new Error('expected asynchronous manager submit'));
  });
  assert.equal(result.submitted,true,JSON.stringify(result));
  assert.equal(disabledClicks,0);
  assert.equal(enabledClicks,1,'exactly one submission attempt');
  assert.equal(submittedText,prompt,'the correct complete prompt must be submitted');
});
