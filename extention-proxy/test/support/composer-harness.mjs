// Shared composer harness, extracted verbatim from chatgpt-composer.test.mjs
// so new scenario files can drive the real content.js without the original
// suite growing. Keep this in sync with that file's copy.
//
// The harness builds a node:vm context around the REAL extention/content.js,
// mocking only chrome.*, the DOM and the extension transport. Every assertion
// written against it is therefore an assertion about production code.
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

const source=readFileSync(new URL('../../../extention/content.js',import.meta.url),'utf8');

export function composerHarness({textarea,extraEnabledButton,neverEnableSend=false,
  networkBusyAfterInput=false,nativeSubmitButton=false,syntheticClickIgnored=false,
  nativeSubmitIgnored=false,modernExactSend=false,enableSendAfterMs=0,
  driftAfterInsert=null,renderedUserText=null,userTurnWrapperOnly=false,
  copyUserText=null,hideNewUserTurn=false,existingUserTurn=false,
  routeAfterSubmit=false,generatingAfterSubmit=false,existingConversation=false,
  modernUserBubbleOnly=false,hiddenComposer=false,authorizedManagedFocus=false,
  settleDelayMs=0,composerNeverAppears=false,composerVanishesAfterMs=0,
  hideComposerOnSettle=false,composerGoneAfterQueries=0}) {
  let messageHandler;
  let submitted='';
  let primaryClicks=0;
  let secondaryClicks=0;
  let nativeSubmissions=0;
  let trustedEvents=0;
  let networkChecks=0;
  const diagnostics=[];
  let form;
  let input;
  let driftScheduled=false;
  let composerGone=false;
  let composerQueries=0;
  if(composerVanishesAfterMs>0)
    setTimeout(()=>{composerGone=true;},composerVanishesAfterMs);
  const pageLocation={hostname:'chatgpt.com',
    pathname:existingConversation?'/c/'+randomUUID():'/'};
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
  const markSubmitted=()=>{
    submitted=textarea?input.value:input.textContent;
    if(textarea)input.value='';else input.textContent='';
    if(routeAfterSubmit)pageLocation.pathname='/c/'+randomUUID();
  };
  const displayedUserText=()=>typeof renderedUserText==='function'
    ? renderedUserText(submitted):submitted;
  const oldTurn={textContent:'Earlier unrelated user message',
    innerText:'Earlier unrelated user message',
    getAttribute:()=>null,querySelector:()=>({textContent:'Earlier unrelated user message'})};
  function sentTurn() {
    const rendered=displayedUserText();
    return {textContent:rendered,innerText:rendered,
      getAttribute:()=>null,querySelector:()=>(
        typeof copyUserText==='function'
          ? {textContent:copyUserText(submitted)} : {})};
  }
  const primary={
    disabled:textarea,offsetParent:{},getClientRects(){return [{}];},
    type:nativeSubmitButton?'submit':'button',
    getBoundingClientRect(){return {left:100,top:100,width:32,height:32};},
    contains(node){return node===this;},
    closest(){return null;},
    getAttribute(name){return name==='data-testid'?'send-button':
      name==='aria-label' && modernExactSend?'Send':null;},
    click(){primaryClicks++;if(!syntheticClickIgnored)markSubmitted();},
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
    if(selector==='button[data-testid="stop-button"]')
      return submitted && generatingAfterSubmit?[{tagName:'BUTTON'}]:[];
    if(selector==='#prompt-textarea') {
      // deterministic: the Nth query is the first composer-wait poll
      if(composerGoneAfterQueries>0 && ++composerQueries>=composerGoneAfterQueries)
        composerGone=true;
      return (composerNeverAppears||composerGone)?[]:[input];
    }
    if(selector==='button[data-testid="send-button"]')return [primary];
    if(selector==='button[aria-label*="send" i]' ||
       selector==='button[aria-label="Send message"]')
      return extraEnabledButton?[secondary]:[];
    if(selector==='[data-message-author-role="user"]')return [
      ...(existingUserTurn?[oldTurn]:[]),
      ...(submitted && !hideNewUserTurn && !userTurnWrapperOnly &&
        !modernUserBubbleOnly?[sentTurn()]:[])];
    if(selector==='[data-user-message-bubble="true"]')return submitted &&
      !hideNewUserTurn && modernUserBubbleOnly?[sentTurn()]:[];
    if(selector==='[data-testid^="conversation-turn-"]')
      return submitted && !hideNewUserTurn && userTurnWrapperOnly?[sentTurn()]:[];
    return [];
  }
  form={querySelectorAll:query,
    requestSubmit(button){
      assert.equal(button,modernExactSend?undefined:primary);
      nativeSubmissions++;
      if(!nativeSubmitIgnored)markSubmitted();
    },
  };
  const document={
    readyState:'complete',
    visibilityState:hiddenComposer?'hidden':'visible',
    querySelectorAll:query,
    elementFromPoint(x){return x>175?secondary:primary;},
    createRange(){return {selectNodeContents(){}};},
    execCommand(command,_show,value) {
      if(command==='delete'){
        if(textarea)input.value='';else input.textContent='';
      }
      if(command==='insertText'){
        if(textarea)input.value=value;else input.textContent+=value;
        if(!neverEnableSend) {
          if(enableSendAfterMs>0)setTimeout(()=>{primary.disabled=false;},enableSendAfterMs);
          else primary.disabled=false;
        }
        trustedEvents++;
        if(driftAfterInsert && !driftScheduled) {
          driftScheduled=true;
          setTimeout(()=>{
            if(driftAfterInsert==='whitespace' && !textarea)
              input.innerText=input.textContent.replace(/\n/g,' ');
            if(driftAfterInsert==='extra-rendered-space' && !textarea)
              input.innerText=input.textContent.replace(/\n/g,' ')
                .replace('</system_instructions>', ' </system_instructions>');
            if(driftAfterInsert==='mutation' && !textarea)
              input.innerText=input.textContent.replace('Pair ', 'P4ir ');
            if(driftAfterInsert==='replacement' && textarea) {
              const old=input;
              input={tagName:'DIV',textContent:old.value+'\n\n',
                innerText:old.value+'\n\n',offsetParent:{},
                getClientRects:()=>[{}],focus(){},
                closest(sel){return sel==='form'?form:null;}};
            }
          },20);
        }
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
    if(message.type==='worker_diagnostic'){
      diagnostics.push(message.diagnostic);return {ok:true};
    }
    if(message.type==='managed_agent_status_request')
      return {managed:false}; // Background status read is not network/composer readiness.
    if(message.type==='verify_managed_page_focus')
      return {ok:true,allowed:authorizedManagedFocus};
    if(message.type==='composer_send_click') throw new Error('DOM sending must not use CDP transport');
    // The page-settle round-trip is a real async window. CM-08 races it.
    if(message.type==='browser_page_settled') {
      if(settleDelayMs>0) await new Promise((r)=>setTimeout(r,settleDelayMs));
      if(hideComposerOnSettle) composerGone=true;
      // Still a transport round-trip; earlier tests count it as one.
      networkChecks++;
      return {ok:true,ready:true};
    }
    networkChecks++;
    if(networkBusyAfterInput && trustedEvents>0) {
      return {ok:false,ready:false,error:'background request still pending'};
    }
    return {ok:true,ready:true};
  }}};
  const recoveryScript=source.replace(/\}\)\(\);\s*$/,
    'window.__markQueueUncertain=()=>{completionReceiptUncertain=true;};})();');
  assert.notEqual(recoveryScript,source);
  runInNewContext(recoveryScript,{
    document,window,chrome,
    location:pageLocation,
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
    callParent:async(text,marker)=>new Promise((resolve,reject)=>{
      const r=messageHandler({cmd:'submit_parent_initialization',text,marker},{},resolve);
      if(r!==true)reject(new Error('Expected async Parent initialization receipt'));
    }),
    verify:async(taskId)=>new Promise((resolve)=>{
      messageHandler({cmd:'verify_sent_turn',taskId},{},resolve);
    }),
    info:()=>({primaryClicks,secondaryClicks,trustedEvents,submitted,
      nativeSubmissions,draft:textarea?input.value:input.textContent,networkChecks}),
    diagnostics:()=>diagnostics,
    setDraft(value){if(textarea)input.value=value;else input.textContent=value;},
    hideComposer(){composerGone=true;},
    dispatch(msg){return new Promise((resolve,reject)=>{
      const r=messageHandler(msg,{},resolve);
      if(r!==true)reject(new Error('Expected async response'));
    });},
    manuallySent(value){submitted=value;},
    markQueueUncertain(){window.__markQueueUncertain();},
    command(cmd,args={}){return new Promise((resolve)=>{
      messageHandler({cmd,...args},{},resolve);
    });},
  };
}
