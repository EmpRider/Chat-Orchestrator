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

// The extension needs only the local proxy WebSocket URL.
const DEFAULTS = { serverUrl: 'ws://localhost:8787/bridge', orchestratorTabId: null };
let proxySettings = null;
let proxySettingsRevision = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A page can keep heartbeats, analytics and streaming requests open forever.
// Readiness depends on browser document completion, a short settling interval,
// and the provider composer's independent readiness/ownership checks.
const pageSettling = (() => {
  const SETTLE_MS = 2500;
  const loaded = new Map(); // tab ID -> completion time + URL; in-memory only

  function complete(tabId, tab) {
    if (tab?.status !== 'complete' || !siteOfUrl(tab.url)) return;
    const previous = loaded.get(tabId);
    if (!previous || previous.url !== tab.url) {
      loaded.set(tabId, {url:tab.url,at:Date.now()});
    }
  }
  function onUpdated(tabId, changeInfo, tab) {
    if (changeInfo?.status === 'loading') loaded.delete(tabId);
    if (changeInfo?.status === 'complete') complete(tabId,tab);
  }
  async function snapshot(tabId) {
    const tab=await chrome.tabs.get(tabId).catch(()=>null);
    const documentComplete=tab?.status==='complete' && !!siteOfUrl(tab?.url);
    if (!documentComplete) {
      loaded.delete(tabId);
      return {ready:false,documentComplete:false,settledMs:0,remainingMs:SETTLE_MS};
    }
    // On service-worker restart the original load event may be gone.
    // Begin a fresh settling interval rather than trusting stale readiness.
    complete(tabId,tab);
    const settledMs=Math.max(0,Date.now()-loaded.get(tabId).at);
    return {ready:settledMs>=SETTLE_MS,documentComplete:true,
      settledMs,remainingMs:Math.max(0,SETTLE_MS-settledMs)};
  }
  async function waitForReady(tabId, timeoutMs=45000) {
    const deadline=Date.now()+timeoutMs;
    let last;
    do {
      last=await snapshot(tabId);
      if(last.ready) return last;
      await sleep(Math.min(200,Math.max(1,deadline-Date.now())));
    } while(Date.now()<deadline);
    throw new Error('Browser page did not settle after load for tab '+tabId+
      ': documentComplete='+last?.documentComplete+
      ', remainingMs='+last?.remainingMs);
  }
  function forget(tabId) {loaded.delete(tabId);}
  return {snapshot,waitForReady,onUpdated,forget};
})();

const getConfig = async () => ({
  ...DEFAULTS,
  ...(await chrome.storage.local.get(Object.keys(DEFAULTS))),
  ...(proxySettings || {enabled: false, maxWorkers: 0, maxTasksPerHour: 0, taskTimeoutMin: 0,
    promptSchema: 2, promptModules: {}}),
  autoCloseWorkers: false, // Parent must explicitly review and close workers.
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
let workerOwners = {}; // worker tab id -> local profile ownership; legacy tasks remain separate
let workerIncarnations = {}; // tab id -> UUID assigned at creation, never inferred from reused tab IDs
let workerUrls = {}; // last known supported chat URL
let lostWorkers = {}; // original task ID -> recoverable, owner-bound closed conversation
const intentionalClosures = new Set();
let roleSeats = {}; // profile + reusable seat label -> one reusable tab
const roleSeatReservations = new Set(); // serialize simultaneous same-seat startup
let managerWakes = {}; // batch UUID -> one-shot manager submission ledger (session only)
let browserSessionId = null; // chrome.storage.session resets after browser restart
let managerIncarnations = {}; // tab id -> attested UUID in this browser session
let managerSites = {}; // tab id -> last attested provider; never store URLs
let workspaceWindow = null; // {windowId, anchorTabId, browserSessionId}; never an owner key
let workspaceGroups = {}; // root tab+incarnation -> {groupId, windowId, rootTabId, rootIncarnationId}
let workspaceSerial = Promise.resolve(); // serializes concurrent managed-window/group creation
const waiters = {}; // taskId -> [resolve]

// Privacy-preserving extension diagnostics: schema is intentionally small.
// Never serialize a prompt, response, URL, token, error.message or full tab.
const DIAG_FIELDS = new Set(['tabId','rootTabId','parentTabId','windowId','groupId',
  'expectedWindowId','actualWindowId','expectedGroupId','actualGroupId',
  'requestId','batchId','taskId','method','phase','site','reason','attempt',
  'count','batchSize','success','reused','connected','build']);
function extensionDiagnostic(level,event,fields={}) {
  try {
    if (!['debug','info','warn','error'].includes(level) ||
        !/^[a-z][a-z0-9_.-]{0,79}$/.test(event)) return;
    const data={};
    for(const [key,value] of Object.entries(fields)) {
      if (!DIAG_FIELDS.has(key)) continue;
      if (typeof value==='boolean' ||
          (typeof value==='number' && Number.isSafeInteger(value) && value>=0) ||
          (typeof value==='string' && (
            ['requestId','batchId','taskId'].includes(key)
              ? /^[0-9a-f-]{36}$/i.test(value)
              : /^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/.test(value)
          ))) data[key]=value;
    }
    if (level !== 'debug') console[level]('[chat-orch]',JSON.stringify({event,...data}));
    if (typeof ws !== 'undefined' && ws?.readyState===WebSocket.OPEN)
      ws.send(JSON.stringify({type:'diagnostic_event',level,event,data}));
  } catch { /* Diagnostics are never a worker or queue dependency. */ }
}

const stateReady = (async () => {
  const s = await chrome.storage.session.get(['tasks', 'workers', 'taskLog', 'workerOwners', 'workerIncarnations', 'roleSeats', 'managerWakes', 'browserSessionId', 'managerIncarnations', 'managerSites', 'workerUrls', 'lostWorkers','workspaceWindow','workspaceGroups']);
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
  managerSites = s.managerSites || {};
  workspaceWindow = s.workspaceWindow?.browserSessionId === browserSessionId ? s.workspaceWindow : null;
  workspaceGroups = workspaceWindow && s.workspaceGroups && typeof s.workspaceGroups === 'object'
    ? s.workspaceGroups : {};
  await chrome.storage.session.set({ browserSessionId, managerIncarnations, managerSites });
})();

const saveState = () => chrome.storage.session.set({ tasks, workers, taskLog, workerOwners, workerIncarnations, workerUrls, lostWorkers, roleSeats, managerWakes, browserSessionId, managerIncarnations,managerSites,workspaceWindow,workspaceGroups });

function callerOwner(p = {}) {
  const principal = p.__trustedPrincipal;
  if (!principal || principal.mode === 'legacy') return 'legacy';
  if (principal.mode !== 'profile' ||
      !/^[0-9a-f-]{36}$/i.test(principal.credentialId) ||
      !Number.isSafeInteger(principal.callerTabId) || principal.callerTabId <= 0) {
    throw new Error('Invalid profile caller context');
  }
  return `credential:${principal.credentialId}`;
}

function ownedWorker(tabId, owner) {
  return workers.includes(tabId) && (workerOwners[tabId] || 'legacy') === owner;
}

// Reusable seats are profile-local labels. Skills define roles and hierarchy.
function reusableSeatLabel(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 ||
      /[\u0000-\u001f\u007f|]/.test(value)) {
    throw new Error('Invalid ' + field + ': use a non-empty label without control characters');
  }
  return value.trim();
}
function roleSeatKey(p, owner) {
  if (p.role_scope == null) return null;
  const role = reusableSeatLabel(p.role, 'role');
  const scope = reusableSeatLabel(p.role_scope, 'role_scope');
  // Keep pre-existing legacy seats stable. Profile seats are parent-scoped.
  if (owner === 'legacy') return owner + '|' + role + '|' + scope;
  return owner + '|' + p.__trustedPrincipal.callerTabId + '|' + role + '|' + scope;
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
  if (!tab || !siteOfUrl(tab.url)) throw new Error('Manager tab unavailable; select a supported chat tab');
  if (principal.browserSessionId !== browserSessionId ||
      principal.sessionIncarnationId !== (workerIncarnations[tab.id] || managerIncarnations[tab.id])) {
    throw new Error('Manager browser/tab incarnation changed; register again');
  }
  return tab.id;
}

async function inspectChatTab(tabId) {
  if (!Number.isSafeInteger(tabId) || tabId <= 0) throw new Error('Invalid browser tab ID');
  let tab = await chrome.tabs.get(tabId).catch(() => null);
  let site = siteOfUrl(tab?.url);
  // Newly created background tabs can report about:blank before navigation
  // commits. A short bounded wait is safe only for workers we just created;
  // never reclassify an arbitrary caller root using a pending URL.
  if (tab && !site && workers.includes(tabId)) {
    for (let attempt = 0; attempt < 25 && !site; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      tab = await chrome.tabs.get(tabId).catch(() => null);
      site = siteOfUrl(tab?.url);
      if (!tab) break;
    }
  }
  if (!tab || !site) throw new Error('Browser tab is unavailable or is not a supported chat');
  let incarnation = workerIncarnations[tabId] || managerIncarnations[tabId];
  if (!workers.includes(tabId) && managerSites[tabId] && managerSites[tabId] !== site) {
    incarnation = managerIncarnations[tabId] = crypto.randomUUID();
    extensionDiagnostic('warn','identity.incarnation_rotated',{tabId,reason:'provider_changed'});
  }
  if (!incarnation) incarnation = managerIncarnations[tabId] = crypto.randomUUID();
  if (!workers.includes(tabId) && managerSites[tabId] !== site) {
    managerSites[tabId] = site;
    await saveState();
  } else if (managerIncarnations[tabId] === incarnation && !managerSites[tabId]) {
    managerSites[tabId]=site;
    await saveState();
  }
  return {tab_id:tabId, site, browser_session_id:browserSessionId,
    incarnation_id:incarnation, is_managed_worker:workers.includes(tabId)};
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
    out.note = 'Automatic closure is disabled. The worker stays open for parent review and fixing tasks.';
  } else if (t.status === 'done') {
    out.note = `Worker window is still open (tab_id ${t.tabId}). You can send a follow-up with send_to_tab; when you no longer need this worker, call close_worker with tab_id ${t.tabId}.`;
  }
  if (t.status === 'failed') {
    out.note = `Worker window left open for inspection (tab_id ${t.tabId}). Call close_worker with this tab_id when done.`;
  }
  if (t.status === 'failed' || t.status === 'uncertain') out.error = t.error;
  if (t.status === 'uncertain') out.note = 'Submission outcome uncertain. Inspect the tab; never blindly replay.';
  if (t.status === 'running') out.note = 'Still running. Call get_result again with wait_seconds.';
  return out;
}

function finishTask(id, patch) {
  const t = tasks[id];
  if (!t || !['running', 'uncertain'].includes(t.status)) return;
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
  if (!proxySettings) throw new Error('Proxy settings not synchronized. Connect to the running desktop proxy.');
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
function serializeWorkspace(operation) {
  const next = workspaceSerial.then(operation);
  workspaceSerial = next.catch(() => {});
  return next;
}

async function workspaceRoot(p, fallbackTabId) {
  const principal = p.__trustedPrincipal;
  const tabId = principal?.mode === 'profile' ? p.__rootTabId : fallbackTabId;
  const incarnation = principal?.mode === 'profile'
    ? p.__rootIncarnationId : managerIncarnations[fallbackTabId];
  if (!Number.isSafeInteger(tabId) || tabId <= 0 ||
      (principal?.mode === 'profile' &&
        !/^[0-9a-f-]{36}$/i.test(incarnation || ''))) {
    throw new Error('Root orchestrator identity is unavailable; do not create an ungrouped worker');
  }
  if (principal?.mode === 'profile') {
    const live = await inspectChatTab(tabId);
    if (live.incarnation_id !== incarnation || live.browser_session_id !== principal.browserSessionId)
      throw new Error('Root orchestrator session/incarnation changed; reconcile before grouping');
  }
  return {tabId,incarnation:incarnation || 'legacy'};
}

async function getManagedWorkspaceWindow() {
  const anchorUrl = chrome.runtime.getURL('workspace.html');
  if (workspaceWindow) {
    const {windowId,anchorTabId,browserSessionId:session} = workspaceWindow;
    const [window,tab] = await Promise.all([
      chrome.windows.get(windowId).catch(() => null),
      chrome.tabs.get(anchorTabId).catch(() => null),
    ]);
    if (session === browserSessionId && window?.type === 'normal' &&
        tab?.windowId === windowId &&
        (tab.url === anchorUrl || tab.pendingUrl === anchorUrl)) return windowId;
    extensionDiagnostic('warn','workspace.anchor_changed',{windowId,tabId:anchorTabId});
    // Never adopt an arbitrary window or a recycled numeric ID.
    workspaceWindow = null;
    workspaceGroups = {};
    await saveState();
  }
  const window = await chrome.windows.create({
    url:anchorUrl, type:'normal', focused:false, width:1200,height:850,
  });
  const anchor = window?.tabs?.[0];
  if (!Number.isSafeInteger(window?.id) || !Number.isSafeInteger(anchor?.id))
    throw new Error('Managed browser workspace window was not created correctly');
  workspaceWindow = {windowId:window.id,anchorTabId:anchor.id,browserSessionId};
  extensionDiagnostic('info','workspace.window_created',{windowId:window.id,tabId:anchor.id});
  workspaceGroups = {};
  await saveState();
  return window.id;
}

async function createManagedWorkerTab(url, p, fallbackTabId) {
  return serializeWorkspace(async () => {
    const root = await workspaceRoot(p,fallbackTabId);
    const windowId = await getManagedWorkspaceWindow();
    extensionDiagnostic('info','worker.placement_started',{rootTabId:root.tabId,windowId});
    const key = root.tabId + ':' + root.incarnation;
    const title = 'Chat Orchestrator · Root ' + root.tabId;
    let groupId = null;
    let groupIsNew = false;
    const saved = workspaceGroups[key];
    if (saved && saved.windowId === windowId &&
        saved.rootTabId === root.tabId && saved.rootIncarnationId === root.incarnation) {
      const group = await chrome.tabGroups.get(saved.groupId).catch(() => null);
      const members = group?.windowId === windowId
        ? await chrome.tabs.query({windowId,groupId:saved.groupId}).catch(() => []) : [];
      if (group?.windowId === windowId && group.title === title &&
          members.some((tab)=>workers.includes(tab.id) &&
            tab.windowId === windowId && tab.groupId === saved.groupId)) {
        groupId = saved.groupId;
      } else {
        delete workspaceGroups[key];
        await saveState();
      }
    }
    // Create the provider tab directly. Readiness is based on load completion
    // and a short settling delay; no debugger attachment is needed.
    const tab = await chrome.tabs.create({windowId,url,active:false});
    extensionDiagnostic('debug','worker.tab_created',{tabId:tab?.id,windowId:tab?.windowId});
    if (!Number.isSafeInteger(tab?.id) || tab.windowId !== windowId)
      throw new Error('Managed worker tab was not created in the expected window');
    let placementStage = 'group_create';
    try {
      if (groupId === null) {
        // The tab is ALREADY created in the dedicated window. Passing
        // createProperties.windowId causes Edge to occasionally reparent the
        // group to another normal window while the operation is settling.
        groupId = await chrome.tabs.group({tabIds:[tab.id]});
        groupIsNew = true;
        // Edge may return the new group ID before tabGroups.get/update can
        // observe the group. Wait briefly instead of failing in <100ms.
        let groupVisible = false;
        for (let attempt = 0; attempt < 12; attempt++) {
          if (await chrome.tabGroups.get(groupId).catch(() => null)) {
            groupVisible = true;
            break;
          }
          await sleep(80);
        }
        if (!groupVisible)
          throw new Error('New browser tab group is not visible after confirmation window');
        placementStage = 'group_update';
        const colors = ['blue','green','purple','cyan','yellow','orange','pink'];
        await chrome.tabGroups.update(groupId,{
          title,color:colors[root.tabId % colors.length],collapsed:false,
        });
      } else {
        placementStage = 'group_join';
        await chrome.tabs.group({tabIds:[tab.id],groupId});
      }
      placementStage = 'group_confirm';
      // On Edge, group creation can associate the newly created group with
      // another normal window even when createProperties.windowId was set.
      // Only move a group that is made entirely of our known worker tabs (or
      // this one just-created tab), never a user's unrelated tab group.
      // Edge can report stale group membership immediately after tabs.group.
      // Recheck BOTH actual tab and group, and only repair our own new group.
      let grouped;
      let confirmed = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        grouped = await chrome.tabs.get(tab.id).catch(() => null);
        const observedGroup = await chrome.tabGroups.get(groupId).catch(() => null);
        if (grouped?.windowId === windowId && grouped.groupId === groupId &&
            observedGroup?.windowId === windowId) {
          confirmed = true;
          break;
        }
        if (!grouped) throw new Error('Fresh worker tab disappeared during group assignment');
        if (observedGroup && observedGroup.windowId !== windowId) {
          const members = await chrome.tabs.query({groupId}).catch(() => []);
          const entirelyOwned = members.length > 0 &&
            members.some((member) => member.id === tab.id) &&
            members.every((member) => member.id === tab.id || workers.includes(member.id));
          if (!entirelyOwned) throw new Error('Refusing to move group containing unrelated tabs');
          extensionDiagnostic('warn','worker.group_window_mismatch',{
            tabId:tab.id,groupId,expectedWindowId:windowId,
            actualWindowId:observedGroup.windowId});
          await chrome.tabGroups.move(groupId,{windowId,index:-1});
        } else if (grouped.windowId === windowId && grouped.groupId !== groupId &&
                   attempt >= 5 && attempt % 5 === 0) {
          // A bounded idempotent re-group is safer than opening more tabs.
          // Never group a tab belonging to an unrelated existing group.
          if (grouped.groupId !== -1)
            throw new Error('Worker was assigned to a different tab group');
          await chrome.tabs.group({tabIds:[tab.id],groupId});
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      if (!confirmed)
      {
        extensionDiagnostic('error','worker.group_unconfirmed',{
          tabId:tab.id,expectedWindowId:windowId,expectedGroupId:groupId,
          actualWindowId:grouped?.windowId,actualGroupId:grouped?.groupId});
        throw new Error('Worker grouping remained unconfirmed after bounded retry'
          + ' (expected window/group ' + windowId + '/' + groupId
          + ', observed ' + (grouped?.windowId ?? 'missing') + '/'
          + (grouped?.groupId ?? 'missing') + ')');
      }
      if (groupIsNew) {
        workspaceGroups[key] = {groupId,windowId,rootTabId:root.tabId,
          rootIncarnationId:root.incarnation};
        await saveState();
      }
      extensionDiagnostic('info','worker.placement_confirmed',{
        tabId:tab.id,rootTabId:root.tabId,windowId,groupId,success:true});
      return grouped;
    } catch (error) {
      extensionDiagnostic('error','worker.placement_failed',{tabId:tab.id,
        windowId,groupId,reason:placementStage});
      // A failed newly-created group must never be cached and reused. Its
      // numeric ID may already have disappeared or be recycled by Edge.
      if (groupIsNew) {
        delete workspaceGroups[key];
        await saveState().catch(() => {});
      }
      // Only this fresh, unstarted tab is safe to roll back.
      await chrome.tabs.remove(tab.id).catch(() => {});
      throw new Error('Could not place worker in its root tab group'
        + ' (stage: ' + placementStage + '): ' + error.message);
    }
  });
}

async function listTabs(p = {}) {
  await stateReady;
  const cfg = await getConfig();
  const owner = callerOwner(p);
  const tabs = await chrome.tabs.query({ url: TAB_PATTERNS });
  if (p.__discoveryOnly === true) {
    return tabs.map((t) => ({tab_id:t.id,site:siteOfUrl(t.url),
      role:workers.includes(t.id)?'worker':'unregistered',active:t.active}));
  }
  const managerTabId = await callerManagerTab(p, cfg);
  return tabs.filter((t) => t.id === managerTabId || ownedWorker(t.id, owner)).map((t) => ({
    tab_id: t.id,
    window_id: t.windowId,
    group_id: t.groupId ?? null,
    group_assigned: Number.isSafeInteger(t.groupId) && t.groupId >= 0,
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

async function waitReady(tabId, expectedText, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let stableSince = null;
  let lastState = 'unobserved';
  let lastPage = null;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      lastPage = await pageSettling.snapshot(tabId);
      const tab = await chrome.tabs.get(tabId);
      if (lastPage.ready && tab?.active) {
        const observed = await tabMessage(tabId,{cmd:'ping',expectedText});
        lastState = observed?.state || 'unknown';
        if (observed?.ok === true && observed.ready === true &&
            observed.documentReady === true) {
          if (stableSince === null) stableSince = Date.now();
          if (Date.now() - stableSince >= 1200) return;
        } else stableSince = null;
      } else {
        lastState = !tab?.active ? 'not-focused' :
          lastPage.documentComplete ? 'post-load-settling' : 'document-loading';
        stableSince = null;
      }
    } catch (error) {
      lastError = String(error?.message || error);
      stableSince = null;
    }
    await sleep(250);
  }
  throw new Error('Worker composer did not become stably ready: state='+lastState+
    ', documentComplete='+lastPage?.documentComplete+
    ', remainingSettleMs='+lastPage?.remainingMs+
    ', lastError='+lastError.slice(0,180));
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
async function confirmTabIdle(tabId, expectedText = null) {
  await pageSettling.waitForReady(tabId);
  const first = await tabMessage(tabId, {cmd:'observe_state',expectedText});
  if (first?.ok !== true || first.ready !== true) {
    throw new Error('Worker tab is not ready ('+(first?.state || 'unknown')+')');
  }
  await sleep(600);
  const second = await tabMessage(tabId, {cmd:'observe_state',expectedText});
  if (second?.ok !== true || second.ready !== true) {
    throw new Error('Worker tab is not stably ready ('+(second?.state || 'unknown')+')');
  }
}

// Only one worker may be foregrounded and receive its initial prompt at a
// time. Chat pages can defer initialization in background Edge tabs. Release
// this gate once the user turn is confirmed; model responses run concurrently.
let promptStartupTail = Promise.resolve();
function serializePromptStartup(operation) {
  const next = promptStartupTail.then(operation);
  promptStartupTail = next.catch(() => {});
  return next;
}
async function focusWorkerForStartup(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab || !ownedWorker(tabId, workerOwners[tabId]))
    throw new Error('Worker tab is unavailable or no longer owned');
  await chrome.tabs.update(tabId,{active:true});
  await chrome.windows.update(tab.windowId,{focused:true});
  const visibleTab = await chrome.tabs.get(tabId);
  if (!visibleTab?.active || visibleTab.windowId !== tab.windowId)
    throw new Error('Worker tab could not be activated for page initialization');
}

async function startTask(tabId, site, text, waitSecs, cfg, autoClose = false, owner = 'legacy') {
  // Serializing submission—not inference—prevents an unfocused second tab
  // from racing against the first tab's deferred application initialization.
  const id = await serializePromptStartup(async () => {
    if (Object.values(tasks).some((task) => task.tabId === tabId &&
        ['running', 'uncertain'].includes(task.status))) {
      throw new Error('Worker has an outstanding task (running or uncertain); reconcile before reuse');
    }
    await focusWorkerForStartup(tabId);
    await waitReady(tabId,text);
    await confirmTabIdle(tabId,text);

    const taskId = crypto.randomUUID();
    const receiptNonce = crypto.randomUUID();
    const task = { id:taskId, tabId, site, status:'running', startedAt:Date.now(),
      autoClose, receiptNonce, owner,
      workerIncarnationId: workerIncarnations[tabId] || null };
    tasks[taskId] = task;
    taskLog.push(Date.now());
    await saveState();

    let ack;
    try {
      // The content script now acknowledges only after it confirms that
      // the user message was submitted; response collection continues async.
      ack = await tabMessage(tabId, {cmd:'run_prompt',taskId,receiptNonce,
        text,timeoutMs:cfg.taskTimeoutMin * 60000});
    } catch {
      if (task.status === 'running') {
        task.status = 'uncertain';
        task.error = 'Prompt submission receipt lost; inspect this tab before retrying';
        await saveState();
        (waiters[taskId] || []).forEach((resolve) => resolve());
        delete waiters[taskId];
      }
      return taskId;
    }
    if (!ack?.ok && task.status === 'running') {
      finishTask(taskId,ack?.uncertain
        ? {status:'uncertain',error:ack.error || 'Submission outcome uncertain'}
        : {status:'failed',error:ack?.error || 'Tab refused the task'});
    }
    return taskId;
  });
  if (waitSecs > 0 && tasks[id]?.status === 'running') {
    await waitTask(id,Math.min(waitSecs,50)*1000);
  }
  return summarize(tasks[id]);
}

// ------------------------------------------------------------------ calls
async function handleCall(method, p = {}) {
  await stateReady;
  const owner = callerOwner(p);
  if (p.__trustedPrincipal?.mode === 'profile') {
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
    case 'attest_profile_manager': {
      // The proxy supplies the requested tab; verify live browser incarnation.
      // This attests a tab, not the identity of a remote HTTP caller.
      const cfg = await getConfig();
      const tabId = p.tab_id ?? cfg.orchestratorTabId;
      if (!Number.isSafeInteger(tabId) || tabId <= 0)
        throw new Error('Caller tab ID required');
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || !siteOfUrl(tab.url)) throw new Error('Caller chat tab is unavailable');
      const observedSite=siteOfUrl(tab.url);
      if (managerSites[tab.id] && managerSites[tab.id] !== observedSite &&
          !workers.includes(tab.id)) {
        managerIncarnations[tab.id]=crypto.randomUUID();
        extensionDiagnostic('warn','identity.incarnation_rotated',{
          tabId:tab.id,reason:'provider_changed'});
      }
      if (!managerIncarnations[tab.id] && !workerIncarnations[tab.id])
        managerIncarnations[tab.id] = crypto.randomUUID();
      if (!workers.includes(tab.id)) managerSites[tab.id]=observedSite;
      await saveState();
      return { tab_id: tab.id, browser_session_id: browserSessionId,
        incarnation_id: workerIncarnations[tab.id] || managerIncarnations[tab.id],
        connection_generation: 1 };
    }
    case 'inspect_tab':
      return inspectChatTab(p.tab_id);
    case 'inspect_all_tabs': {
      const tabs = await chrome.tabs.query({url:TAB_PATTERNS});
      return tabs.map((tab) => ({tab_id:tab.id,site:siteOfUrl(tab.url),
        title:tab.title,active:tab.active,is_managed_worker:workers.includes(tab.id),
        incarnation_id:workerIncarnations[tab.id] || managerIncarnations[tab.id] || null}));
    }

    // Internal server-to-extension operations. These are deliberately NOT public
    // Worker Tool MCP registrations. The server supplies verified identity.
    case 'manager_state': {
      if (p.__trustedPrincipal?.mode !== 'profile') throw new Error('Configured profile manager required');
      const cfg = await getConfig();
      const manager = await callerManagerTab(p, cfg);
      const state = await tabMessage(manager, {cmd:'observe_state'});
      const page = await pageSettling.snapshot(manager);
      return {tab_id:manager,
        state:page.ready ? state?.state || 'unknown' : 'loading',
        ready:page.ready && state?.ok === true && state.state === 'idle',
        page,
        browser_session_id: browserSessionId,
        incarnation_id: workerIncarnations[manager] || managerIncarnations[manager] };
    }
    case 'wake_manager': {
      if (p.__trustedPrincipal?.mode !== 'profile') throw new Error('Configured profile manager required');
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
      const managerTab = await chrome.tabs.get(managerTabId);
      if (!managerTab || !siteOfUrl(managerTab.url)) throw new Error('Manager tab is unavailable');
      // Focus before the post-load settling and idle checks.
      await chrome.tabs.update(managerTabId,{active:true});
      await chrome.windows.update(managerTab.windowId,{focused:true});
      await chrome.windows.update(managerTab.windowId,{focused:true});
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
      if (p.__trustedPrincipal?.mode !== 'profile') throw new Error('Configured profile manager required');
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
      const tab = await createManagedWorkerTab(lost.url,p,managerTabId);
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
            if (p.__defer_start === true) {
              return {tab_id:prior.tabId,incarnation_id:prior.incarnationId,
                reused_tab:true,prepared:true,seat_role:p.role,seat_scope:p.role_scope};
            }
            // Initial role/context is already in this chat; new stages are follow-ups.
            const result = await startTask(prior.tabId, p.site, p.task, p.wait_seconds || 0, cfg, false, owner);
            return { ...result, reused_tab: true, seat_role: p.role, seat_scope: p.role_scope };
          }
          delete roleSeats[seatKey];
          await saveState();
        }
        const cfg = await guard({ newWorker: true });
        if (p.auto_close === true || (p.keep_open !== true && cfg.autoCloseWorkers)) {
          throw new Error('Automatic worker closure is disabled; parent review and explicit close_worker are required');
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
        const createdTab = await createManagedWorkerTab(site.newChatUrl,p,managerTabId);
        const tabId = createdTab.id;
        workers.push(tabId);
        workerOwners[tabId] = owner;
        workerIncarnations[tabId] = crypto.randomUUID();
        workerUrls[tabId] = site.newChatUrl;
        if (seatKey) roleSeats[seatKey] = {
          tabId, owner, incarnationId: workerIncarnations[tabId], role: p.role,
          scope: p.role_scope, site: p.site,
        };
        await saveState();
        if (p.__defer_start === true) {
          return {tab_id:tabId,incarnation_id:workerIncarnations[tabId],
            reused_tab:false,prepared:true,seat_role:p.role || null,seat_scope:p.role_scope || null};
        }
        // Completion stays in its tab until separately verified and approved.
        const result = await startTask(tabId, p.site, prompt, p.wait_seconds || 0, cfg, false, owner);
        return seatKey ? { ...result, reused_tab: false, seat_role: p.role, seat_scope: p.role_scope } : result;
      } finally {
        if (seatKey) roleSeatReservations.delete(seatKey);
      }
    }

    case 'start_prepared_worker': {
      const tabId = p.tab_id;
      if (!ownedWorker(tabId,owner) || workerIncarnations[tabId] !== p.expected_incarnation_id) {
        throw new Error('Prepared worker ownership/incarnation mismatch');
      }
      const cfg = await guard();
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (siteOfUrl(tab?.url) !== p.site) throw new Error('Prepared worker changed site');
      if (p.auto_close === true) throw new Error('Automatic worker closure is disabled');
      let contextTranscript = '';
      if (p.share_context_from) {
        const caller = await callerManagerTab(p,cfg);
        const srcId = p.share_context_from === 'orchestrator'
          ? caller : await resolveTab(p.share_context_from);
        requireOwnedTab(srcId,caller,owner);
        contextTranscript = (await tabMessage(srcId,{cmd:'read_chat'})).transcript;
      }
      const prompt = p.reused_tab === true ? p.task :
        buildWorkerPrompt(cfg,p.task,contextTranscript,p.role,p.prompt_text);
      const result = await startTask(tabId,p.site,prompt,p.wait_seconds || 0,cfg,false,owner);
      return {...result,reused_tab:p.reused_tab === true,
        seat_role:p.role || null,seat_scope:p.role_scope || null};
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
    case 'inspect_worker_tasks': {
      // Internal proxy operation: task IDs and statuses are the tool's own
      // execution identifiers; no Saga board is involved in worker closure.
      if (p.__trustedPrincipal?.mode !== 'profile' ||
          !ownedWorker(p.tab_id, owner) ||
          workerIncarnations[p.tab_id] !== p.worker_incarnation_id) {
        throw new Error('Worker ownership or incarnation changed');
      }
      const tab = await chrome.tabs.get(p.tab_id).catch(() => null);
      if (!tab || !siteOfUrl(tab.url)) throw new Error('Worker tab is unavailable');
      return {
        tab_id: p.tab_id,
        worker_incarnation_id: workerIncarnations[p.tab_id],
        tasks: Object.values(tasks)
          .filter((task) => task.tabId === p.tab_id && task.owner === owner &&
            task.workerIncarnationId === p.worker_incarnation_id)
          .map((task) => ({task_id:task.id,status:task.status}))
      };
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

    case 'close_reviewed_worker': {
      if (p.__trustedPrincipal?.mode !== 'profile' || p.parent_reviewed !== true) {
        throw new Error('Trusted parent review is required');
      }
      if (!ownedWorker(p.tab_id, owner) ||
          workerIncarnations[p.tab_id] !== p.worker_incarnation_id) {
        const absent = await chrome.tabs.get(p.tab_id).catch(() => null);
        if (!absent) return { closed: p.tab_id, already_closed: true };
        throw new Error('Profile worker incarnation mismatch');
      }
      if (Object.values(tasks).some((task) =>
          task.tabId === p.tab_id && ['running', 'uncertain'].includes(task.status))) {
        throw new Error('Cannot close a running or uncertain profile worker');
      }
      await closeWorkerTab(p.tab_id);
      return { closed: p.tab_id, parent_reviewed: true };
    }

    case 'close_worker': {
      if (!ownedWorker(p.tab_id, owner)) {
        const tab = await chrome.tabs.get(p.tab_id).catch(() => null);
        if (!tab && !workerOwners[p.tab_id]) return { closed: p.tab_id, already_closed: true };
        throw new Error('Worker is outside this caller scope');
      }
      if (owner !== 'legacy') {
        // Scoped workers close only after the proxy reviews parent ownership and task receipts.
        throw new Error('Profile worker closure requires proxy-verified parent review');
      }
      const tab = await chrome.tabs.get(p.tab_id).catch(() => null);
      if (!tab) return { closed: p.tab_id, already_closed: true };
      if (Object.values(tasks).some((t) => t.tabId === p.tab_id &&
          ['running', 'uncertain'].includes(t.status))) {
        throw new Error('Cannot close a worker while its task is running or uncertain');
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
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  wsState = 'connecting';
  try {
    ws = new WebSocket(cfg.serverUrl);
  } catch (err) {
    wsState = `error: ${err.message}`;
    return scheduleReconnect();
  }

  const thisSocket = ws;
  ws.onopen = () => {
    if (thisSocket !== ws) return;
    wsState = 'connected';
    extensionDiagnostic('info','bridge.connected',{connected:true});
    extensionDiagnostic('info','extension.build_loaded',{build:'grouping-20261108-v3'});
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
    extensionDiagnostic('debug','bridge.call_received',{requestId:msg.id,method:msg.method,
      tabId:msg.params?.tab_id});
    try {
      const result = await handleCall(msg.method, msg.params || {});
      extensionDiagnostic('debug','bridge.call_completed',{requestId:msg.id,
        method:msg.method,success:true});
      socket.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result }));
    } catch (err) {
      extensionDiagnostic('warn','bridge.call_failed',{requestId:msg.id,
        method:msg.method,success:false});
      socket.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: String(err?.message || err) }));
    }
  };

  ws.onclose = () => {
    if (thisSocket !== ws) return;
    wsState = 'disconnected';
    extensionDiagnostic('warn','bridge.disconnected',{connected:false});
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
  if (area === 'local' && changes.serverUrl) reconnectNow();
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
  pageSettling.onUpdated(tabId,changeInfo,tab);
  await stateReady;
  if (changeInfo?.url && managerIncarnations[tabId]) {
    const newSite = siteOfUrl(changeInfo.url);
    const previousSite = managerSites[tabId] || siteOfUrl(workerUrls[tabId] || tab?.url);
    // A manager is identified by its browser TAB incarnation, not the
    // ChatGPT conversation URL. A queue wake creates a /c/... navigation in
    // the same tab; rotating here invalidates the entire live FIFO queue.
    // Leaving the supported site or switching chat providers still revokes
    // the incarnation, so an unrelated navigation cannot retain authority.
    if (!newSite || (previousSite && newSite !== previousSite)) {
      managerIncarnations[tabId] = crypto.randomUUID();
      managerSites[tabId] = newSite || null;
      extensionDiagnostic('warn','identity.incarnation_rotated',{tabId,
        reason:!newSite?'unsupported_navigation':'provider_changed'});
      await saveState();
    } else {
      managerSites[tabId] = newSite;
      extensionDiagnostic('debug','identity.same_site_navigation',{tabId,site:newSite});
    }
  }
  const url=changeInfo?.url || tab?.url;
  if (typeof url==='string' && siteOfUrl(url)) {workerUrls[tabId]=url;void saveState();}
  await stateReady;
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  pageSettling.forget(tabId);
  const managed=workers.includes(tabId);
  const intentional=intentionalClosures.delete(tabId);
  const owner=workerOwners[tabId],incarnation=workerIncarnations[tabId],url=workerUrls[tabId];
  const task=Object.values(tasks).filter(t=>t.tabId===tabId&&t.workerIncarnationId===incarnation)
    .sort((a,b)=>b.startedAt-a.startedAt)[0];
  workers=workers.filter(id=>id!==tabId);
  delete workerOwners[tabId];delete workerIncarnations[tabId];delete workerUrls[tabId];
  clearRoleSeatsForTab(tabId);delete managerIncarnations[tabId];delete managerSites[tabId];
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
      case 'browser_page_settled': {
        if (sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
            !Number.isSafeInteger(sender.tab?.id) ||
            !siteOfUrl(sender.tab?.url)) {
          sendResponse({ok:false,error:'Page-readiness request did not originate from a supported top-level chat tab'});
          break;
        }
        const timeout = Number.isSafeInteger(msg.timeoutMs)
          ? Math.min(45000,Math.max(1000,msg.timeoutMs)) : 12000;
        const ready = await pageSettling.waitForReady(sender.tab.id,timeout);
        sendResponse({ok:true,...ready});
        break;
      }
      case 'task_done': {
        const task = tasks[msg.taskId];
        if (!task || sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
            sender.tab?.id !== task.tabId ||
            msg.receiptNonce !== task.receiptNonce ||
            typeof msg.ok !== 'boolean') {
          sendResponse({ ok: false, error: 'Unverified worker completion source' });
          break;
        }
        // An authenticated, nonce-matched completion is sufficient to resolve
        // an uncertain submission without submitting the prompt again.
        if (!['running', 'uncertain'].includes(task.status)) {
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
        if (msg.uncertain === true && msg.ok === false) {
          finishTask(msg.taskId, {status:'uncertain',error:msg.error});
          sendResponse({ok:true,uncertain:true});
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
          cfg: { serverUrl: cfg.serverUrl, orchestratorTabId: cfg.orchestratorTabId },
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
  })().catch((error) => {
    sendResponse({ok:false,error:String(error?.message || error)});
  });
  return true;
});

connect();