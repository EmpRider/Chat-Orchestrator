// Service worker: WebSocket bridge to the local MCP server + tab/task manager.

const SITES = {
  chatgpt: { newChatUrl: 'https://chatgpt.com/' },
  claude: { newChatUrl: 'https://claude.ai/new' },
  gemini: { newChatUrl: 'https://gemini.google.com/app' },
};
const TAB_PATTERNS = [
  'https://claude.ai/*',
  'https://chatgpt.com/*',
  'https://chat.openai.com/*',
  'https://gemini.google.com/*',
];

// Connection details stay in the extension. All behavior and prompts arrive only
// from a WebSocket authenticated using the desktop's extension-only credential.
const DEFAULTS = { serverUrl: 'ws://localhost:8787/bridge', token: '', orchestratorTabId: null };
let proxySettings = null;
let proxySettingsRevision = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getConfig = async () => ({
  ...DEFAULTS,
  ...(await chrome.storage.local.get(Object.keys(DEFAULTS))),
  ...(proxySettings || {enabled: false, maxWorkers: 0, maxTasksPerHour: 0, taskTimeoutMin: 0,
    promptSchema: 2, promptModules: {}}),
  autoCloseWorkers: false, // Forced until independently verified Saga closure.
});
function acceptProxySettings(msg) {
  if (msg.schema !== 1 || !Number.isSafeInteger(msg.revision) || msg.revision <= 0 ||
      msg.revision < proxySettingsRevision ||
      !msg.settings || typeof msg.settings !== 'object') return false;
  const c = msg.settings;
  const names=['core','task','workspace','delegation','queue','child_result','status_request','child_tab_lost','failure'];
  if(c.promptSchema!==2 || typeof c.enabled!=='boolean' ||
      !Number.isSafeInteger(c.maxWorkers)||c.maxWorkers<1||c.maxWorkers>10||
      !Number.isSafeInteger(c.maxTasksPerHour)||c.maxTasksPerHour<1||c.maxTasksPerHour>500||
      !Number.isSafeInteger(c.taskTimeoutMin)||c.taskTimeoutMin<1||c.taskTimeoutMin>60||
      !c.promptModules||typeof c.promptModules!=='object'||
      names.some(k=>typeof c.promptModules[k]!=='string'||!c.promptModules[k].trim()||c.promptModules[k].length>8192))return false;
  proxySettings={enabled:c.enabled,maxWorkers:c.maxWorkers,maxTasksPerHour:c.maxTasksPerHour,
    taskTimeoutMin:c.taskTimeoutMin,promptSchema:2,
    promptModules:Object.fromEntries(names.map(k=>[k,c.promptModules[k]]))};
  proxySettingsRevision = msg.revision;
  return true;
}

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
let workerOwners = {}; // worker tab id -> authenticated credential scope; legacy is isolated
let workerIncarnations = {}; // tab id -> UUID assigned at creation, never inferred from reused tab IDs
let workerUrls = {}; // last known supported chat URL
let lostWorkers = {}; // original task ID -> recoverable, owner-bound closed conversation
const intentionalClosures = new Set();
let roleSeats = {}; // scoped caller + role + Saga reference -> one reusable tab
const roleSeatReservations = new Set(); // serialize simultaneous same-seat startup
let managerWakes = {}; // batch UUID -> one-shot manager submission ledger (session only)
let browserSessionId = null; // chrome.storage.session resets after browser restart
let managerIncarnations = {}; // tab id -> attested UUID in this browser session
const waiters = {}; // taskId -> [resolve]

const stateReady = (async () => {
  const s = await chrome.storage.session.get(['tasks', 'workers', 'taskLog', 'workerOwners', 'workerIncarnations', 'roleSeats', 'managerWakes', 'browserSessionId', 'managerIncarnations', 'workerUrls', 'lostWorkers']);
  tasks = s.tasks || {};
  workers = s.workers || [];
  taskLog = s.taskLog || [];
  workerOwners = s.workerOwners || {};
  workerIncarnations = s.workerIncarnations || {};
  workerUrls = s.workerUrls || {};
  lostWorkers = s.lostWorkers || {};
  roleSeats = s.roleSeats || {};
  managerWakes = s.managerWakes || {};
  browserSessionId = /^[0-9a-f-]{36}$/i.test(s.browserSessionId || '')
    ? s.browserSessionId : crypto.randomUUID();
  managerIncarnations = s.managerIncarnations || {};
  await chrome.storage.session.set({ browserSessionId, managerIncarnations });
})();

const saveState = () => chrome.storage.session.set({ tasks, workers, taskLog, workerOwners, workerIncarnations, workerUrls, lostWorkers, roleSeats, managerWakes, browserSessionId, managerIncarnations });

function callerOwner(p = {}) {
  const principal = p.__trustedPrincipal;
  if (!principal || principal.mode === 'legacy') return 'legacy';
  if (principal.mode !== 'scoped' || !/^[0-9a-f-]{36}$/i.test(principal.credentialId) ||
      !Number.isSafeInteger(principal.callerTabId) || principal.callerTabId <= 0) {
    throw new Error('Unverified scoped caller');
  }
  return `credential:${principal.credentialId}`;
}

function ownedWorker(tabId, owner) {
  return workers.includes(tabId) && (workerOwners[tabId] || 'legacy') === owner;
}

// Role scopes are explicit Saga references. A role seat is only reusable by
// the SAME authenticated principal; it grants no new project/tab permissions.
function roleSeatKey(p, owner) {
  if (p.role_scope == null) return null;
  if (owner === 'legacy') throw new Error('Role-seat reuse requires a scoped principal');
  const pattern = p.role === 'pm' || p.role === 'watchdog' ? /^epic:[1-9]\d*$/
    : p.role === 'tl' ? /^task:[1-9]\d*$/
    : /^council_[a-e]$/.test(p.role || '') ? /^parent:[1-9]\d*$/
    : null;
  if (!pattern || typeof p.role_scope !== 'string' || !pattern.test(p.role_scope)) {
    throw new Error('Invalid role_scope: PM/Watchdog use epic:N, TL uses task:N, Council uses parent:N');
  }
  return owner + '|' + p.role + '|' + p.role_scope;
}

function clearRoleSeatsForTab(tabId) {
  for (const [key, seat] of Object.entries(roleSeats)) {
    if (seat.tabId === tabId) delete roleSeats[key];
  }
}

async function callerManagerTab(p, cfg) {
  const principal = p.__trustedPrincipal;
  if (!principal || principal.mode === 'legacy') return cfg.orchestratorTabId;
  const tab = await chrome.tabs.get(principal.callerTabId).catch(() => null);
  if (!tab || !siteOfUrl(tab.url)) throw new Error('Paired manager tab unavailable; re-pair this caller');
  if (principal.browserSessionId !== browserSessionId ||
      principal.sessionIncarnationId !== managerIncarnations[tab.id]) {
    throw new Error('Paired manager browser/tab incarnation changed; re-pair required');
  }
  return tab.id;
}

function requireOwnedTab(tabId, managerTabId, owner) {
  if (tabId !== managerTabId && !ownedWorker(tabId, owner)) {
    throw new Error('Tab is outside this caller scope');
  }
}

function summarize(t) {
  const out = {
    task_id: t.id,
    tab_id: t.tabId,
    site: t.site,
    status: t.status,
    elapsed_seconds: Math.round(((t.finishedAt || Date.now()) - t.startedAt) / 1000),
    source_incarnation_id: t.workerIncarnationId || null,
  };
  if (t.status === 'done') out.result = t.result;
  if (t.status === 'done' && t.autoClose) {
    out.note = 'Automatic closure is held pending Saga verification. The worker tab remains open for authorized review and follow-ups.';
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
  if (!proxySettings) throw new Error('Proxy settings not synchronized. Connect with the desktop extension-only token.');
  if (!cfg.enabled) throw new Error('Automation is disabled in the proxy Settings panel.');

  const hourAgo = Date.now() - 3600 * 1000;
  taskLog = taskLog.filter((ts) => ts > hourAgo);
  if (taskLog.length >= cfg.maxTasksPerHour) {
    throw new Error(`Rate limit: ${cfg.maxTasksPerHour} tasks per hour reached. Adjust it in the desktop Extension Settings panel if intended.`);
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
async function listTabs(p = {}) {
  await stateReady;
  const cfg = await getConfig();
  const owner = callerOwner(p);
  const managerTabId = await callerManagerTab(p, cfg);
  const tabs = await chrome.tabs.query({ url: TAB_PATTERNS });
  return tabs.filter((t) => t.id === managerTabId || ownedWorker(t.id, owner)).map((t) => ({
    tab_id: t.id,
    window_id: t.windowId,
    site: siteOfUrl(t.url),
    title: t.title,
    url: t.url,
    active: t.active,
    role: t.id === managerTabId ? 'orchestrator' : 'worker',
    seat_role: Object.values(roleSeats).find((seat) => seat.tabId === t.id && seat.owner === owner)?.role || null,
    seat_scope: Object.values(roleSeats).find((seat) => seat.tabId === t.id && seat.owner === owner)?.scope || null,
    incarnation_id: workerIncarnations[t.id] || null,
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
function buildWorkerPrompt(cfg, task, contextTranscript, role='specialist', composed=null) {
  if(typeof composed!=='string'||!composed.startsWith('<system_instructions>')||composed.length>60000)
    throw new Error('Expected proxy-composed task prompt');
  if(!contextTranscript)return composed;
  const data=String(contextTranscript).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const result=composed+'\n<orchestrator_context untrusted="true">\n'+data+'\n</orchestrator_context>';
  if(result.length>60000)throw new Error('Task context exceeds prompt limit');
  return result;
}
async function closeWorkerTab(tabId) {
  await stateReady;
  // A worker may share a window with user tabs after being moved. Never close the window.
  if (!workers.includes(tabId)) throw new Error('Refusing to close a non-worker tab');
  intentionalClosures.add(tabId);
  await chrome.tabs.remove(tabId).catch(async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) { intentionalClosures.delete(tabId); throw new Error('Could not close worker tab'); }
  });
  workers = workers.filter((id) => id !== tabId);
  delete workerOwners[tabId];
  delete workerIncarnations[tabId];
  delete workerUrls[tabId];
  clearRoleSeatsForTab(tabId);
  delete managerIncarnations[tabId];
  await saveState();
}

// Two observations reduce false-idle sends. The content script rechecks at submit
// time; neither observation is an ACK or proof that the model processed a result.
async function confirmTabIdle(tabId) {
  const first = await tabMessage(tabId, { cmd: 'observe_state' });
  if (first?.ok !== true || first.state !== 'idle') {
    throw new Error(`Worker tab is not idle (${first?.state || 'unknown'})`);
  }
  await sleep(600);
  const second = await tabMessage(tabId, { cmd: 'observe_state' });
  if (second?.ok !== true || second.state !== 'idle') {
    throw new Error(`Worker tab is not stably idle (${second?.state || 'unknown'})`);
  }
}

async function startTask(tabId, site, text, waitSecs, cfg, autoClose = false, owner = 'legacy') {
  if (Object.values(tasks).some((task) => task.tabId === tabId && task.status === 'running')) {
    throw new Error('Worker has an outstanding task; await its terminal result before reuse');
  }
  await confirmTabIdle(tabId);
  const id = crypto.randomUUID();
  const receiptNonce = crypto.randomUUID();
  const task = { id, tabId, site, status: 'running', startedAt: Date.now(), autoClose, receiptNonce, owner,
    workerIncarnationId: workerIncarnations[tabId] || null };
  tasks[id] = task;
  taskLog.push(Date.now());
  await saveState();

  const r = await tabMessage(tabId, { cmd: 'run_prompt', taskId: id, receiptNonce, text, timeoutMs: cfg.taskTimeoutMin * 60000 });
  if (!r?.ok) {
    finishTask(id, { status: 'failed', error: r?.error || 'Tab refused the task' });
  } else if (waitSecs > 0) {
    await waitTask(id, Math.min(waitSecs, 50) * 1000);
  }
  return summarize(tasks[id]);
}

// ------------------------------------------------------------------ calls
async function handleCall(method, p = {}) {
  await stateReady;
  const owner = callerOwner(p);
  if (p.__trustedPrincipal?.mode === 'scoped') {
    await callerManagerTab(p, await getConfig()); // All six public Worker Tool operations.
  }
  switch (method) {
    // Called only through trusted desktop IPC -> proxy utilityProcess. Never registered as MCP tools.
    case 'desktop_set_orchestrator_tab': {
      if (!Number.isSafeInteger(p.tab_id) || p.tab_id <= 0) throw new Error('Invalid tab ID');
      const tab = await chrome.tabs.get(p.tab_id).catch(() => null);
      if (!tab || !siteOfUrl(tab.url)) throw new Error('The tab is not a supported chat conversation');
      await chrome.storage.local.set({orchestratorTabId: p.tab_id});
      return {orchestratorTabId: p.tab_id};
    }
    case 'desktop_diagnose_tab': {
      if (!Number.isSafeInteger(p.tab_id) || p.tab_id <= 0) throw new Error('Invalid tab ID');
      const tab = await chrome.tabs.get(p.tab_id).catch(() => null);
      if (!tab || !siteOfUrl(tab.url)) throw new Error('The tab is not a supported chat conversation');
      return tabMessage(p.tab_id, {cmd: 'diagnose'});
    }
    case 'desktop_close_legacy_workers': {
      let closed = 0;
      let held = 0;
      for (const tabId of [...workers]) {
        if ((workerOwners[tabId] || 'legacy') !== 'legacy') continue;
        try { await handleCall('close_worker', {tab_id: tabId}); closed++; }
        catch { held++; }
      }
      return {closed, held};
    }
    case 'attest_manager_tab': {
      // Internal proxy utilityProcess request from trusted desktop IPC only.
      if (!Number.isSafeInteger(p.tab_id) || p.tab_id <= 0) throw new Error('Invalid manager tab');
      const tab = await chrome.tabs.get(p.tab_id).catch(() => null);
      if (!tab || !siteOfUrl(tab.url)) throw new Error('Manager tab unavailable or unsupported');
      if (!managerIncarnations[tab.id]) {
        managerIncarnations[tab.id] = crypto.randomUUID();
        await saveState();
      }
      return { tab_id: tab.id, browser_session_id: browserSessionId,
        incarnation_id: managerIncarnations[tab.id] };
    }

    // Internal server-to-extension operations. These are deliberately NOT public
    // Worker Tool MCP registrations. The server supplies verified identity.
    case 'manager_state': {
      if (p.__trustedPrincipal?.mode !== 'scoped') throw new Error('Scoped identity required');
      const cfg = await getConfig();
      const manager = await callerManagerTab(p, cfg);
      const state = await tabMessage(manager, { cmd: 'observe_state' });
      return { tab_id: manager, state: state?.state || 'unknown', ready: state?.ok === true && state.state === 'idle',
        browser_session_id: browserSessionId, incarnation_id: managerIncarnations[manager] };
    }

    case 'wake_manager': {
      if (p.__trustedPrincipal?.mode !== 'scoped') throw new Error('Scoped identity required');
      const cfg = await guard();
      const managerTabId = await callerManagerTab(p, cfg);
      if (!/^[0-9a-f-]{36}$/i.test(p.batch_id || '') ||
          !Array.isArray(p.events) || p.events.length < 1 || p.events.length > 16) {
        throw new Error('Invalid manager batch');
      }
      const seen = new Set();
      for (const item of p.events) {
        if (!item || !/^[0-9a-f-]{36}$/i.test(item.event_id || '') ||
            seen.has(item.event_id) ||
            !['CHILD_RESULT', 'STATUS_REQUEST', 'CHILD_TAB_LOST'].includes(item.type) ||
            typeof item.summary !== 'string' || item.summary.length > 20000 ||
            typeof item.recorded_at !== 'string' ||
            !Number.isFinite(Date.parse(item.recorded_at))) {
          throw new Error('Invalid manager batch item');
        }
        seen.add(item.event_id);
      }
      if (managerWakes[p.batch_id] ||
          Object.values(managerWakes).some((w) =>
            w.owner === owner && w.managerTabId === managerTabId && w.status !== 'processed')) {
        throw new Error('A manager wake is pending or uncertain; reconcile it before retrying');
      }
      const batchText=p.prompt_text;
      if(typeof batchText!=='string'||!batchText.startsWith('<system_instructions>')||
         !batchText.includes('<queue_batch')||batchText.length>60000)
        throw new Error('Invalid proxy-composed queue prompt');
      if (batchText.length > 60000) throw new Error('Manager batch exceeds message limit');
      await confirmTabIdle(managerTabId);
      // Re-evaluate after the asynchronous idle observations: two concurrent
      // callers must never both reserve and submit to the same manager.
      if (managerWakes[p.batch_id] ||
          Object.values(managerWakes).some((w) =>
            w.owner === owner && w.managerTabId === managerTabId && w.status !== 'processed')) {
        throw new Error('Manager wake already reserved during idle confirmation');
      }
      managerWakes[p.batch_id] = { owner, managerTabId, status: 'dispatching', recordedAt: Date.now() };
      await saveState();
      try {
        const response = await tabMessage(managerTabId, { cmd: 'submit_manager_batch', text: batchText });
        managerWakes[p.batch_id].status = response?.ok === true && response.submitted === true
          ? 'submitted' : 'uncertain';
        await saveState();
        return { batch_id: p.batch_id, submitted: managerWakes[p.batch_id].status === 'submitted',
          uncertain: managerWakes[p.batch_id].status === 'uncertain' };
      } catch {
        managerWakes[p.batch_id].status = 'uncertain';
        await saveState();
        return { batch_id: p.batch_id, submitted: false, uncertain: true };
      }
    }

    case 'manager_processed': {
      if (p.__trustedPrincipal?.mode !== 'scoped') throw new Error('Scoped identity required');
      const prior = managerWakes[p.batch_id];
      if (!prior || prior.owner !== owner || prior.status !== 'submitted') {
        throw new Error('No submitted batch in this manager scope');
      }
      prior.status = 'processed';
      await saveState();
      return { batch_id: p.batch_id, processed: true };
    }

    case 'list_tabs':
      return listTabs(p);

    case 'reopen_child': {
      await guard({newWorker:true});
      if (typeof p.task_id !== 'string' || !p.task_id) throw new Error('Original task_id is required');
      const lost = lostWorkers[p.task_id];
      if (!lost || lost.owner !== owner || owner === 'legacy') {
        throw new Error('No recoverable child task in this caller scope');
      }
      if (lost.reopenedTabId) {
        const current = await chrome.tabs.get(lost.reopenedTabId).catch(()=>null);
        if (current && ownedWorker(lost.reopenedTabId, owner) &&
            workerIncarnations[lost.reopenedTabId] === lost.reopenedIncarnation) {
          return {tab_id:lost.reopenedTabId, original_task_id:p.task_id,
            reused:true, status:'REATTACHED', execution_resumed:false};
        }
        throw new Error('Recovered tab changed or closed; manually reconcile before another recovery');
      }
      const parsed = new URL(lost.url);
      const site = siteOfUrl(parsed.href);
      if (parsed.protocol !== 'https:' || !site || parsed.username || parsed.password ||
          parsed.search || parsed.hash) throw new Error('Unsafe saved child URL');
      if (tasks[p.task_id]?.owner !== owner ||
          tasks[p.task_id]?.workerIncarnationId !== lost.incarnation)
        throw new Error('Original child task owner/incarnation mismatch');
      const managerTabId = await callerManagerTab(p,await getConfig());
      if (!Number.isSafeInteger(managerTabId)) throw new Error('Parent tab unavailable');
      const tab = (await chrome.windows.create({url:lost.url,focused:false,width:1100,height:850}))?.tabs?.[0];
      if (!Number.isSafeInteger(tab?.id)) throw new Error('Could not reopen child URL');
      const newIncarnation = crypto.randomUUID();
      workers.push(tab.id);workerOwners[tab.id]=owner;
      workerIncarnations[tab.id]=newIncarnation;workerUrls[tab.id]=lost.url;
      lost.reopenedTabId=tab.id;lost.reopenedIncarnation=newIncarnation;
      await saveState();
      return {tab_id:tab.id, original_task_id:p.task_id, old_tab_id:lost.tabId,
        original_task_status:tasks[p.task_id]?.status, saved_url:lost.url,
        parent_tab_id:managerTabId, new_incarnation_id:newIncarnation,
        status:'REATTACHED', execution_resumed:false,
        next_step:'Use read_chat on this tab and get_result with original_task_id; reconcile before continuing.'};
    }
    case 'spawn_worker': {
      if (p.role === 'watchdog' &&
          (p.__trustedPrincipal?.mode !== 'scoped' || p.__trustedPrincipal.role !== 'ba')) {
        throw new Error('Only an authenticated BA principal may own a Watchdog worker');
      }
      const site = SITES[p.site];
      if (!site) throw new Error(`Unknown site "${p.site}". Use "chatgpt", "claude" or "gemini".`);
      const seatKey = roleSeatKey(p, owner);
      if (seatKey && roleSeatReservations.has(seatKey)) {
        throw new Error('Role seat is already being started; retry after its startup finishes');
      }
      if (seatKey) roleSeatReservations.add(seatKey);
      try {
        const prior = seatKey && roleSeats[seatKey];
        if (prior) {
          if (!ownedWorker(prior.tabId, owner) ||
              workerIncarnations[prior.tabId] !== prior.incarnationId) {
            throw new Error('Role-seat ownership or incarnation changed; manual review required');
          }
          const tab = await chrome.tabs.get(prior.tabId).catch(() => null);
          if (tab) {
            if (siteOfUrl(tab.url) !== p.site || prior.site !== p.site) {
              throw new Error('Role-seat site changed; manual review required');
            }
            const cfg = await guard();
            if (p.auto_close === true) throw new Error('Automatic worker closure is disabled');
            // Initial role/context is already in this chat; new stages are follow-ups.
            const result = await startTask(prior.tabId, p.site, p.task, p.wait_seconds || 0, cfg, false, owner);
            return { ...result, reused_tab: true, seat_role: p.role, seat_scope: p.role_scope };
          }
          delete roleSeats[seatKey];
          await saveState();
        }
        const cfg = await guard({ newWorker: true });
        if (p.auto_close === true || (p.keep_open !== true && cfg.autoCloseWorkers)) {
          throw new Error('Automatic worker closure requires verified Saga completion and is currently disabled');
        }
        const managerTabId = await callerManagerTab(p, cfg);
        let contextTranscript = '';
        if (p.share_context_from) {
          const srcId = p.share_context_from === 'orchestrator' ? managerTabId : await resolveTab(p.share_context_from);
          requireOwnedTab(srcId, managerTabId, owner);
          const chat = await tabMessage(srcId, { cmd: 'read_chat' });
          contextTranscript = chat.transcript;
        }
        const prompt = buildWorkerPrompt(cfg, p.task, contextTranscript, p.role, p.prompt_text);
        const win = await chrome.windows.create({ url: site.newChatUrl, focused: false, width: 1100, height: 850 });
        const tabId = win.tabs[0].id;
        workers.push(tabId);
        workerOwners[tabId] = owner;
        workerIncarnations[tabId] = crypto.randomUUID();
        workerUrls[tabId] = site.newChatUrl;
        if (seatKey) roleSeats[seatKey] = {
          tabId, owner, incarnationId: workerIncarnations[tabId], role: p.role,
          scope: p.role_scope, site: p.site,
        };
        await saveState();
        await waitReady(tabId);
        // Completion stays in its tab until separately verified and approved.
        const result = await startTask(tabId, p.site, prompt, p.wait_seconds || 0, cfg, false, owner);
        return seatKey ? { ...result, reused_tab: false, seat_role: p.role, seat_scope: p.role_scope } : result;
      } finally {
        if (seatKey) roleSeatReservations.delete(seatKey);
      }
    }


    case 'send_to_tab': {
      const cfg = await guard();
      if (!ownedWorker(p.tab_id, owner)) {
        throw new Error('send_to_tab requires a worker owned by this caller');
      }
      const tab = await chrome.tabs.get(p.tab_id).catch(() => null);
      const site = siteOfUrl(tab?.url);
      if (!site) throw new Error(`Tab ${p.tab_id} does not support send_to_tab.`);
      return startTask(p.tab_id, site, p.text, p.wait_seconds || 0, cfg, false, owner);
    }

    case 'get_result': {
      const t = tasks[p.task_id];
      if (!t || (t.owner || 'legacy') !== owner) throw new Error('Unknown task_id in this caller scope (browser session may have restarted).');
      if (p.wait_seconds > 0) await waitTask(t.id, Math.min(p.wait_seconds, 50) * 1000);
      return summarize(tasks[t.id]);
    }
    case 'read_chat': {
      const cfg = await guard();
      const managerTabId = await callerManagerTab(p, cfg);
      const tabId = p.tab_id == null ? managerTabId : p.tab_id;
      if (!Number.isSafeInteger(tabId)) throw new Error('No paired manager tab; select the orchestrator in the popup');
      requireOwnedTab(tabId, managerTabId, owner);
      return tabMessage(tabId, {
        cmd: 'read_chat', lastN: p.last_n,
        includeReasoning: p.include_reasoning,
        includeAttachments: p.include_attachments,
      });
    }

    case 'close_verified_worker': {
      if (p.__trustedPrincipal?.mode !== 'scoped' || p.saga_verified !== true ||
          !/^[0-9a-f-]{36}$/i.test(p.saga_event_id || '')) {
        throw new Error('Trusted Saga closure proof required');
      }
      if (!ownedWorker(p.tab_id, owner) ||
          workerIncarnations[p.tab_id] !== p.worker_incarnation_id) {
        const absent = await chrome.tabs.get(p.tab_id).catch(() => null);
        if (!absent) return { closed: p.tab_id, already_closed: true };
        throw new Error('Scoped worker incarnation mismatch');
      }
      if (Object.values(tasks).some((task) =>
          task.tabId === p.tab_id && task.status === 'running')) {
        throw new Error('Cannot close a still-running scoped worker');
      }
      await closeWorkerTab(p.tab_id);
      return { closed: p.tab_id, saga_verified: true };
    }

    case 'close_worker': {
      if (!ownedWorker(p.tab_id, owner)) {
        const tab = await chrome.tabs.get(p.tab_id).catch(() => null);
        if (!tab && !workerOwners[p.tab_id]) return { closed: p.tab_id, already_closed: true };
        throw new Error('Worker is outside this caller scope');
      }
      if (owner !== 'legacy') {
        // A scoped manager may not self-attest Saga completion or silently
        // close a child. Release only after independent board readback is wired.
        throw new Error('Scoped worker closure is HELD until independent Saga verification');
      }
      const tab = await chrome.tabs.get(p.tab_id).catch(() => null);
      if (!tab) return { closed: p.tab_id, already_closed: true };
      if (Object.values(tasks).some((t) => t.tabId === p.tab_id && t.status === 'running')) {
        throw new Error('Cannot close a worker while its task is running');
      }
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
let privateQueueMode = 'unknown'; // server capability handshake, never caller supplied
const workerReceiptWaiters = new Map();
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

  const thisSocket = ws;
  ws.onopen = () => {
    if (thisSocket !== ws) return;
    wsState = 'connected';
    proxySettings = null;
    proxySettingsRevision = 0;
    privateQueueMode = 'unknown';
    attempts = 0;
    clearInterval(keepTimer);
    // Regular traffic also keeps the MV3 service worker alive.
    keepTimer = setInterval(() => ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'ping' })), 20000);
  };

  ws.onmessage = async (ev) => {
    if (thisSocket !== ws) return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'settings_snapshot') {
      if (!acceptProxySettings(msg)) {
        proxySettings = null;
        wsState = 'invalid proxy settings';
      }
      else if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({type: 'settings_applied', revision: msg.revision}));
      }
      return;
    }
    if (msg.type === 'coordination_capabilities') {
      privateQueueMode = msg.queue_enabled === true ? 'enabled' : 'disabled';
      return;
    }
    if (msg.type === 'worker_event_receipt') {
      const pending = workerReceiptWaiters.get(msg.request_id);
      if (!pending) return;
      workerReceiptWaiters.delete(msg.request_id);
      clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(msg.receipt);
      else pending.reject(new Error(msg.error || 'Private receipt unavailable'));
      return;
    }
    if (msg.type !== 'call') return;
    const socket = thisSocket;
    try {
      const result = await handleCall(msg.method, msg.params || {});
      socket.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result }));
    } catch (err) {
      socket.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: String(err?.message || err) }));
    }
  };

  ws.onclose = () => {
    if (thisSocket !== ws) return;
    wsState = 'disconnected';
    proxySettings = null;
    proxySettingsRevision = 0;
    privateQueueMode = 'unknown';
    for (const [id, pending] of workerReceiptWaiters) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Private journal connection lost; receipt UNCERTAIN'));
      workerReceiptWaiters.delete(id);
    }
    clearInterval(keepTimer);
    scheduleReconnect();
  };
  ws.onerror = () => {};
}

// A server fsync ACK is the only successful private event receipt.
async function submitPrivateWorkerReceipt(task) {
  if ((task.owner || 'legacy') === 'legacy' || privateQueueMode === 'disabled') return true;
  if (task.journalReceipt) return true;
  if (privateQueueMode !== 'enabled' || !ws || ws.readyState !== WebSocket.OPEN ||
      !task.workerIncarnationId || !task.owner.startsWith('credential:')) {
    throw new Error('Private journal transport not ready; outcome UNCERTAIN');
  }
  const requestId = crypto.randomUUID();
  const receipt = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      workerReceiptWaiters.delete(requestId);
      reject(new Error('Private journal receipt timeout; reconciliation required'));
    }, 12000);
    workerReceiptWaiters.set(requestId, { resolve, reject, timer });
  });
  ws.send(JSON.stringify({
    type: 'worker_done', request_id: requestId,
    task_id: task.id, tab_id: task.tabId,
    credential_id: task.owner.slice('credential:'.length),
    worker_incarnation_id: task.workerIncarnationId,
  }));
  const response = await receipt;
  if (!response?.durably_recorded) throw new Error('Private queue did not durably acknowledge receipt');
  task.journalReceipt = true;
  await saveState();
  return true;
}

function scheduleReconnect() {
  attempts += 1;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, Math.min(15000, 1000 * attempts));
}

function reconnectNow() {
  proxySettings = null;
  proxySettingsRevision = 0;
  privateQueueMode = 'unknown';
  for (const [id, pending] of workerReceiptWaiters) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Reconnect invalidated outstanding receipt; outcome UNCERTAIN'));
    workerReceiptWaiters.delete(id);
  }
  try { ws?.close(); } catch {}
  clearInterval(keepTimer);
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

async function reportLostWorker(info) {
  if (privateQueueMode !== 'enabled' || !ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('[coordination] Child loss observed while queue unavailable; reconciliation needed');
    return;
  }
  let safeUrl;
  try {
    const url = new URL(info.url);
    if (url.protocol !== 'https:' || !siteOfUrl(url.href)) return;
    safeUrl = url.origin + url.pathname;
  } catch { return; }
  const requestId = crypto.randomUUID();
  const receipt = new Promise((resolve,reject) => {
    const timer = setTimeout(() => {
      workerReceiptWaiters.delete(requestId);
      reject(new Error('Child-loss receipt uncertain'));
    }, 12000);
    workerReceiptWaiters.set(requestId,{resolve,reject,timer});
  });
  ws.send(JSON.stringify({type:'worker_lost',request_id:requestId,event_key:crypto.randomUUID(),
    task_id:info.task.id,tab_id:info.tabId,credential_id:info.owner.slice('credential:'.length),
    worker_incarnation_id:info.incarnation,saved_url:safeUrl}));
  try {
    const result=await receipt;
    if (result?.durably_recorded !== true) throw new Error('No durable receipt');
  } catch {console.warn('[coordination] Lost worker event UNCERTAIN; do not retry blindly');}
}
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await stateReady;
  if (!workers.includes(tabId)) return;
  const url=changeInfo?.url || tab?.url;
  if (typeof url==='string' && siteOfUrl(url)) {workerUrls[tabId]=url;void saveState();}
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await stateReady;
  const managed=workers.includes(tabId);
  const intentional=intentionalClosures.delete(tabId);
  const owner=workerOwners[tabId],incarnation=workerIncarnations[tabId],url=workerUrls[tabId];
  const task=Object.values(tasks).filter(t=>t.tabId===tabId&&t.workerIncarnationId===incarnation)
    .sort((a,b)=>b.startedAt-a.startedAt)[0];
  workers=workers.filter(id=>id!==tabId);
  delete workerOwners[tabId];delete workerIncarnations[tabId];delete workerUrls[tabId];
  clearRoleSeatsForTab(tabId);delete managerIncarnations[tabId];
  for (const t of Object.values(tasks)) if(t.tabId===tabId)
    finishTask(t.id,{status:'failed',error:'Tab closed or unavailable before task completion'});
  if(managed&&!intentional&&task&&url&&incarnation&&owner?.startsWith('credential:')){
    try {
      const parsed=new URL(url);
      if(parsed.protocol==='https:'&&siteOfUrl(url)) {
        lostWorkers[task.id]={tabId,owner,incarnation,url:parsed.origin+parsed.pathname,
          recordedAt:Date.now()};
        await saveState();
      }
    } catch {}
    await reportLostWorker({tabId,task,url,owner,incarnation});
  } else await saveState();
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await stateReady;
    switch (msg?.type) {
      case 'task_done': {
        const task = tasks[msg.taskId];
        if (!task || sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
            sender.tab?.id !== task.tabId ||
            msg.receiptNonce !== task.receiptNonce ||
            typeof msg.ok !== 'boolean') {
          sendResponse({ ok: false, error: 'Unverified worker completion source' });
          break;
        }
        if (task.status !== 'running') {
          const duplicate = (task.status === 'done' && msg.ok === true) ||
            (task.status === 'failed' && msg.ok === false);
          if (!duplicate) { sendResponse({ ok: false, error: 'Conflicting terminal receipt' }); break; }
          try {
            await submitPrivateWorkerReceipt(task); // stable idempotency across content retries
            sendResponse({ ok: true, duplicate: true });
          } catch {
            sendResponse({ ok: false, error: 'Private journal receipt UNCERTAIN' });
          }
          break;
        }
        finishTask(
          msg.taskId,
          msg.ok ? { status: 'done', result: msg.text } : { status: 'failed', error: msg.error }
        );
        try {
          await submitPrivateWorkerReceipt(task);
          sendResponse({ ok: true });
        } catch {
          sendResponse({ ok: false, error: 'Private journal receipt UNCERTAIN' });
        }
        break;
      }
      case 'popup_status': {
        const cfg = await getConfig();
        sendResponse({
          wsState,
          coordinationMode: privateQueueMode,
          settingsSynced: Boolean(proxySettings),
          settingsRevision: proxySettingsRevision,
          cfg: { serverUrl: cfg.serverUrl, token: cfg.token, orchestratorTabId: cfg.orchestratorTabId },
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
        let closed = 0;
        let held = 0;
        for (const id of [...workers]) {
          try {
            await handleCall('close_worker', { tab_id: id });
            closed++;
          } catch { held++; }
        }
        sendResponse({ ok: held === 0, closed, held });
        break;
      }
      default:
        sendResponse({ ok: false });
    }
  })();
  return true;
});

connect();
