import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const initial = {
  enabled: true, useWorkerSystemPrompt: true, maxWorkers: 10,
  maxTasksPerHour: 100, taskTimeoutMin: 60,
  systemPrompts: {worker:'Default worker',ba:'Default BA',pm:'Default PM',tl:'Default TL',
    specialist:'Default specialist',council_a:'Default A',council_b:'Default B',
    council_c:'Default C',council_d:'Default D',council_e:'Default E',watchdog:'Default watchdog'},
};
const clone = (x) => JSON.parse(JSON.stringify(x));

test('proxy settings editor persists edits to selected role without clobbering other prompts', async () => {
  const items = new Map();
  const element = (id) => {
    if (!items.has(id)) {
      const events = new Map();
      items.set(id, {
        value:'', textContent:'', className:'', checked:false, disabled:false, hidden:false,
        open:false, style:{}, src:'', title:'', children:[],
        addEventListener(type, handler) {events.set(type, handler);},
        dispatch(type) {return events.get(type)?.();},
        setAttribute() {}, append(...children) {this.children.push(...children);},
      });
    }
    return items.get(id);
  };
  const state = {phase:'stopped',ngrokPhase:'stopped',ngrokAuthConfigured:false,
    ngrokError:'',error:'',extensionConnected:false,routeVerified:false,domain:'',
    publicPath:'/mcp',port:8799,profile:'qa',localWebSocketUrl:'ws://127.0.0.1:8799/bridge'};
  let persisted;
  const window = {
    addEventListener() {},
    bridge: {
      status: async () => state, onState() {},
      getAgentSettings: async () => clone(initial),
      getDefaultAgentSettings: async () => clone(initial),
      saveAgentSettings: async (value) => {persisted=clone(value);return clone(value);},
    },
  };
  const document = {getElementById: element, createElement: () => ({textContent:'',className:'',append(){}})};
  const code = readFileSync(path.join(root,'desktop','renderer.js'),'utf8');
  runInNewContext(code,{window,document,structuredClone:clone,console});
  await new Promise((resolve) => setImmediate(resolve));
  element('extension-settings-panel').open = true;
  element('extension-settings-panel').dispatch('toggle');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(element('agent-prompt-text').value,'Default worker');
  element('agent-prompt-text').value='Edited worker system prompt';
  element('agent-prompt-role').value='council_b';
  element('agent-prompt-role').dispatch('change');
  element('agent-prompt-text').value='User security Council instructions';
  element('agent-max-tasks').value='33';
  await element('agent-settings-save').dispatch('click');
  assert.equal(persisted.systemPrompts.worker,'Edited worker system prompt');
  assert.equal(persisted.systemPrompts.council_b,'User security Council instructions');
  assert.equal(persisted.systemPrompts.pm,'Default PM');
  assert.equal(persisted.maxTasksPerHour,33);
  const html = readFileSync(path.join(root,'..','extention','popup.html'),'utf8');
  assert.ok(html.includes('id="serverUrl"') && html.includes('id="token"'));
  assert.equal(html.includes('id="workerSystemPrompt"'),false,
    'Extension popup must no longer edit app prompts');
});
