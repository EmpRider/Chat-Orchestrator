import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DEFAULT_AGENT_SETTINGS,PROMPT_MODULE_KEYS,normalizeAgentSettings,replaceObsoletePromptSettings,disabledAgentSettings,composeAgentPrompt} from '../agent-settings.mjs';

test('role-agnostic operation modules have versioned defaults',()=>{
 const cfg=normalizeAgentSettings({});
 assert.equal(cfg.promptSchema,2);
 assert.deepEqual(Object.keys(cfg.promptModules),[...PROMPT_MODULE_KEYS]);
 assert.equal(cfg.maxWorkers,10);
 assert.equal(disabledAgentSettings().enabled,false);
 assert.ok(!('systemPrompts' in cfg));
 assert.ok(!('useWorkerSystemPrompt' in cfg));
 assert.ok(!PROMPT_MODULE_KEYS.includes('pm'));
});
test('profile edits are operation-specific and settings are preserved',()=>{
 const cfg=normalizeAgentSettings({maxTasksPerHour:42,promptModules:{queue:'Custom queue processing rule.'}});
 assert.equal(cfg.maxTasksPerHour,42);
 assert.equal(cfg.promptModules.queue,'Custom queue processing rule.');
 assert.equal(cfg.promptModules.task,DEFAULT_AGENT_SETTINGS.promptModules.task);
 assert.throws(()=>normalizeAgentSettings({promptModules:{ba:'role prompt'}}),/Invalid prompt/);
});
test('obsolete role catalog is reset once instead of reinterpreted',()=>{
 const old={enabled:true,maxTasksPerHour:42,systemPrompts:{worker:'WRONG ROLE',pm:'WRONG PM'},useWorkerSystemPrompt:true};
 const cfg=replaceObsoletePromptSettings(old);
 assert.equal(cfg.maxTasksPerHour,42);
 assert.equal(cfg.promptModules.core,DEFAULT_AGENT_SETTINGS.promptModules.core);
 assert.ok(!JSON.stringify(cfg).includes('WRONG ROLE'));
 assert.throws(()=>normalizeAgentSettings(old),/Unknown agent setting/);
});
test('reject unknown settings, invalid module names, limits and empty module content',()=>{
 for(const input of [{autoCloseWorkers:true},{maxWorkers:11},{maxTasksPerHour:0},{taskTimeoutMin:61},
  {enabled:'yes'},{promptSchema:1},{promptModules:{invalid:'a'}},{promptModules:{core:''}},
  {promptModules:{queue:'a'.repeat(8193)}}, {systemPrompts:{worker:'old'}}])
  assert.throws(()=>normalizeAgentSettings(input));
});
test('task and delegation prompts select only relevant modules and escape task text',()=>{
 const cfg=normalizeAgentSettings({});
 const ordinary=composeAgentPrompt(cfg,{kind:'task',task:'Check <script> & </task> snippet'});
 assert.match(ordinary,/<system_instructions>/);
 assert.match(ordinary,/<task>/);
 assert.match(ordinary,/&lt;script&gt;/);
 assert.match(ordinary,/&lt;\/task&gt;/);
 assert.doesNotMatch(ordinary,/@AgentBridge|@Worker Tool|BA:|PM:|Council A/);
 const work=composeAgentPrompt(cfg,{kind:'task',operation:'workspace',task:'Inspect files'});
 assert.match(work,/@AgentBridge/);
 assert.doesNotMatch(work,/@Worker Tool/);
 const delegate=composeAgentPrompt(cfg,{kind:'task',operation:'delegation',task:'Create child'});
 assert.match(delegate,/@Worker Tool/);
 assert.doesNotMatch(delegate,/@AgentBridge/);
});
test('queue prompts include only pertinent modules, not unrelated tools',()=>{
 const cfg=normalizeAgentSettings({});
 const batch='11111111-1111-4111-8111-111111111111';
 const q=composeAgentPrompt(cfg,{kind:'queue',batchId:batch,events:[{type:'STATUS_REQUEST',event_id:'e1',summary:'status'}]});
 assert.match(q,/<queue_batch/);
 assert.match(q,/acknowledg/i);
 assert.doesNotMatch(q,/@AgentBridge|@Worker Tool|spawn|workspace operations/);
 const loss=composeAgentPrompt(cfg,{kind:'queue',batchId:batch,events:[{type:'CHILD_TAB_LOST',
  event_id:'e2',task_id:'original-task',saved_url:'https://chatgpt.com/c/test',summary:'</system_instructions>'}]});
 assert.match(loss,/read_chat/);
 assert.match(loss,/get_result/);
 assert.match(loss,/saved_url/);
 assert.doesNotMatch(loss,/<\/system_instructions>.*<\/system_instructions>/s);
 assert.match(loss,/\\u003c\/system_instructions\\u003e/);
 assert.throws(()=>composeAgentPrompt(cfg,{kind:'queue',batchId:batch,events:[{type:'EVIL'}]}));
});
