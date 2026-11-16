import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../../extention/managed-focus-main.js',import.meta.url),'utf8');

function harness(){
  const native={hidden:true,visibilityState:'hidden',focus:false};
  function events(target){
    const listeners=new Map();
    target.addEventListener=(name,handler)=>{
      if(!listeners.has(name))listeners.set(name,[]);
      listeners.get(name).push(handler);
    };
    target.fire=(name)=>{
      const event={type:name,stopped:false,
        stopPropagation(){this.stopped=true;},
        stopImmediatePropagation(){this.stopped=true;}};
      for(const handler of listeners.get(name)||[]){
        if(event.stopped)break;
        handler(event);
      }
      return event;
    };
    target.listenerCount=(name)=>(listeners.get(name)||[]).length;
  }
  class FakeDocument{
    hasFocus(){return native.focus;}
  }
  for(const name of ['hidden','webkitHidden','visibilityState','webkitVisibilityState']){
    Object.defineProperty(FakeDocument.prototype,name,{
      configurable:true,
      get(){return name.toLowerCase().includes('hidden')
        ?native.hidden:native.visibilityState;},
    });
  }
  const document=new FakeDocument(),window={};
  events(document);events(window);
  const context={document,window,Document:FakeDocument,Symbol,Map,Reflect,Object};
  return {native,document,window,run:()=>runInNewContext(source,context),
    control:()=>document[Symbol.for('chat-orchestrator.managed-focus.v2')]};
}

test('early MAIN-world shim behaves natively until managed tab is explicitly authorized',()=>{
  const h=harness();
  h.run();
  assert.equal(h.document.hidden,true);
  assert.equal(h.document.visibilityState,'hidden');
  assert.equal(h.document.webkitHidden,true);
  assert.equal(h.document.webkitVisibilityState,'hidden');
  assert.equal(h.document.hasFocus(),false);
  let visibilityEvents=0,blurEvents=0,pageHideEvents=0;
  h.document.addEventListener('visibilitychange',()=>visibilityEvents++);
  h.window.addEventListener('blur',()=>blurEvents++);
  h.window.addEventListener('pagehide',()=>pageHideEvents++);
  h.document.fire('visibilitychange');
  h.window.fire('blur');
  assert.equal(visibilityEvents,1,'unregistered tabs must see actual events');
  assert.equal(blurEvents,1);
  assert.equal(h.control().setEnabled(true),true);
  assert.equal(h.document.hidden,false);
  assert.equal(h.document.visibilityState,'visible');
  assert.equal(h.document.webkitHidden,false);
  assert.equal(h.document.webkitVisibilityState,'visible');
  assert.equal(h.document.hasFocus(),true);
  h.document.fire('visibilitychange');
  h.window.fire('blur');
  h.window.fire('pagehide');
  assert.equal(visibilityEvents,1,'managed tab hides focus-loss events from the page');
  assert.equal(blurEvents,1);
  assert.equal(pageHideEvents,1,'navigation cleanup must never be suppressed');
  assert.equal(h.control().setEnabled(false),false);
  assert.equal(h.document.hidden,true);
  assert.equal(h.document.visibilityState,'hidden');
  assert.equal(h.document.hasFocus(),false);
  h.document.fire('visibilitychange');
  h.window.fire('blur');
  assert.equal(visibilityEvents,2);
  assert.equal(blurEvents,2);
});

test('bootstrap is idempotent and disabled behavior tracks native focus changes',()=>{
  const h=harness();
  h.run();
  h.run();
  assert.equal(h.document.listenerCount('visibilitychange'),1);
  assert.equal(h.window.listenerCount('blur'),1);
  h.native.hidden=false;h.native.visibilityState='visible';h.native.focus=true;
  assert.equal(h.document.hidden,false);
  assert.equal(h.document.visibilityState,'visible');
  assert.equal(h.document.hasFocus(),true);
  h.control().setEnabled(true);
  h.native.hidden=true;h.native.visibilityState='hidden';h.native.focus=false;
  assert.equal(h.document.hidden,false);
  assert.equal(h.document.hasFocus(),true);
  h.control().setEnabled(false);
  assert.equal(h.document.hidden,true);
  assert.equal(h.document.hasFocus(),false);
});

test('old D-052 shim is restored before the new original getters are captured',()=>{
  const h=harness(),key=Symbol.for('chat-orchestrator.managed-visibility.v1');
  Object.defineProperty(h.document,'hidden',{configurable:true,get:()=>false});
  Object.defineProperty(h.document,'visibilityState',{configurable:true,get:()=> 'visible'});
  Object.defineProperty(h.document,key,{configurable:true,
    value:{hidden:undefined,state:undefined}});
  h.run();
  assert.equal(h.document.hidden,true);
  assert.equal(h.document.visibilityState,'hidden');
  assert.equal(h.document[key],undefined);
  h.control().setEnabled(true);
  assert.equal(h.document.hidden,false);
});
