import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';

test('coordination dashboard defaults to open registrations and can reveal saved history',()=>{
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const source=fs.readFileSync(path.join(root,'desktop','renderer.js'),'utf8');
  const start=source.indexOf('function renderCoordinationSnapshot(snapshot) {');
  const end=source.indexOf('async function perform(action, successMessage)',start);
  assert.ok(start>0 && end>start);
  const controls=new Map();
  function element(){
    return {
      textContent:'', hidden:false, listeners:new Map(), children:[],
      addEventListener(type,cb){this.listeners.set(type,cb);},
      append(child){this.children.push(child);},
      set textContent(value){this._text=String(value);this.children=[];},
      get textContent(){return this._text||'';},
    };
  }
  const document={
    getElementById(id){
      if(!controls.has(id))controls.set(id,element());
      return controls.get(id);
    },
    createElement:()=>element(),
  };
  runInNewContext(
    'const $=(id)=>document.getElementById(id);\n'+
    'let showSavedTabHistory=false; let lastCoordinationSnapshot=null;\n'+
    source.slice(start,end)+'\n'+
    'globalThis.renderSnapshot=renderCoordinationSnapshot;',
    {document,globalThis},
  );
  const snapshot={
    storageReady:true,phases:{QUEUED:2,UNCERTAIN:16},hiddenPending:18,
    browserTabs:{status:'observed',tabs:[{tabId:269061258,site:'chatgpt'}]},
    tabHierarchy:[
      {tabId:269061263,parentTabId:null,rootTabId:269061263,site:'chatgpt',presence:'not_open'},
      {tabId:269061070,parentTabId:null,rootTabId:269061070,site:'chatgpt',presence:'not_open'},
      {tabId:269061258,parentTabId:null,rootTabId:269061258,site:'chatgpt',presence:'open_unverified'},
    ],
    seats:[],queue:[],toolCalls:[],
  };
  const ctx={document};
  runInNewContext(
    'const $=(id)=>document.getElementById(id); let showSavedTabHistory=false;let lastCoordinationSnapshot=null;'+
    source.slice(start,end)+
    'globalThis.render=renderCoordinationSnapshot;',
    ctx,
  );
  ctx.render(snapshot);
  const hierarchy=controls.get('tab-hierarchy');
  assert.equal(hierarchy.children.length,1);
  assert.match(hierarchy.children[0].textContent,/269061258.*identity unverified/);
  assert.match(controls.get('tab-presence-summary').textContent,/1 open chat tab/);
  assert.equal(controls.get('toggle-tab-history').hidden,false);
  assert.match(controls.get('coordination-summary').textContent,/18 need manual reconciliation/);
  controls.get('toggle-tab-history').listeners.get('click')();
  assert.equal(hierarchy.children.length,3);
  assert.match(hierarchy.children[0].textContent,/269061263.*not currently open/);
  ctx.render({...snapshot,browserTabs:{status:'unavailable',tabs:[]}});
  assert.equal(hierarchy.children.length,3);
  assert.match(controls.get('tab-presence-summary').textContent,/unavailable/);
  assert.equal(controls.get('toggle-tab-history').hidden,true);
});
