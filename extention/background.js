// Service worker: WebSocket bridge to the local MCP server + tab/task manager.

const SITES = {
  chatgpt: { newChatUrl: 'https://chatgpt.com/' },
  claude: { newChatUrl: 'https://claude.ai/new' },
};
const TAB_PATTERNS = [
  'https://claude.ai/*',
  'https://chatgpt.com/*',
  'https://chat.openai.com/*',
  'https://gemini.google.com/*',
];

// Sent once, at the top of the first message of every NEW worker chat (spawn_worker).
// Editable in the popup. Follow-ups (send_to_tab) do not repeat it.
const DEFAULT_WORKER_PROMPT = [
  'You are a worker agent inside a multi-agent system. An orchestrator has delegated the task below to you, and your final message is returned to it automatically.',
  '',
  'Instructions:',
  '1. If the task needs it, you may read files, write files, or use any other tool through the AgentBridge plugin.',
  '2. If you need to spawn a sub-agent or do anything else with other workers, use the Worker Tool plugin.',
  '3. Before starting the work, read both plugins (AgentBridge and Worker Tool) and understand their capabilities: review the tools each one provides and what they can do.',
  '4. Before starting the work, also read the agent-team skill that is installed for you and understand it. Then measure the work you have to do: if the task is deep or large, use the agent-team skill in the way that fits the task; if it is small, just do it directly. Whether to use the skill is entirely your own decision, so do not ask the user for confirmation or verification.',
  '',
  'Rules:',
  '- Use tools only when they are needed, and only spawn a sub-agent when it is truly necessary. Give any sub-agent a self-contained task.',
  '- Finish all tool use first. Your last message must contain only the final result for the orchestrator, with no preamble about this setup.',
  '- If a plugin is unavailable, say so briefly in your result and continue as best you can.',
  '- Make decisions yourself (which tools, whether to use the agent-team skill) and never stop to ask the user for approval.',
].join('\n');

const DEFAULTS = {
  serverUrl: 'ws://localhost:8787/bridge',
  token: '',
  enabled: true, // kill switch
  autoCloseWorkers: false, // default: the ORCHESTRATOR closes workers with close_worker (spawn_worker auto_close=true overrides per worker)
  useWorkerSystemPrompt: true,
  workerSystemPrompt: DEFAULT_WORKER_PROMPT,
  maxWorkers: 4,
  maxTasksPerHour: 30,
  taskTimeoutMin: 10,
  orchestratorTabId: null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getConfig = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) });

function siteOfUrl(url = '') {
  if (/^https:\/\/claude\.ai\//.test(url)) return 'claude';
  if (/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url)) return 'chatgpt';
  if (/^https:\/\/gemini\.google\.com\//.test(url)) return 'gemini';
  return null;
}

// ------------------------------------------------------------------ state
let tasks = {}; // taskId -> task
let workers = []; // tab ids opened by spawn_worker
let taskLog = []; // timestamps, for rate limiting
const waiters = {}; // taskId -> [resolve]

const stateReady = (async () => {
  const s = await chrome.storage.session.get(['tasks', 'workers', 'taskLog']);
  tasks = s.tasks || {};
  workers = s.workers || [];
  taskLog = s.taskLog || [];
})();

const saveState = () => chrome.storage.session.set({ tasks, workers, taskLog });

function summarize(t) {
  const out = {
    task_id: t.id,
    tab_id: t.tabId,
    site: t.site,
    status: t.status,
    elapsed_seconds: Math.round(((t.finishedAt || Date.now()) - t.startedAt) / 1000),
  };
  if (t.status === 'done') out.result = t.result;
  if (t.status === 'done' && t.autoClose) {
    out.note = 'Worker window was closed automatically (auto_close was enabled). It cannot receive follow-ups.';
  } else if (t.status === 'done') {
    out.note = `Worker window is still open (tab_id ${t.tabId}). You can send a follow-up with send_to_tab; when you no longer need this worker, call close_worker with tab_id ${t.tabId}.`;
  }
  if (t.status === 'failed') {
    out.note = `Worker window left open for inspection (tab_id ${t.tabId}). Call close_worker with this tab_id when done.`;
  }
  if (t.status === 'failed') out.error = t.error;
  if (t.status === 'running') out.note = 'Still running. Call get_result again with wait_seconds.';
  return out;
}

function finishTask(id, patch) {
  const t = tasks[id];
  if (!t || t.status !== 'running') return;
  Object.assign(t, patch, { finishedAt: Date.now() });
  saveState();
  (waiters[id] || []).forEach((r) => r());
  delete waiters[id];
  if (t.status === 'done' && t.autoClose) setTimeout(() => closeWorkerTab(t.tabId), 1500);
}

function waitTask(id, ms) {
  return new Promise((resolve) => {
    const t = tasks[id];
    if (!t || t.status !== 'running' || ms <= 0) return resolve();
    (waiters[id] ||= []).push(resolve);
    setTimeout(resolve, ms);
  });
}

// -------------------------------------------------------------- guardrails
async function guard({ newWorker = false } = {}) {
  await stateReady;
  const cfg = await getConfig();
  if (!cfg.enabled) throw new Error('Kill switch is ON in the extension popup. Automation is disabled.');

  const hourAgo = Date.now() - 3600 * 1000;
  taskLog = taskLog.filter((ts) => ts > hourAgo);
  if (taskLog.length >= cfg.maxTasksPerHour) {
    throw new Error(`Rate limit: ${cfg.maxTasksPerHour} tasks per hour reached. Raise it in the popup if intended.`);
  }
  if (newWorker) {
    const alive = [];
    for (const id of workers) {
      try {
        await chrome.tabs.get(id);
        alive.push(id);
      } catch {}
    }
    workers = alive;
    if (workers.length >= cfg.maxWorkers) {
      throw new Error(`Max ${cfg.maxWorkers} worker tabs are already open. Close one with close_worker first.`);
    }
  }
  return cfg;
}

// ------------------------------------------------------------------ tabs
async function listTabs() {
  await stateReady;
  const cfg = await getConfig();
  const tabs = await chrome.tabs.query({ url: TAB_PATTERNS });
  return tabs.map((t) => ({
    tab_id: t.id,
    window_id: t.windowId,
    site: siteOfUrl(t.url),
    title: t.title,
    url: t.url,
    active: t.active,
    role: t.id === cfg.orchestratorTabId ? 'orchestrator' : workers.includes(t.id) ? 'worker' : 'other',
  }));
}

async function resolveTab(ref) {
  const cfg = await getConfig();
  if (typeof ref === 'number') return ref;
  if (typeof ref === 'string' && /^\d+$/.test(ref)) return Number(ref);
  const wantActive = ref === 'active';
  if (!wantActive && cfg.orchestratorTabId != null) {
    try {
      await chrome.tabs.get(cfg.orchestratorTabId);
      return cfg.orchestratorTabId;
    } catch {}
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: TAB_PATTERNS });
  if (active) return active.id;
  throw new Error('No orchestrator/active chat tab found. Mark one with "Set this tab as orchestrator" in the popup.');
}

// Tabs opened before the extension was (re)loaded have no live content script.
// Inject it on demand instead of asking the user to refresh the page.
async function injectContentScript(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const site = siteOfUrl(tab.url);
  const target = { tabId };
  const base = 'reference-exporter/';
  if (site === 'chatgpt' && /^https:\/\/chatgpt\.com\//.test(tab.url)) {
    await chrome.scripting.executeScript({ target, world: 'MAIN', files: [`${base}adapters/chatgpt/hook-main.js`] });
    await chrome.scripting.executeScript({ target, files: [
      `${base}adapters/chatgpt/hook-iso.js`, `${base}core/utils.js`,
      `${base}adapters/chatgpt/api.js`, `${base}adapters/chatgpt/genui.js`,
      `${base}adapters/chatgpt/normalize.js`, 'structured-reader.js', 'content.js',
    ] });
  } else if (site === 'claude') {
    await chrome.scripting.executeScript({ target, files: [
      `${base}core/utils.js`, `${base}adapters/claude/api.js`,
      `${base}adapters/claude/widgets.js`, `${base}adapters/claude/normalize.js`,
      'structured-reader.js', 'content.js',
    ] });
  } else if (site === 'gemini') {
    await chrome.scripting.executeScript({ target, world: 'MAIN', files: [`${base}adapters/gemini/hook-main.js`] });
    await chrome.scripting.executeScript({ target, files: [
      `${base}adapters/gemini/hook-iso.js`, `${base}core/utils.js`,
      `${base}adapters/gemini/api.js`, `${base}adapters/gemini/normalize.js`,
      'structured-reader.js', 'content.js',
    ] });
  } else {
    await chrome.scripting.executeScript({ target, files: ['content.js'] });
  }
}

async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: TAB_PATTERNS });
  for (const t of tabs) {
    try {
      await injectContentScript(t.id);
    } catch {}
  }
}

async function tabMessage(tabId, msg) {
  let firstErr;
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    firstErr = e;
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error(`Tab ${tabId} no longer exists (it was closed).`);
  if (!siteOfUrl(tab.url)) throw new Error(`Tab ${tabId} is not a supported chat page.`);

  // The script is missing or orphaned: (re)inject it, then retry a few times.
  let injectErr = null;
  try {
    await injectContentScript(tabId);
  } catch (e) {
    injectErr = e;
  }
  let lastErr = firstErr;
  for (let i = 0; i < 6; i++) {
    await sleep(300);
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `Tab ${tabId} is not reachable. Injection ${injectErr ? 'failed: ' + injectErr.message : 'ran but got no reply'}; ` +
      `last error: ${lastErr?.message || lastErr}. Reload the extension and refresh that tab once.`
  );
}

async function waitReady(tabId, timeoutMs = 45000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { cmd: 'ping' });
      if (r?.ready) return;
    } catch {}
    await sleep(700);
  }
  throw new Error('Worker tab never became ready. Are you logged in on that site in this browser profile?');
}

// ------------------------------------------------------------------ tasks
function buildWorkerPrompt(cfg, task, contextTranscript) {
  const parts = [];
  if (cfg.useWorkerSystemPrompt && String(cfg.workerSystemPrompt || '').trim()) {
    parts.push(`<system_instructions>\n${cfg.workerSystemPrompt.trim()}\n</system_instructions>`);
  }
  if (contextTranscript) {
    parts.push(
      `<orchestrator_context note="Transcript of the orchestrator's conversation, for reference only">\n${contextTranscript}\n</orchestrator_context>`
    );
  }
  parts.push(`<task>\n${task}\n</task>`);
  return parts.join('\n\n');
}

async function closeWorkerTab(tabId) {
  await stateReady;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) {
    await chrome.windows.remove(tab.windowId).catch(() => chrome.tabs.remove(tabId).catch(() => {}));
  }
  workers = workers.filter((id) => id !== tabId);
  await saveState();
}

async function startTask(tabId, site, text, waitSecs, cfg, autoClose = false) {
  const id = crypto.randomUUID().slice(0, 8);
  const task = { id, tabId, site, status: 'running', startedAt: Date.now(), autoClose };
  tasks[id] = task;
  taskLog.push(Date.now());
  await saveState();

  const r = await tabMessage(tabId, { cmd: 'run_prompt', taskId: id, text, timeoutMs: cfg.taskTimeoutMin * 60000 });
  if (!r?.ok) {
    finishTask(id, { status: 'failed', error: r?.error || 'Tab refused the task' });
  } else if (waitSecs > 0) {
    await waitTask(id, Math.min(waitSecs, 50) * 1000);
  }
  return summarize(tasks[id]);
}

// ------------------------------------------------------------------ calls
async function handleCall(method, p) {
  await stateReady;
  switch (method) {
    case 'list_tabs':
      return listTabs();

    case 'spawn_worker': {
      const cfg = await guard({ newWorker: true });
      const site = SITES[p.site];
      if (!site) throw new Error(`Unknown site "${p.site}". Use "chatgpt" or "claude".`);

      let contextTranscript = '';
      if (p.share_context_from) {
        const srcId = await resolveTab(p.share_context_from);
        const chat = await tabMessage(srcId, { cmd: 'read_chat' });
        contextTranscript = chat.transcript;
      }
      const prompt = buildWorkerPrompt(cfg, p.task, contextTranscript);

      const win = await chrome.windows.create({ url: site.newChatUrl, focused: false, width: 1100, height: 850 });
      const tabId = win.tabs[0].id;
      workers.push(tabId);
      await saveState();
      await waitReady(tabId);
      // Closing is normally the orchestrator's job (close_worker). auto_close=true opts in per worker.
      const autoClose = p.keep_open === true ? false : p.auto_close ?? cfg.autoCloseWorkers;
      return startTask(tabId, p.site, prompt, p.wait_seconds || 0, cfg, autoClose);
    }

    case 'send_to_tab': {
      const cfg = await guard();
      if (p.tab_id === cfg.orchestratorTabId) {
        throw new Error('Refusing to send into the orchestrator tab (would create a feedback loop).');
      }
      const tab = await chrome.tabs.get(p.tab_id).catch(() => null);
      const site = siteOfUrl(tab?.url);
      if (!site || site === 'gemini') throw new Error(`Tab ${p.tab_id} does not support send_to_tab.`);
      return startTask(p.tab_id, site, p.text, p.wait_seconds || 0, cfg);
    }

    case 'get_result': {
      const t = tasks[p.task_id];
      if (!t) throw new Error(`Unknown task_id "${p.task_id}" (browser session may have restarted).`);
      if (p.wait_seconds > 0) await waitTask(t.id, Math.min(p.wait_seconds, 50) * 1000);
      return summarize(tasks[t.id]);
    }

    case 'read_chat': {
      await guard();
      const tabId = await resolveTab(p.tab_id ?? 'orchestrator');
      return tabMessage(tabId, {
        cmd: 'read_chat', lastN: p.last_n,
        includeReasoning: p.include_reasoning,
        includeAttachments: p.include_attachments,
      });
    }

    case 'close_worker': {
      const tab = await chrome.tabs.get(p.tab_id).catch(() => null);
      if (!tab) return { closed: p.tab_id, already_closed: true };
      if (!workers.includes(p.tab_id)) throw new Error('That tab was not opened by spawn_worker; refusing to close it.');
      await closeWorkerTab(p.tab_id);
      return { closed: p.tab_id };
    }

    default:
      throw new Error(`Unknown method "${method}"`);
  }
}

// ------------------------------------------------------------ WebSocket
let ws = null;
let wsState = 'disconnected';
let keepTimer = null;
let reconnectTimer = null;
let attempts = 0;

async function connect() {
  const cfg = await getConfig();
  clearTimeout(reconnectTimer);
  if (!cfg.token) {
    wsState = 'no token';
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  wsState = 'connecting';
  const sep = cfg.serverUrl.includes('?') ? '&' : '?';
  try {
    ws = new WebSocket(`${cfg.serverUrl}${sep}token=${encodeURIComponent(cfg.token)}`);
  } catch (err) {
    wsState = `error: ${err.message}`;
    return scheduleReconnect();
  }

  ws.onopen = () => {
    wsState = 'connected';
    attempts = 0;
    clearInterval(keepTimer);
    // Regular traffic also keeps the MV3 service worker alive.
    keepTimer = setInterval(() => ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'ping' })), 20000);
  };

  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type !== 'call') return;
    const socket = ws;
    try {
      const result = await handleCall(msg.method, msg.params || {});
      socket.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result }));
    } catch (err) {
      socket.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: String(err?.message || err) }));
    }
  };

  ws.onclose = () => {
    wsState = 'disconnected';
    clearInterval(keepTimer);
    scheduleReconnect();
  };
  ws.onerror = () => {};
}

function scheduleReconnect() {
  attempts += 1;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, Math.min(15000, 1000 * attempts));
}

function reconnectNow() {
  try {
    ws?.close();
  } catch {}
  ws = null;
  attempts = 0;
  return connect();
}

// ------------------------------------------------------------- lifecycle
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
  connect();
  injectIntoOpenTabs();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
  connect();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'keepalive' && (!ws || ws.readyState !== WebSocket.OPEN)) connect();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.serverUrl || changes.token)) reconnectNow();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await stateReady;
  workers = workers.filter((id) => id !== tabId);
  for (const t of Object.values(tasks)) {
    if (t.tabId === tabId) finishTask(t.id, { status: 'failed', error: 'Tab was closed before the task finished' });
  }
  saveState();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    await stateReady;
    switch (msg?.type) {
      case 'task_done':
        finishTask(
          msg.taskId,
          msg.ok ? { status: 'done', result: msg.text } : { status: 'failed', error: msg.error }
        );
        sendResponse({ ok: true });
        break;
      case 'popup_status': {
        const cfg = await getConfig();
        sendResponse({
          wsState,
          cfg,
          workers,
          running: Object.values(tasks).filter((t) => t.status === 'running').length,
        });
        break;
      }
      case 'set_orchestrator':
        await chrome.storage.local.set({ orchestratorTabId: msg.tabId });
        sendResponse({ ok: true });
        break;
      case 'reconnect':
        await reconnectNow();
        sendResponse({ ok: true });
        break;
      case 'close_all_workers': {
        for (const id of [...workers]) {
          try {
            await handleCall('close_worker', { tab_id: id });
          } catch {}
        }
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false });
    }
  })();
  return true;
});

connect();
