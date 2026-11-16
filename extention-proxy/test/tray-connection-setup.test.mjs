import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {runInNewContext} from 'node:vm';

const desktop=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../desktop');

test('D-062 unverified tray exit provides direct navigation to Connection Setup, not an unsafe close',()=>{
  const main=readFileSync(path.join(desktop,'main.mjs'),'utf8');
  const preload=readFileSync(path.join(desktop,'preload.cjs'),'utf8');
  assert.match(main,/if\(!managedBrowserEnrollment \|\| managedBrowserEnrollment\.browser!==managedBrowserSelection\)\{/);
  assert.match(main,/showBrowserVerificationRequired\(/);
  assert.match(main,/buttons:\['Open Connection Setup','Cancel'\]/);
  assert.match(main,/restoreWindow\(\);\s*if\(window && !window\.isDestroyed\(\)\)\s*window\.webContents\.send\('bridge:openConnectionSetup'\)/);
  assert.match(main,/const verified=await inspectCurrentManagedExtension\(\)/);
  assert.match(main,/matchesManagedEnrollment\(managedBrowserEnrollment,selection,verified\)/);
  assert.match(main,/if\(closureDispatched\)\{/,
    'a dispatched close with uncertain outcome must not be described as safe to retry');
  assert.match(preload,/onOpenConnectionSetup: \(callback\)/);
  assert.match(preload,/ipcRenderer\.on\('bridge:openConnectionSetup',listener\)/);
});

test('D-062 tray repair event opens Connections from any previous desktop view',()=>{
  const script=readFileSync(path.join(desktop,'navigation.js'),'utf8');
  const allViews=['overview','connections','agents','settings'];
  const nodes=new Map();
  const element=(id)=>{
    if(!nodes.has(id)){
      const events=new Map();
      nodes.set(id,{
        id,hidden:id==='view-connections',
        textContent:'',dataset:{},attributes:new Map(),scrollTop:17,
        classList:{toggle(){}},
        addEventListener(name,handler){events.set(name,handler);},
        setAttribute(name,value){this.attributes.set(name,value);},
        removeAttribute(name){this.attributes.delete(name);},
      });
    }
    return nodes.get(id);
  };
  const nav=allViews.map((view)=>{
    const node=element('nav-'+view);
    node.dataset.view=view;
    return node;
  });
  const document={
    getElementById:element,
    querySelectorAll(query){
      if(query==='[data-view]')return nav;
      if(query==='[data-open-view]')return [];
      throw Error('Unexpected selector: '+query);
    },
    querySelector(query){
      if(query==='.app-shell')return element('app-shell');
      throw Error('Unexpected selector: '+query);
    },
  };
  let repairAction;
  const window={bridge:{
    onState(){},
    onOpenConnectionSetup(callback){repairAction=callback;},
    status(){return new Promise(()=>{});}, // no startup-state auto-navigation
  }};
  runInNewContext(script,{window,document,Object,console});
  assert.equal(typeof repairAction,'function','navigation must subscribe to the trusted repair event');
  repairAction();
  assert.equal(element('view-connections').hidden,false);
  assert.equal(element('page-title').textContent,'Connections');
  for(const view of allViews.filter((x)=>x!=='connections'))
    assert.equal(element('view-'+view).hidden,true);
  assert.equal(element('app-shell').scrollTop,0);
  assert.equal(element('nav-connections').attributes.get('aria-current'),'page');
});
