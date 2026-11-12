import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {webcrypto} from 'node:crypto';

const source=readFileSync(new URL('../../extention/background.js',import.meta.url),'utf8')
  .replace(/\nconnect\(\);\s*$/,'\n');

function fixture() {
  const tabs=new Map([
    [101,{id:101,status:'complete',active:true,url:'https://chatgpt.com/c/one'}],
    [102,{id:102,status:'complete',active:true,url:'https://claude.ai/new'}],
    [103,{id:103,status:'complete',active:true,url:'https://gemini.google.com/app'}],
  ]);
  let updated,removed,runtimeHandler;
  let composerReady=true;
  let draftText='';
  class VirtualDate extends Date {
    static offset=0;
    static now(){return Date.now()+this.offset;}
  }
  const session={tasks:{example:{status:'done'}},workers:[201],taskLog:[Date.now()],
    proxySessionId:'00000000-0000-4000-8000-000000000001'};
  const local={serverUrl:'ws://127.0.0.1:8787/bridge',orchestratorTabId:101};
  const chrome={
    storage:{session:{async get(){return session;},async set(next){Object.assign(session,next);},
      async remove(keys){for(const key of keys)delete session[key];}},
      local:{async get(){return local;}},onChanged:{addListener(){}}},
    tabs:{
      async get(id){return tabs.get(id)||null;},
      async sendMessage(_id,msg) {
        const matches=!!draftText && draftText===msg.expectedText;
        return {ok:true,state:!composerReady?'loading':draftText?'draft':'idle',
          ready:composerReady&&(!draftText||matches),matchingDraft:matches,
          draftLength:draftText.length,documentReady:true};
      },
      onUpdated:{addListener(fn){updated=fn;}},
      onRemoved:{addListener(fn){removed=fn;}},
    },
    runtime:{id:'test-extension',onInstalled:{addListener(){}},
      onStartup:{addListener(){}},onMessage:{addListener(fn){runtimeHandler=fn;}},
      getURL(){return 'chrome-extension://test/workspace.html';}},
    alarms:{onAlarm:{addListener(){}},create(){}},
  };
  const ctx=createContext({chrome,URL,crypto:webcrypto,console,
    Date:VirtualDate,setTimeout,clearTimeout,setInterval,clearInterval,
    WebSocket:class {}});
  runInContext(source,ctx);
  return {
    settling:runInContext('pageSettling',ctx),
    resetSession:runInContext('resetSession',ctx),
    setConnectionGeneration:(value)=>runInContext(`connectionGeneration=${value}`,ctx),
    attest:(tabId)=>runInContext(`handleCall('attest_profile_manager',{tab_id:${tabId}})`,ctx),
    waitReady:runInContext('waitReady',ctx),
    async requestPageReady(tabId,timeoutMs=12000) {
      return new Promise(resolve=>runtimeHandler(
        {type:'browser_page_settled',timeoutMs},
        {id:chrome.runtime.id,frameId:0,tab:tabs.get(tabId)},resolve));
    },
    async changed(tabId,change) {
      const tab=tabs.get(tabId);
      Object.assign(tab,change);
      await updated(tabId,change,tab);
    },
    tabs,
    advance(ms){VirtualDate.offset+=ms;},
    setComposerReady(value){composerReady=value;},
    setDraft(value){draftText=value;},
    chrome,session,local,
  };
}

test('session reset clears worker state without changing saved connection settings',async()=>{
  const f=fixture();
  const oldId=f.session.browserSessionId;
  await f.resetSession();
  assert.equal(Object.keys(f.session.tasks).length,0);
  assert.equal(f.session.workers.length,0);
  assert.equal(f.session.taskLog.length,0);
  assert.equal(f.session.proxySessionId,undefined);
  assert.notEqual(f.session.browserSessionId,oldId);
  assert.equal(f.local.serverUrl,'ws://127.0.0.1:8787/bridge');
  assert.equal(f.local.orchestratorTabId,101);
});

test('manager attestation uses the active WebSocket generation after reconnect',async()=>{
  const f=fixture();
  f.setConnectionGeneration(3);
  const result=await f.attest(101);
  assert.equal(result.connection_generation,3);
  assert.equal(result.browser_session_id,f.session.browserSessionId);
});

test('ChatGPT, Claude and Gemini settle 2.5 seconds after document completion with no debugger',async()=>{
  const f=fixture();
  assert.equal(f.chrome.debugger,undefined,'no debugger API may be used');
  for(const id of [101,102,103]) {
    assert.equal((await f.settling.snapshot(id)).ready,false);
  }
  f.advance(2300);
  for(const id of [101,102,103])
    assert.equal((await f.settling.snapshot(id)).ready,false);
  f.advance(300);
  for(const id of [101,102,103]) {
    const result=await f.settling.waitForReady(id,500);
    assert.equal(result.ready,true);
    assert.equal(result.documentComplete,true);
    assert.equal(result.settledMs>=2500,true);
  }
});

test('page load and URL changes invalidate the old settling interval',async()=>{
  const f=fixture();
  await f.settling.snapshot(101);
  f.advance(3000);
  assert.equal((await f.settling.snapshot(101)).ready,true);
  await f.changed(101,{status:'loading'});
  assert.equal((await f.settling.snapshot(101)).ready,false);
  f.advance(10000);
  assert.equal((await f.settling.snapshot(101)).ready,false,
    'loading pages never become ready solely due to timeout');
  await f.changed(101,{status:'complete'});
  assert.equal((await f.settling.snapshot(101)).ready,false);
  f.advance(2500);
  assert.equal((await f.settling.snapshot(101)).ready,true);
  await f.changed(101,{status:'loading',url:'https://chatgpt.com/c/other'});
  await f.changed(101,{status:'complete'});
  assert.equal((await f.settling.snapshot(101)).ready,false);
});

test('stable composer and active tab are still required after 2.5 second settling',async()=>{
  const f=fixture();
  await f.settling.snapshot(102);
  f.advance(2500);
  f.tabs.get(102).active=false;
  await assert.rejects(f.waitReady(102,null,650),/stably ready/);
  f.tabs.get(102).active=true;
  f.setComposerReady(false);
  await assert.rejects(f.waitReady(102,null,650),/stably ready/);
  f.setComposerReady(true);
  await f.waitReady(102,null,2600);
});

test('matching task draft passes readiness, unrelated draft does not',async()=>{
  const f=fixture();
  const prompt='<task>test the tool</task>';
  await f.settling.snapshot(101);
  f.advance(2500);
  f.setDraft(prompt);
  await f.waitReady(101,prompt,2600);
  await assert.rejects(f.waitReady(101,'wrong prompt',2600),
    /different unsent draft/,'a mismatched draft fails promptly without a 45-second wait');
});

test('service-worker restart starts a new settling interval',async()=>{
  const f1=fixture();
  await f1.settling.snapshot(103);
  f1.advance(5000);
  assert.equal((await f1.settling.snapshot(103)).ready,true);
  const f2=fixture();
  assert.equal((await f2.settling.snapshot(103)).ready,false);
});

test('readiness request authenticates source and completes after the timer',async()=>{
  const f=fixture();
  const initial=f.settling.snapshot(101);
  await initial;
  f.advance(2500);
  const status=await f.requestPageReady(101);
  assert.equal(status.ok,true);
  assert.equal(status.ready,true);
});
