import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';

const source=readFileSync(new URL('../../extention/content.js',import.meta.url),'utf8');

function composerHarness({textarea,extraEnabledButton,neverEnableSend=false,
  networkBusyAfterInput=false,nativeSubmitButton=false,syntheticClickIgnored=false,
  nativeSubmitIgnored=false,
  driftAfterInsert=null,renderedUserText=null,userTurnWrapperOnly=false,
  copyUserText=null,hideNewUserTurn=false,existingUserTurn=false,
  routeAfterSubmit=false,generatingAfterSubmit=false,existingConversation=false,
  modernUserBubbleOnly=false}) {
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
    getAttribute(name){return name==='data-testid'?'send-button':null;},
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
    if(selector==='#prompt-textarea')return [input];
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
      assert.equal(button,primary);
      nativeSubmissions++;
      if(!nativeSubmitIgnored)markSubmitted();
    },
  };
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
        if(driftAfterInsert && !driftScheduled) {
          driftScheduled=true;
          setTimeout(()=>{
            if(driftAfterInsert==='whitespace' && !textarea)
              input.innerText=input.textContent.replace(/\n/g,' ');
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
    if(message.type==='composer_send_click') throw new Error('DOM sending must not use CDP transport');
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
    manuallySent(value){submitted=value;},
    markQueueUncertain(){window.__markQueueUncertain();},
    command(cmd,args={}){return new Promise((resolve)=>{
      messageHandler({cmd,...args},{},resolve);
    });},
  };
}


function batch() {
  return '<queue_batch>{"batch_id":"'+randomUUID()+'","events":[]}</queue_batch>';
}

test('skipped notification clears only the exact stranded draft and resets uncertainty',async()=>{
  const h=composerHarness({textarea:false,extraEnabledButton:false});
  const text=batch(),batchId=JSON.parse(text.match(/<queue_batch>(.*?)<\/queue_batch>/)[1]).batch_id;
  h.setDraft(text);h.markQueueUncertain();
  assert.equal((await h.command('observe_state')).state,'uncertain');
  const before=await h.command('inspect_manager_batch',{batchId,text});
  assert.equal(before.verified,false);
  assert.equal(before.matchingDraft,true);
  const cleared=await h.command('clear_manager_batch_draft',{batchId,text});
  assert.equal(cleared.cleared,true);
  assert.equal(h.info().draft,'');
  assert.equal(h.info().primaryClicks,0,'operator Skip must never click Send');
  assert.equal((await h.command('observe_state')).state,'idle');
});

test('skip leaves unrelated user draft untouched and never treats it as delivery',async()=>{
  const h=composerHarness({textarea:false,extraEnabledButton:false});
  const text=batch(),batchId=JSON.parse(text.match(/<queue_batch>(.*?)<\/queue_batch>/)[1]).batch_id;
  h.setDraft('A personal note which must not be removed');h.markQueueUncertain();
  const result=await h.command('clear_manager_batch_draft',{batchId,text});
  assert.equal(result.cleared,false);
  assert.equal(result.draftPresent,true);
  assert.equal(h.info().draft,'A personal note which must not be removed');
  assert.equal((await h.command('observe_state')).state,'draft');
});

test('manually sent batch is confirmed only from a user turn, then clears uncertainty',async()=>{
  const h=composerHarness({textarea:false,extraEnabledButton:false,modernUserBubbleOnly:true});
  const text=batch(),batchId=JSON.parse(text.match(/<queue_batch>(.*?)<\/queue_batch>/)[1]).batch_id;
  h.markQueueUncertain();h.manuallySent(text);
  const observed=await h.command('inspect_manager_batch',{batchId,text});
  assert.equal(observed.verified,true);
  const confirmed=await h.command('confirm_manager_batch_sent',{batchId});
  assert.equal(confirmed.verified,true);
  assert.equal((await h.command('observe_state')).state,'idle');
  assert.equal(h.info().primaryClicks,0,'manual Send cannot trigger automatic duplicate');
});

test('explicit retry submits the exact retained batch once, and rejects other drafts', {
  timeout:10000,
},async()=>{
  const text=batch(),batchId=JSON.parse(text.match(/<queue_batch>(.*?)<\/queue_batch>/)[1]).batch_id;
  const h=composerHarness({textarea:false,extraEnabledButton:false,modernUserBubbleOnly:true});
  h.setDraft(text);h.markQueueUncertain();
  const outcome=await h.command('retry_manager_draft',{batchId,text});
  assert.equal(outcome.submitted,true,JSON.stringify(outcome));
  assert.equal(h.info().primaryClicks,1);
  assert.equal((await h.command('observe_state')).state,'idle');
  const repeat=await h.command('retry_manager_draft',{batchId,text});
  assert.notEqual(repeat.submitted,true);
  assert.equal(h.info().primaryClicks,1);
  const wrong=composerHarness({textarea:false,extraEnabledButton:false});
  wrong.setDraft('Different user message');
  const rejected=await wrong.command('retry_manager_draft',{batchId,text});
  assert.equal(rejected.reason,'EXACT_DRAFT_REQUIRED');
  assert.equal(wrong.info().primaryClicks,0);
});

test('rendered ChatGPT message format changes do not reject a uniquely marked sent task', {
  timeout:10000,
},async()=>{
  const h=composerHarness({textarea:false,extraEnabledButton:false,
    userTurnWrapperOnly:true,
    renderedUserText:(raw)=>'Displayed rich-text task #'+(/"batch_id":"([^"]+)"/.exec(raw)?.[1]||'')});
  const text=batch();
  const marker=/"batch_id":"([^"]+)"/.exec(text)[1];
  const sent=await h.call(text);
  assert.equal(sent.submitted,true,JSON.stringify(sent));
  assert.equal(h.info().primaryClicks,1);
  assert.ok(h.diagnostics().some((d)=>d.step==='submission_confirmation_poll' &&
    d.matchedMarker===true),'task UUID in user-message wrapper is positive submission evidence');
  const verified=await h.verify(marker);
  assert.equal(verified.ok,true);
  assert.equal(verified.verified,true);
  const unrelated=await h.verify(randomUUID());
  assert.equal(unrelated.ok,true);
  assert.equal(unrelated.verified,false);
});

test('modern data-user-message-bubble (no legacy roles) confirms submitted child task', {
  timeout:10000,
},async()=>{
  const h=composerHarness({textarea:false,extraEnabledButton:false,
    modernUserBubbleOnly:true});
  const text=batch();
  const result=await h.call(text);
  assert.equal(result.submitted,true,JSON.stringify(result));
  assert.equal(h.info().primaryClicks,1);
  assert.equal(h.diagnostics().find((event)=>
    event.step==='submission_confirmation_evidence')?.evidenceType,
    'TASK_MARKER_IN_USER_TURN');
});

test('submission detects a full user-message-copy even when ChatGPT truncates the visible bubble', {
  timeout:10000,
},async()=>{
  const h=composerHarness({textarea:false,extraEnabledButton:false,
    userTurnWrapperOnly:true,
    renderedUserText:()=> 'This message is collapsed by the UI',
    copyUserText:(raw)=>raw});
  const text=batch();
  const marker=/"batch_id":"([^"]+)"/.exec(text)[1];
  const result=await h.call(text);
  assert.equal(result.submitted,true,JSON.stringify(result));
  assert.equal(h.info().primaryClicks,1);
  assert.equal(h.diagnostics().find((event)=>
    event.step==='submission_confirmation_evidence')?.evidenceType,
    'TASK_MARKER_IN_USER_TURN');
  assert.equal((await h.verify(marker)).verified,true,
    'the read-only verifier must use the same complete message projection');
});

test('a new user turn and cleared extension-owned composer confirm a collapsed Child prompt', {
  timeout:10000,
},async()=>{
  const h=composerHarness({textarea:false,extraEnabledButton:false,
    userTurnWrapperOnly:true,
    renderedUserText:()=> 'Collapsed preview hides task UUID and full text'});
  const result=await h.call(batch());
  assert.equal(result.submitted,true,JSON.stringify(result));
  assert.equal(h.info().primaryClicks,1,'only one Send activation is allowed');
  const evidence=h.diagnostics().find((event)=>
    event.step==='submission_confirmation_evidence');
  assert.equal(evidence?.evidenceType,'NEW_USER_TURN_AND_CLEARED_COMPOSER');
  assert.equal(evidence?.draftCleared,true);
  assert.equal(evidence?.newUserTurnCount,1);
});

test('an old user turn and empty composer alone cannot falsely confirm a submitted prompt', {
  timeout:16000,
},async()=>{
  const h=composerHarness({textarea:false,extraEnabledButton:false,
    existingUserTurn:true,hideNewUserTurn:true});
  const result=await h.call(batch());
  assert.equal(result.uncertain,true,
    'without a newly observed user turn, the same Send is unverified');
  assert.equal(h.info().primaryClicks,1,
    'uncertainty must never automatically click Send a second time');
  assert.equal(h.diagnostics().some((event)=>
    event.step==='submission_confirmation_evidence'),false);
});

test('real-world zero user selectors: new conversation route plus generation confirms first Child Send', {
  timeout:10000,
},async()=>{
  const h=composerHarness({textarea:false,extraEnabledButton:false,
    hideNewUserTurn:true,routeAfterSubmit:true,generatingAfterSubmit:true});
  const result=await h.call(batch());
  assert.equal(result.submitted,true,JSON.stringify(result));
  assert.equal(h.info().primaryClicks,1,'Send must fire only once');
  const proof=h.diagnostics().find((event)=>
    event.step==='submission_confirmation_evidence');
  assert.equal(proof?.evidenceType,'NEW_CONVERSATION_ROUTE_AND_GENERATION');
  assert.equal(proof?.newUserTurnCount,0,'no user-message selectors were available');
  assert.equal(proof?.draftCleared,true);
  assert.equal(proof?.newConversationRoute,true);
});

test('generating with an empty composer but NO new conversation is still unverified', {
  timeout:16000,
},async()=>{
  const h=composerHarness({textarea:false,extraEnabledButton:false,
    hideNewUserTurn:true,generatingAfterSubmit:true});
  const result=await h.call(batch());
  assert.equal(result.uncertain,true,'generation by itself must not count as a submitted user message');
  assert.equal(h.info().primaryClicks,1,'no automatic duplicate Send');
  assert.equal(h.diagnostics().some((event)=>
    event.step==='submission_confirmation_evidence'),false);
});

test('a changed route without generation cannot confirm an otherwise invisible submission', {
  timeout:16000,
},async()=>{
  const h=composerHarness({textarea:false,extraEnabledButton:false,
    hideNewUserTurn:true,routeAfterSubmit:true,generatingAfterSubmit:false});
  const result=await h.call(batch());
  assert.equal(result.uncertain,true,'route change alone must not count as confirmed delivery');
  assert.equal(h.info().primaryClicks,1,'do not replay the side effect');
});

test('existing chat route changes cannot activate first-message fallback without a user turn', {
  timeout:16000,
},async()=>{
  const h=composerHarness({textarea:false,extraEnabledButton:false,
    hideNewUserTurn:true,existingConversation:true,
    routeAfterSubmit:true,generatingAfterSubmit:true});
  const result=await h.call(batch());
  assert.equal(result.uncertain,true,'existing conversation must not use the new-chat-only proof');
  assert.equal(h.info().primaryClicks,1);
});

test('textarea uses native browser editing to enable controlled composer before sending', {timeout:10000},async()=>{
  const h=composerHarness({textarea:true,extraEnabledButton:false});
  const text=batch();
  const result=await h.call(text);
  assert.equal(result.submitted,true,JSON.stringify(result));
  assert.deepEqual(h.info(),{primaryClicks:1,secondaryClicks:0,trustedEvents:1,
    submitted:text,nativeSubmissions:0,draft:'',networkChecks:1});
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

test('completion notification clicks the enabled Send arrow when requestSubmit would strand the draft', {
  timeout:10000,
},async()=>{
  const h=composerHarness({textarea:false,extraEnabledButton:false,
    nativeSubmitButton:true,nativeSubmitIgnored:true});
  const text=batch();
  const outcome=await h.call(text);
  assert.equal(outcome.submitted,true,JSON.stringify(outcome));
  assert.equal(h.info().primaryClicks,1,'notification must activate the Send control once');
  assert.equal(h.info().nativeSubmissions,0,
    'an ignored form requestSubmit must not strand a queue notification');
  assert.equal(h.info().submitted,text);
  assert.equal(h.info().draft,'');
  assert.equal(h.diagnostics().find((event)=>event.step==='send_activation')?.method,
    'button_click');
});

test('explicit retry of a retained completion batch activates Send once, never requestSubmit', {
  timeout:10000,
},async()=>{
  const h=composerHarness({textarea:false,extraEnabledButton:false,
    nativeSubmitButton:true,nativeSubmitIgnored:true});
  const text=batch();
  const batchId=JSON.parse(text.match(/<queue_batch>(.*?)<\/queue_batch>/)[1]).batch_id;
  h.setDraft(text);
  h.markQueueUncertain();
  const result=await h.command('retry_manager_draft',{batchId,text});
  assert.equal(result.submitted,true,JSON.stringify(result));
  assert.equal(h.info().nativeSubmissions,0);
  assert.equal(h.info().primaryClicks,1);
  assert.equal(h.info().draft,'');
  const duplicate=await h.command('retry_manager_draft',{batchId,text});
  assert.notEqual(duplicate.submitted,true,'sent batch must never be retried');
  assert.equal(h.info().primaryClicks,1);
});

test('Parent setup uses native ChatGPT form submission when isolated-world button.click would be ignored', {
  timeout:10000,
},async()=>{
  const h=composerHarness({textarea:false,extraEnabledButton:false,
    nativeSubmitButton:true,syntheticClickIgnored:true});
  const marker=randomUUID();
  const text='<chat_orchestrator_parent_setup>Pair using code '+marker+
    '</chat_orchestrator_parent_setup>';
  const outcome=await h.callParent(text,marker);
  assert.equal(outcome.submitted,true,JSON.stringify(outcome));
  const info=h.info();
  assert.equal(info.primaryClicks,0,'must not issue a duplicate synthetic click');
  assert.equal(info.nativeSubmissions,1,'submit form exactly once');
  assert.equal(info.submitted,text);
  assert.equal(info.draft,'');
});

test('non-submit ChatGPT buttons continue to use a single click without submitting the form', {
  timeout:10000,
},async()=>{
  const h=composerHarness({textarea:false,extraEnabledButton:false,
    nativeSubmitButton:false});
  const result=await h.call(batch());
  assert.equal(result.submitted,true);
  assert.equal(h.info().nativeSubmissions,0);
  assert.equal(h.info().primaryClicks,1);
});

test('live TEXTAREA to DIV hydration is reported as an editor replacement before Send', {
  timeout:10000,
},async()=>{
  const h=composerHarness({textarea:true,extraEnabledButton:false,
    driftAfterInsert:'replacement'});
  const code=randomUUID();
  const prompt='<chat_orchestrator_parent_setup>\nPair '+code+
    '\n</chat_orchestrator_parent_setup>';
  const result=await h.callParent(prompt,code);
  assert.equal(result.uncertain,true);
  assert.equal(h.info().primaryClicks,0,'must not click a changed draft');
  const diagnostic=h.diagnostics();
  const summary=diagnostic.find((entry)=>entry.step==='submission_failure_summary');
  assert.ok(summary,'one final diagnostic identifies the failed gate');
  assert.equal(summary.errorCode,'COMPOSER_DRAFT_MISMATCH');
  assert.equal(summary.failureClass,'EDITOR_REPLACED_AFTER_INSERT');
  assert.equal(summary.submitAttempted,false);
  assert.notEqual(summary.originalEditorId,summary.currentEditorId);
  assert.ok(diagnostic.some((entry)=>entry.step==='composer_state_transition' &&
    entry.originalEditorId!==entry.currentEditorId));
  assert.ok(summary.traceId,'all events from the one Send attempt carry a correlation ID');
  assert.ok(diagnostic.filter((e)=>e.step==='composer_projection_snapshot')
    .every((e)=>e.traceId===summary.traceId));
  assert.doesNotMatch(JSON.stringify(diagnostic),new RegExp(code),
    'pairing codes must not be present in diagnostic events');
});

test('Parent setup sends once when ChatGPT maps exactly two line breaks to spaces', {
  timeout:10000,
},async()=>{
  const h=composerHarness({textarea:false,extraEnabledButton:false,
    driftAfterInsert:'whitespace'});
  const code=randomUUID();
  const prompt='<chat_orchestrator_parent_setup>\nPair '+code+
    '\n</chat_orchestrator_parent_setup>';
  const result=await h.callParent(prompt,code);
  assert.equal(result.submitted,true,JSON.stringify(result));
  assert.equal(h.info().primaryClicks,1,'Send is attempted exactly once');
  assert.equal(h.info().submitted,prompt);
  const accepted=h.diagnostics().find((entry)=>
    entry.step==='linebreak_normalization_accepted');
  assert.ok(accepted,'the narrow exception must be observable');
  assert.equal(accepted.originalNewlines,2);
  assert.equal(accepted.currentNewlines,0);
  assert.equal(accepted.exactNewlinesToSpaces,true);
  assert.equal(h.diagnostics().some((entry)=>entry.step==='submission_failure_summary'),false);
});

test('Parent setup still refuses a changed character even when the button is enabled', {
  timeout:10000,
},async()=>{
  const h=composerHarness({textarea:false,extraEnabledButton:false,
    driftAfterInsert:'mutation'});
  const code=randomUUID();
  const prompt='<chat_orchestrator_parent_setup>\nPair '+code+
    '\n</chat_orchestrator_parent_setup>';
  const result=await h.callParent(prompt,code);
  assert.equal(result.uncertain,true);
  assert.equal(h.info().primaryClicks,0);
  const failure=h.diagnostics().find((entry)=>entry.step==='submission_failure_summary');
  assert.equal(failure?.failureClass,'PROMPT_CONTENT_CHANGED');
});

test('Child/queue prompts allow only exact linebreak-to-space React normalization', {
  timeout:10000,
},async()=>{
  const h=composerHarness({textarea:false,extraEnabledButton:false,
    driftAfterInsert:'whitespace'});
  const text=batch().replace('{"batch_id"', '{\n"batch_id"');
  const result=await h.call(text);
  assert.equal(result.submitted,true,JSON.stringify(result));
  assert.equal(h.info().primaryClicks,1);
  assert.ok(h.diagnostics().some((entry)=>entry.step==='linebreak_normalization_accepted'));
  assert.equal(h.diagnostics().some((entry)=>entry.step==='submission_failure_summary'),false);
});

test('Child/queue prompts still refuse any non-whitespace mutation before Send', {
  timeout:10000,
},async()=>{
  const h=composerHarness({textarea:false,extraEnabledButton:false,
    driftAfterInsert:'mutation'});
  const text=batch().replace('<queue_batch>','<queue_batch>\nPair ');
  const result=await h.call(text);
  assert.equal(result.submitted,undefined);
  assert.equal(h.info().primaryClicks,0);
  const failure=h.diagnostics().find((entry)=>entry.step==='submission_failure_summary');
  assert.equal(failure?.failureClass,'PROMPT_CONTENT_CHANGED');
});
