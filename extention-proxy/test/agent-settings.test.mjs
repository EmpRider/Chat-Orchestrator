import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DEFAULT_AGENT_SETTINGS, PROMPT_KEYS, normalizeAgentSettings, disabledAgentSettings} from '../agent-settings.mjs';

 test('all application-managed worker and Council prompts have editable defaults', () => {
  assert.deepEqual(PROMPT_KEYS, ['worker','ba','pm','tl','specialist','council_a','council_b','council_c','council_d','council_e','watchdog']);
  const cfg = normalizeAgentSettings({});
  for (const key of PROMPT_KEYS) assert.ok(cfg.systemPrompts[key].length > 4);
  assert.equal(cfg.maxWorkers, 10);
  assert.equal(cfg.useWorkerSystemPrompt, true);
  assert.equal(disabledAgentSettings().enabled, false);
});

test('profile settings accept user-edited role prompts without rewriting them', () => {
  const edited = normalizeAgentSettings({enabled: true, maxTasksPerHour: 42, systemPrompts: {ba: 'User BA instructions', worker: 'Do exactly this.'}});
  assert.equal(edited.maxTasksPerHour, 42);
  assert.equal(edited.systemPrompts.ba, 'User BA instructions');
  assert.equal(edited.systemPrompts.worker, 'Do exactly this.');
  assert.equal(edited.systemPrompts.pm, DEFAULT_AGENT_SETTINGS.systemPrompts.pm);
});

test('schema rejects unknown settings, forbidden auto-close, bad limits and malformed prompts', () => {
  for (const invalid of [
    {autoCloseWorkers: true}, {maxWorkers: 11}, {maxTasksPerHour: 0},
    {taskTimeoutMin: 61}, {enabled: 'yes'}, {systemPrompts: {unknown: 'x'}},
    {systemPrompts: {worker: ''}}, {systemPrompts: {ba: 'x'.repeat(8193)}},
  ]) assert.throws(() => normalizeAgentSettings(invalid));
});
