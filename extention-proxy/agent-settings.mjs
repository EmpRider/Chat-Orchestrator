// Profile-scoped extension behavior and editable application-owned prompt catalog.
// Connection URL and extension-only token remain in browser local storage.
export const DEFAULT_WORKER_PROMPT = [
  'You are a worker inside Chat Orchestrator. An authorized manager delegated the task below; return a precise result.',
  '',
  'Use AgentBridge for file, source, Saga MCP and project operations as available. Do not use the agent-team skill.',
  'Do not spawn other agents unless the manager explicitly requests delegation.',
  'Preserve workspace/project/task boundaries and follow the exact requested scope.',
  'For code work: report changed paths, actual test/build evidence, unverified gaps and safety holds.',
  'For Saga work: update the assigned board task before completion; include exact IDs and ask the manager to independently read back evidence.',
  'If a task is blocked, mark it clearly; never invent successful commits, tests, Saga effects or chat delivery ACKs.',
  'Never close this tab yourself. The manager owns closure after independent Saga verification.',
  'Complete tool use first; finish with a structured, concise result containing task status, evidence, and blockers.',
].join('\n');

export const ROLE_GUIDANCE = Object.freeze({
  ba: 'BA: maintain one active epic; verify Saga before task closure, own Watchdog checkpoints.',
  pm: 'PM: maintain one active epic, reuse Council seats, delegate and end turn; process all queued child results before status requests.',
  tl: 'TL: maintain one active major task; collect specialist evidence and independent review before handoff.',
  specialist: 'Specialist: implement only assigned file/function scope, then report evidence and gaps; keep tab open.',
  council_a: 'Council A / Systems: independent system design, immutable initial proposal and anonymous peer review.',
  council_b: 'Council B / Security: independent trust and authorization analysis; report falsifiers.',
  council_c: 'Council C / Architecture: independent integration and storage tradeoffs; report assumptions.',
  council_d: 'Council D / QA: independent verification criteria and failure scenarios.',
  council_e: 'Council E / Devil\'s advocate: independently challenge claims; do not silently revise frozen positions.',
  watchdog: 'BA Watchdog: independent read-only verification, clear PASS/CHANGES-NEEDED, no delegated release authority.',
});

export const PROMPT_KEYS = Object.freeze(['worker', ...Object.keys(ROLE_GUIDANCE)]);
export const DEFAULT_AGENT_SETTINGS = Object.freeze({
  enabled: true,
  useWorkerSystemPrompt: true,
  maxWorkers: 10,
  maxTasksPerHour: 100,
  taskTimeoutMin: 60,
  systemPrompts: Object.freeze({ worker: DEFAULT_WORKER_PROMPT, ...ROLE_GUIDANCE }),
});

const LIMITS = Object.freeze({maxWorkers: [1, 10], maxTasksPerHour: [1, 500], taskTimeoutMin: [1, 60]});
const FIELDS = new Set(['enabled', 'useWorkerSystemPrompt', ...Object.keys(LIMITS), 'systemPrompts']);

export function normalizeAgentSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid extension settings');
  if (Object.keys(input).some((key) => !FIELDS.has(key))) throw new Error('Unknown extension setting');
  const normalized = {
    enabled: input.enabled ?? DEFAULT_AGENT_SETTINGS.enabled,
    useWorkerSystemPrompt: input.useWorkerSystemPrompt ?? DEFAULT_AGENT_SETTINGS.useWorkerSystemPrompt,
  };
  for (const key of ['enabled', 'useWorkerSystemPrompt']) {
    if (typeof normalized[key] !== 'boolean') throw new Error('Invalid extension toggle: ' + key);
  }
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const val = input[key] ?? DEFAULT_AGENT_SETTINGS[key];
    if (!Number.isSafeInteger(val) || val < min || val > max) throw new Error('Invalid extension limit: ' + key);
    normalized[key] = val;
  }
  const prompts = input.systemPrompts ?? {};
  if (!prompts || typeof prompts !== 'object' || Array.isArray(prompts) ||
      Object.keys(prompts).some((key) => !PROMPT_KEYS.includes(key))) {
    throw new Error('Invalid system prompt catalog');
  }
  normalized.systemPrompts = {};
  for (const key of PROMPT_KEYS) {
    const value = prompts[key] ?? DEFAULT_AGENT_SETTINGS.systemPrompts[key];
    if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /\u0000/.test(value)) {
      throw new Error('Invalid system prompt: ' + key);
    }
    normalized.systemPrompts[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 96000) {
    throw new Error('Extension settings exceed storage limit');
  }
  return normalized;
}

export function disabledAgentSettings() {
  return {...normalizeAgentSettings({}), enabled: false};
}
