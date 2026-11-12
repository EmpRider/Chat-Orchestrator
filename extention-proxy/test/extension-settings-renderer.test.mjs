import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import {composeAgentPrompt,normalizeAgentSettings} from '../agent-settings.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const clone=(x)=>JSON.parse(JSON.stringify(x));

test('operation module editor persists edits independently and previews without submitting',async()=>{
 const initial=normalizeAgentSettings({});
 const items=new Map();
 const element=(id)=>{
  if(!items.has(id)){
   const handlers=new Map();
   items.set(id,{value:'',textContent:'',checked:false,disabled:false,hidden:false,open:false,
    style:{},children:[],className:'',src:'',title:'',
    addEventListener:(event,cb)=>handlers.set(event,cb),
    dispatch:(event)=>handlers.get(event)?.(),
    setAttribute(){},append(...a){this.children.push(...a);}});
  }
  return items.get(id);
 };
 const state={phase:'stopped',ngrokPhase:'stopped',ngrokAuthConfigured:false,
  ngrokError:'',error:'',extensionConnected:false,routeVerified:false,domain:'',
  publicPath:'/mcp',port:8799,profile:'qa',localWebSocketUrl:'ws://127.0.0.1:8799/bridge'};
 let persisted,previewed;
 const window={addEventListener(){},bridge:{
  status:async()=>state,onState(){},
  getAgentSettings:async()=>clone(initial),getDefaultAgentSettings:async()=>clone(initial),
  saveAgentSettings:async(value)=>{persisted=clone(value);return clone(value);},
  previewPrompt:async(value)=>{previewed=clone(value);return composeAgentPrompt(
   {...initial,promptModules:value.promptModules},value);},
 }};
 const document={getElementById:element,createElement:()=>({textContent:'',className:'',append(){}})};
 runInNewContext(readFileSync(path.join(root,'desktop','renderer.js'),'utf8'),
  {window,document,structuredClone:clone,console});
 await new Promise(resolve=>setImmediate(resolve));
 element('extension-settings-panel').open=true;
 element('extension-settings-panel').dispatch('toggle');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(element('agent-prompt-text').value,initial.promptModules.core);
 element('agent-prompt-text').value='Updated core instruction';
 element('agent-prompt-module').value='queue';
 element('agent-prompt-module').dispatch('change');
 assert.equal(element('agent-prompt-text').value,initial.promptModules.queue);
 element('agent-prompt-text').value='Custom queue guidance';
 element('agent-prompt-preview').dispatch('click');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(previewed.kind,'queue');
 assert.equal(previewed.promptModules.queue,'Custom queue guidance');
 assert.match(element('agent-prompt-preview-output').textContent,/Custom queue guidance/);
 assert.equal(element('agent-prompt-preview-output').hidden,false);
 element('agent-max-tasks').value='33';
 await element('agent-settings-save').dispatch('click');
 assert.equal(persisted.promptSchema,2);
 assert.equal(persisted.promptModules.core,'Updated core instruction');
 assert.equal(persisted.promptModules.queue,'Custom queue guidance');
 assert.equal(persisted.promptModules.delegation,initial.promptModules.delegation);
 assert.equal(persisted.maxTasksPerHour,33);
 const html=readFileSync(path.join(root,'..','extention','popup.html'),'utf8');
 assert.match(html,/id="serverUrl"/);
 assert.doesNotMatch(html,/id="token"/);
 assert.equal(html.includes('id="workerSystemPrompt"'),false);
});
