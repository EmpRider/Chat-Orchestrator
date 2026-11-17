import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const content=readFileSync(new URL('../../extention/content.js',import.meta.url),'utf8');
const inspectable=content.replace(/\}\)\(\);\s*$/,
  'window.__gapTest={q,A,verifiedNewUserTurn,exactSubmittedText,enforceChatgptModelPreferences,verifyChatgptModelPreferences,chatgptEffortSnapshot};})();');
assert.notEqual(inspectable,content);

function editor(extra={}) {
  return {tagName:'DIV',textContent:'',offsetParent:{},getClientRects(){return [{}];},
    getAttribute(){return null;},closest(){return null;},...extra};
}

function harness({bySelector={},byId={},preferences={},authorized=true,KeyboardEvent=class {
  constructor(key,options){this.type=key;Object.assign(this,options);}
}}={}) {
  const window={};
  const document={
    readyState:'complete',body:{innerText:''},
    getElementById(id){return byId[id]||null;},
    querySelectorAll(selector){
      if(Object.hasOwn(bySelector,selector))return bySelector[selector]||[];
      return [...new Set(selector.split(',').flatMap(part=>bySelector[part.trim()]||[]))];
    },
  };
  const chrome={storage:{local:{get:async()=>preferences}},
    runtime:{onMessage:{addListener(){},removeListener(){}},
      sendMessage:async msg=>msg.type==='managed_chatgpt_model_preferences'
        ? {ok:authorized,model:preferences.chatgptModelLabel||'',
            effort:preferences.chatgptReasoningEffort||''}
        : {managed:false}}};
  runInNewContext(inspectable,{
    document,window,chrome,KeyboardEvent,
    location:{hostname:'chatgpt.com',pathname:'/'},
    setTimeout,clearTimeout,console,
  });
  return window.__gapTest;
}

// DOM fixtures mirror upstream's independently rolling trigger, model view and
// slider variants. They intentionally do not depend on a Playwright/CDP runtime.
function modelPickerHarness({model='GPT-6 Sol',displayModel=model,effort='High',variant='inline',
  labels=['Instant','Medium','High','Extra High','Pro'],initial=0,
  locked=[],clickMoves=true,announcement=true,extraTicks=0}={}) {
  let open=false,advanced=false,position=initial,checked=false,clicks=0;
  const element=(extra={})=>Object.defineProperties({
    offsetParent:{},getClientRects(){return [{}];},
    getAttribute(){return null;},closest(){return null;},
  },Object.getOwnPropertyDescriptors(extra));
  const trigger=element({tagName:'BUTTON',disabled:false,
    getAttribute(name){return name==='aria-controls'?'picker':
      name==='aria-expanded'?String(open):null;},
    click(){clicks++;open=!open;if(!open)advanced=false;},
    dispatchEvent(event){if(event.key==='Escape'){open=false;advanced=false;}},
  });
  const form={contains(node){return node===trigger;}};
  const input=element({tagName:'DIV',textContent:'PRE-EXISTING DRAFT',
    closest(selector){return selector==='form'?form:null;}});
  const status=element({get textContent(){
    return announcement?labels[position]+', '+(position+1)+' of '+labels.length+'.':'';
  }});
  const item=element({
    getAttribute(name){return name==='aria-describedby'?'effort-status':null;},
    focus(){},dispatchEvent(){},
  });
  const slider=element({
    closest(selector){return selector==='[role="menuitem"]'?item:null;},
    getAttribute(name){return {
      'aria-valuemin':'0','aria-valuemax':String(labels.length-1),
      'aria-valuenow':String(position),
    }[name]??null;},
  });
  const ticks=Array.from({length:labels.length+extraTicks},(_,index)=>element({
    getAttribute(name){return name==='data-locked'?
      (locked.includes(index)?'true':null):null;},
    click(){if(clickMoves && !locked.includes(index))position=index;},
  }));
  const surface=element({
    hasAttribute(name){return name==='data-model-picker-power-slider';},
    querySelector(selector){return selector.includes('data-orientation')?{}:null;},
    querySelectorAll(selector){return selector==='[role="slider"]'?[slider]:
      selector==='[data-selected]'?ticks:[];},
    closest(selector){return selector==='[role="menuitem"]'?item:null;},
  });
  const row=element({innerText:displayModel,textContent:displayModel,
    getAttribute(name){return name==='aria-checked'?String(checked):null;},
    click(){checked=true;},
  });
  const view=element({getAttribute(name){return name==='data-model-picker-view'?
    (advanced?'advanced':'simple'):null;},
    querySelectorAll(selector){return selector==='[data-model-picker-view-toggle="true"]'?[toggle]:[];},
  });
  const toggle=element({textContent:displayModel,
    click(){advanced=true;},
  });
  const menu=element({
    get offsetParent(){return open?{}:null;},
    getClientRects(){return open?[{}]:[];},
    querySelector(selector){if(selector==='[data-model-picker-view]')return view;
      if(selector.includes('[data-model-picker-power-slider]'))return surface;
      return null;},
    querySelectorAll(selector){if(selector==='[role="menuitemradio"]')
      return open&&advanced?[row]:[];
      if(selector==='[data-model-picker-view-toggle="true"]')return [toggle];
      if(selector.includes('[data-model-picker-power-slider]'))return open?[surface]:[];
      return [];},
  });
  const triggerSelector=variant==='neutral'
    ? 'button[aria-haspopup="menu"][data-tone="neutral"]'
    : 'button[data-composer-navigation-target="reasoning"][data-selected-reasoning-effort][aria-haspopup="menu"]';
  const gap=harness({
    preferences:{chatgptModelLabel:model,chatgptReasoningEffort:effort},
    bySelector:{'#prompt-textarea':[input],[triggerSelector]:[trigger],'[role="menu"]':[menu]},
    byId:{picker:menu,'effort-status':status},
  });
  return {gap,input,trigger,row,get state(){return {open,position,checked,clicks};},
    changePosition(index){position=index;},changeModel(){checked=false;}};
}

test('ChatGPT detects the observed ProseMirror editor without #prompt-textarea',()=>{
  const prose=editor();
  const gap=harness({bySelector:{'.ProseMirror[contenteditable="true"]':[prose]}});
  assert.equal(gap.q(gap.A.input),prose);
});

test('two visible ChatGPT composers fail closed instead of picking the first',()=>{
  const first=editor(),second=editor();
  const gap=harness({bySelector:{'#prompt-textarea':[first],
    '.ProseMirror[contenteditable="true"]':[second]}});
  assert.equal(gap.q(gap.A.input),null);
});

test('nested prompt wrapper and ProseMirror resolve to the actual inner editor',()=>{
  const child=editor();
  const parent=editor({contains(el){return el===child;}});
  const gap=harness({bySelector:{'#prompt-textarea':[parent],
    '.ProseMirror[contenteditable="true"]':[child]}});
  assert.equal(gap.q(gap.A.input),child);
});

test('authenticated receipt requires exact new user turn, same route and exact text',()=>{
  const gap=harness();
  const before={conversationId:'c1',userCount:2,assistantCount:2};
  const after={conversationId:'c1',userCount:3,assistantCount:2,
    lastUserText:'first second'};
  assert.equal(gap.verifiedNewUserTurn(before,after,'first\nsecond'),true);
  assert.equal(gap.verifiedNewUserTurn(before,{...after,userCount:2},'first\nsecond'),false);
  assert.equal(gap.verifiedNewUserTurn(before,{...after,conversationId:'c2'},'first\nsecond'),false);
  assert.equal(gap.verifiedNewUserTurn(before,{...after,lastUserText:'first DIFFERENT'},'first\nsecond'),false);
});

test('unconfigured model preference leaves the ChatGPT picker untouched',async()=>{
  const gap=harness();
  await gap.enforceChatgptModelPreferences('test');
});

test('a configured model requires an authorized managed Parent/Child',async()=>{
  const gap=harness({preferences:{chatgptModelLabel:'GPT-6'},authorized:false});
  await assert.rejects(gap.enforceChatgptModelPreferences('test'),/not authorized/);
});

test('model picker and effort readback must both verify before sending',async()=>{
  let menuOpen=false,checked=false,position=2;
  const trigger=editor({tagName:'BUTTON',disabled:false,
    click(){menuOpen=!menuOpen;}});
  const radio=editor({innerText:'GPT-6',
    getAttribute(name){return name==='aria-checked'?(checked?'true':'false'):null;},
    click(){checked=true;}});
  const slider=editor({getAttribute(name){return {
    'aria-valuemin':'0','aria-valuemax':'2','aria-valuenow':String(position),
  }[name]||null;}});
  const power=editor({querySelector(){return slider;},focus(){},
    hasAttribute(name){return name==='data-reasoning-slider';},
    dispatchEvent(ev){
      if(ev.key==='ArrowLeft')position--;
      if(ev.key==='ArrowRight')position++;
    }});
  const bySelector={
    '[role="menuitemradio"]':[],
    '[data-reasoning-slider]':[],
    'button[aria-label="Select ChatGPT model"]':[trigger],
  };
  const documentHandler=new Proxy(bySelector,{get(target,name){
    if(name==='[role="menuitemradio"]')return menuOpen?[radio]:[];
    if(name==='[data-reasoning-slider]')return menuOpen?[power]:[];
    return target[name];
  }});
  const gap=harness({bySelector:documentHandler,
    preferences:{chatgptModelLabel:'GPT-6',chatgptReasoningEffort:'Medium'}});
  await gap.enforceChatgptModelPreferences('test');
  assert.equal(checked,true);
  assert.equal(position,1);
});

for(const variant of ['inline','neutral']){
  test('modern '+variant+' picker selects 5-tick Extra High and verifies after closing',async()=>{
    const h=modelPickerHarness({variant,effort:'Extra High'});
    const prefs=await h.gap.enforceChatgptModelPreferences('test');
    assert.deepEqual({...prefs},{model:'GPT-6 Sol',effort:'Extra High'});
    assert.equal(h.state.position,3);
    assert.equal(h.state.checked,true);
    assert.equal(h.state.open,false);
    assert.equal(h.input.textContent,'PRE-EXISTING DRAFT');
    await h.gap.verifyChatgptModelPreferences(prefs,'test');
    assert.equal(h.state.position,3);
    assert.equal(h.state.open,false);
  });
}

test('pre-Send verification rejects a model changed after attachment',async()=>{
  const h=modelPickerHarness({effort:'High'});
  const prefs=await h.gap.enforceChatgptModelPreferences('test');
  h.changeModel();
  await assert.rejects(h.gap.verifyChatgptModelPreferences(prefs,'test'),
    /model change was not verified/);
  assert.equal(h.input.textContent,'PRE-EXISTING DRAFT');
});

test('pre-Send verification rejects an effort changed after attachment',async()=>{
  const h=modelPickerHarness({effort:'High'});
  const prefs=await h.gap.enforceChatgptModelPreferences('test');
  h.changePosition(1);
  await assert.rejects(h.gap.verifyChatgptModelPreferences(prefs,'test'),
    /did not retain the requested thinking effort/);
  assert.equal(h.input.textContent,'PRE-EXISTING DRAFT');
});

test('locked effort is rejected without changing the composer draft',async()=>{
  const h=modelPickerHarness({effort:'High',locked:[2]});
  await assert.rejects(h.gap.enforceChatgptModelPreferences('test'),
    /unavailable or locked/);
  assert.equal(h.state.position,0);
  assert.equal(h.input.textContent,'PRE-EXISTING DRAFT');
});

test('incomplete slider ticks are rejected instead of guessing availability',async()=>{
  const h=modelPickerHarness({extraTicks:1});
  await assert.rejects(h.gap.enforceChatgptModelPreferences('test'),
    /ticks did not match/);
  assert.equal(h.state.position,0);
});

test('ignored tick clicks and synthetic keyboard do not count as selection',async()=>{
  const h=modelPickerHarness({clickMoves:false});
  await assert.rejects(h.gap.enforceChatgptModelPreferences('test'),
    /did not move exactly one step/);
  assert.equal(h.state.position,0);
});

test('six-position Default picker maps High to index 1, not fixed index 2',async()=>{
  const h=modelPickerHarness({model:'Default',effort:'High',
    labels:['Instant','High','Light','Medium','Extra High','Pro']});
  const prefs=await h.gap.enforceChatgptModelPreferences('test');
  assert.equal(h.state.position,1);
  await h.gap.verifyChatgptModelPreferences(prefs,'test');
  assert.equal(h.state.open,false);
});

test('six-position Default picker maps Pro to index 5',async()=>{
  const h=modelPickerHarness({model:'Default',effort:'Pro',
    labels:['Instant','High','Light','Medium','Extra High','Pro']});
  await h.gap.enforceChatgptModelPreferences('test');
  assert.equal(h.state.position,5);
});

test('six-position GPT-6 Astra picker maps Pro preference to announced Max',async()=>{
  const h=modelPickerHarness({model:'GPT-6 Astra',effort:'Pro',
    labels:['Light','Medium','High','Extra High','Max','Ultra']});
  await h.gap.enforceChatgptModelPreferences('test');
  assert.equal(h.state.position,4);
});

test('generic GPT-6 Pro selects the explicit Astra row, as upstream does',async()=>{
  const h=modelPickerHarness({model:'GPT-6',displayModel:'GPT-6 Astra',effort:'Pro',
    labels:['Light','Medium','High','Extra High','Max','Ultra']});
  const prefs=await h.gap.enforceChatgptModelPreferences('test');
  assert.equal(h.state.position,4);
  await h.gap.verifyChatgptModelPreferences(prefs,'test');
});

test('explicit GPT-6 Sol plus Pro is rejected instead of silently using Astra',async()=>{
  const h=modelPickerHarness({model:'GPT-6 Sol',effort:'Pro'});
  await assert.rejects(h.gap.enforceChatgptModelPreferences('test'),
    /Requested ChatGPT model is unavailable/);
  assert.equal(h.state.position,0);
});

test('unknown six-position picker fails closed without an inferred effort order',async()=>{
  const h=modelPickerHarness({model:'GPT-6 Sol',effort:'High',
    labels:['Instant','High','Light','Medium','Extra High','Pro']});
  await assert.rejects(h.gap.enforceChatgptModelPreferences('test'),
    /unavailable or locked/);
  assert.equal(h.state.position,0);
});

test('missing six-position effort announcement fails verification',async()=>{
  const h=modelPickerHarness({model:'Default',effort:'High',announcement:false,
    labels:['Instant','High','Light','Medium','Extra High','Pro']});
  await assert.rejects(h.gap.enforceChatgptModelPreferences('test'),
    /no verifiable mode announcement/);
});

test('authenticated conversation snapshot counts only normalized user and assistant turns',async()=>{
  const reader=readFileSync(new URL('../../extention/structured-reader.js',import.meta.url),'utf8');
  const transcript={conversation:{turns:[
    {role:'human',blocks:[{kind:'text',text:'Before'}]},
    {role:'assistant',blocks:[{kind:'text',text:'Earlier reply'}]},
    {role:'human',blocks:[{kind:'text',text:'New task'}]},
  ]}};
  const self={__exporter:{
    chatgptApi:{parseConvIdFromUrl:()=> 'id-1',
      getAccessToken:async()=> 'private-token',
      fetchConversation:async(_id,token)=>{
        assert.equal(token,'private-token');
        return transcript;
      }},
    chatgptNormalize:{normalize:raw=>raw},
  }};
  runInNewContext(reader,{self,document:{title:'Test'},
    location:{href:'https://chatgpt.com/c/anything'}});
  const snapshot=await self.__chatOrchStructuredReader.snapshotChatgptTurns();
  assert.equal(snapshot.conversationId,'id-1');
  assert.equal(snapshot.userCount,2);
  assert.equal(snapshot.assistantCount,1);
  assert.equal(snapshot.lastUserText,'New task');
  assert.equal(snapshot.lastAssistantText,'Earlier reply');
  assert.doesNotMatch(JSON.stringify(snapshot),/private-token/);
});

test('Parent initialization has an explicit shared FIFO for its idle check and Send',()=>{
  const source=readFileSync(new URL('../../extention/background.js',import.meta.url),'utf8');
  const branch=source.split("case 'create_pairing_offer':")[1]
    ?.split("case 'set_orchestrator':")[0];
  assert.ok(branch,'Parent pairing branch must exist');
  assert.match(branch,/sent=await serializePromptStartup\(async\(\)=>\{/);
  assert.match(branch,/await confirmTabIdle\(active.id\);/);
  assert.match(branch,/cmd:'submit_parent_initialization'/);
});
