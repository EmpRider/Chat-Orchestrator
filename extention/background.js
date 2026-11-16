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
let proxySessionId = null;
let socketGeneration = 0;
let connectionGeneration = 0;
let lastHeartbeatAck = Date.now();
let heartbeatNonce = null;
let connectPromise = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A page can keep heartbeats, analytics and streaming requests open forever.
// Readiness depends on browser document completion, a short settling interval,
// and the provider composer's independent readiness/ownership checks.
const pageSettling = (() => {
  const SETTLE_MS = 2500;
  const loaded = new Map(); // tab ID -> completion time + URL; in-memory only
  const lastSnapshot=new Map();

  const trace=(tabId,step,fields={})=>extensionDiagnostic('debug','page_settling.'+step,{tabId,...fields});
  function complete(tabId, tab) {
    if (tab?.status !== 'complete' || !siteOfUrl(tab.url)) return;
    const previous = loaded.get(tabId);
    if (!previous || previous.url !== tab.url) {
      loaded.set(tabId, {url:tab.url,at:Date.now()});
      trace(tabId,'document_complete',{site:siteOfUrl(tab.url),urlChanged:Boolean(previous)});
    }
  }
  function onUpdated(tabId, changeInfo, tab) {
    if (changeInfo?.status === 'loading') {
      const wasTracked=loaded.delete(tabId);
      trace(tabId,'document_loading',{wasTracked,site:siteOfUrl(tab?.url || '') || 'unsupported'});
    }
    if (changeInfo?.status === 'complete') complete(tabId,tab);
  }
  async function snapshot(tabId) {
    const tab=await chrome.tabs.get(tabId).catch(()=>null);
    const documentComplete=tab?.status==='complete' && !!siteOfUrl(tab?.url);
    if (!documentComplete) {
      const wasTracked=loaded.delete(tabId);
      const result={ready:false,documentComplete:false,settledMs:0,remainingMs:SETTLE_MS};
      const signature=[false,tab?.status || 'missing',wasTracked].join(':');
      if(lastSnapshot.get(tabId)!==signature){
        trace(tabId,'snapshot_incomplete',{tabExists:Boolean(tab),tabStatus:tab?.status || 'missing',wasTracked});
        lastSnapshot.set(tabId,signature);
      }
      return result;
    }
    // On service-worker restart the original load event may be gone.
    // Begin a fresh settling interval rather than trusting stale readiness.
    complete(tabId,tab);
    const settledMs=Math.max(0,Date.now()-loaded.get(tabId).at);
    const result={ready:settledMs>=SETTLE_MS,documentComplete:true,
      settledMs,remainingMs:Math.max(0,SETTLE_MS-settledMs)};
    const signature=[true,result.ready,Math.floor(settledMs/500)].join(':');
    if(lastSnapshot.get(tabId)!==signature){
      trace(tabId,'snapshot',{ready:result.ready,settledMs,remainingMs:result.remainingMs});
      lastSnapshot.set(tabId,signature);
    }
    return result;
  }
  async function waitForReady(tabId, timeoutMs=45000) {
    const startedAt=Date.now(),deadline=startedAt+timeoutMs;
    let last, polls=0;
    trace(tabId,'wait_begin',{timeoutMs});
    do {
      polls++;
      last=await snapshot(tabId);
      if(last.ready) {
        trace(tabId,'wait_ready',{polls,durationMs:Date.now()-startedAt,settledMs:last.settledMs});
        return last;
      }
      await sleep(Math.min(200,Math.max(1,deadline-Date.now())));
    } while(Date.now()<deadline);
    trace(tabId,'wait_timeout',{polls,durationMs:Date.now()-startedAt,
      documentComplete:last?.documentComplete===true,remainingMs:last?.remainingMs ?? null});
    throw new Error('Browser page did not settle after load for tab '+tabId+
      ': documentComplete='+last?.documentComplete+
      ', remainingMs='+last?.remainingMs);
  }
  function forget(tabId) {loaded.delete(tabId);lastSnapshot.delete(tabId);trace(tabId,'forgotten',{});}
  return {snapshot,waitForReady,onUpdated,forget};
})();

const getConfig = async () => ({
  ...DEFAULTS,
  ...(await chrome.storage.local.get(Object.keys(DEFAULTS))),
  ...(proxySettings || {enabled: false, maxWorkers: 0, maxTasksPerHour: 0, taskTimeoutMin: 0,
    promptSchema: 2, promptModules: {}}),
  autoCloseWorkers: false, // Parent must explicitly review and close workers.
});
// Trusted profile settings provide the display name. It is a routing hint,
// not authentication and never comes from webpage or model-supplied text.
function localConnectorGuidance(name) {
  if(typeof name!=='string' || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(name) ||
      name.trim()!==name) {
    return 'If multiple Chat Orchestrator MCP connectors exist, do not guess which PC '+
      'owns this pairing code. Ask the user to configure its exact ChatGPT connector '+
      'name in this PC\'s Chat Orchestrator Connections settings.';
  }
  return 'The ChatGPT MCP connector for THIS PC is named "'+name+'". '+
    'Use ONLY that exact named connector for every Chat Orchestrator MCP tool call. '+
    'Never use another PC\'s connector even when tool names match. '+
    'If that connector is missing or ambiguous, stop and ask the user; do not fall back. '+
    'The connector name does not grant access or replace pairing credentials.';
}
function requireConnectorRoutingReady() {
  if(!proxySettings || proxySettingsRevision<1 || wsState!=='connected')
    throw new Error('Extension settings are not synchronized yet. Reconnect or reload the bundled extension.');
  if(!proxySettings.connectorName)
    throw new Error('Set the exact ChatGPT MCP connector name in Connections > One-time browser setup first.');
  return localConnectorGuidance(proxySettings.connectorName);
}
function acceptProxySettings(msg) {
  if (msg.schema !== 1 || !Number.isSafeInteger(msg.revision) || msg.revision <= 0 ||
      msg.revision < proxySettingsRevision ||
      !msg.settings || typeof msg.settings !== 'object') return false;
  const c = msg.settings;
  const names=['core','task','workspace','delegation','queue','child_result','status_request','child_tab_lost','failure'];
  const monitor=c.completionMonitor;
  if(c.promptSchema!==2 || typeof c.enabled!=='boolean' ||
       (c.connectorName!==undefined && (typeof c.connectorName!=='string' ||
         (c.connectorName!=='' && (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(c.connectorName) ||
           c.connectorName.trim()!==c.connectorName)))) ||
      !Number.isSafeInteger(c.maxWorkers)||c.maxWorkers<1||c.maxWorkers>10||
      !Number.isSafeInteger(c.maxTasksPerHour)||c.maxTasksPerHour<1||c.maxTasksPerHour>500||
      !Number.isSafeInteger(c.taskTimeoutMin)||c.taskTimeoutMin<1||c.taskTimeoutMin>60||
      !monitor||!Number.isSafeInteger(monitor.initialMinutes)||
      monitor.initialMinutes<1||monitor.initialMinutes>60||
      !Number.isSafeInteger(monitor.hydrationSeconds)||
      monitor.hydrationSeconds<4||monitor.hydrationSeconds>15||
      !Number.isSafeInteger(monitor.continuedMinutes)||
      monitor.continuedMinutes<1||monitor.continuedMinutes>60||
      !Array.isArray(monitor.retryMinutes)||monitor.retryMinutes.length<1||
      monitor.retryMinutes.length>8||
      monitor.retryMinutes.some((n)=>!Number.isSafeInteger(n)||n<1||n>60)||
      !c.promptModules||typeof c.promptModules!=='object'||
      names.some(k=>typeof c.promptModules[k]!=='string'||!c.promptModules[k].trim()||c.promptModules[k].length>8192))return false;
  proxySettings={enabled:c.enabled,maxWorkers:c.maxWorkers,maxTasksPerHour:c.maxTasksPerHour,
    connectorName:c.connectorName??'',
    taskTimeoutMin:c.taskTimeoutMin,promptSchema:2,
    completionMonitor:{initialMinutes:monitor.initialMinutes,
      retryMinutes:[...monitor.retryMinutes],hydrationSeconds:monitor.hydrationSeconds,
      continuedMinutes:monitor.continuedMinutes},
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

function safeConversationRoute(url) {
  try {
    const parsed=new URL(url);
    if (parsed.protocol!=='https:' || siteOfUrl(parsed.href)!=='chatgpt' ||
        parsed.username || parsed.password || parsed.port) return null;
    if (!/^\/c\/[a-z0-9-]{20,80}\/?$/i.test(parsed.pathname)) return null;
    return parsed.origin+parsed.pathname;
  } catch {return null;}
}

function normalizedClosedTabUrl(url) {
  try {
    const parsed=new URL(url);
    if (parsed.protocol!=='https:' || !siteOfUrl(parsed.href) ||
        parsed.username || parsed.password || parsed.port) return null;
    if (siteOfUrl(parsed.href)==='chatgpt' &&
        !/^\/c\/[a-z0-9-]{20,80}\/?$/i.test(parsed.pathname)) return null;
    if (parsed.pathname.length>180) return null;
    return parsed.origin+parsed.pathname;
  } catch {return null;}
}

function descendantsOf(parentId) {
  const output=[];
  const visited=new Set([parentId]);
  const search=(id)=>{
    for(const childId of workers.filter((tabId)=>workerParents[tabId]===id)) {
      if(visited.has(childId)) continue;
      visited.add(childId);
      const state=Object.values(tasks).filter((task)=>task.tabId===childId)
        .sort((a,b)=>b.startedAt-a.startedAt)[0]?.status||'idle';
      output.push({tabId:childId,parentTabId:id,site:siteOfUrl(workerUrls[childId]),
        title:(tabTitles[childId]||'Child Agent').slice(0,140),state,
        incarnationId:workerIncarnations[childId],
        lastUrl:normalizedClosedTabUrl(workerUrls[childId])});
      search(childId);
    }
  };
  search(parentId);
  return output;
}

async function persistedClosureDecisions() {
  const data=await chrome.storage.local.get('pendingAgentClosures');
  return Array.isArray(data.pendingAgentClosures)?data.pendingAgentClosures:[];
}

function persistAgentClosure(entry) {
  const operation=closureWriteTail.then(async()=>{
    const list=await persistedClosureDecisions();
    if (list.some((item)=>item.browserSessionId===entry.browserSessionId &&
        item.oldTabId===entry.oldTabId && item.incarnationId===entry.incarnationId))
      return list;
    if(list.filter((item)=>item.status==='pending').length>=100)
      throw new Error('Too many pending closure decisions; manual recovery required');
    const updated=[...list,entry].slice(-150);
    await chrome.storage.local.set({pendingAgentClosures:updated});
    return updated;
  });
  closureWriteTail=operation.catch(()=>{});
  return operation;
}

// D-026: extension may miss tab onRemoved while stopped. A successful browser
// inventory is stronger evidence than a missing WebSocket event. Never infer
// a closure from an offline/failed query, and never create a replacement or
// change Child ownership without an explicit Desktop Accident/Yes/Cancel.
async function reconcileMissedParentClosures() {
  await stateReady;
  const open=await chrome.tabs.query({}); // Query failure => no assertion.
  if(!Array.isArray(open))throw new Error('Browser inventory unavailable');
  const openIds=new Set(open.map((tab)=>tab.id));
  let recorded=0,retired=0;
  for(const [key,incarnation] of Object.entries(approvedParents)){
    const tabId=Number(key);
    if(!Number.isSafeInteger(tabId)||tabId<1||openIds.has(tabId)||
        managerIncarnations[tabId]!==incarnation)continue;
    // Explicit Desktop Quit is not an accidental Parent disappearance, even
    // when MV3 was suspended before tabs.onRemoved could observe that tab.
    if(await intentionalDesktopExitFor(tabId,incarnation)){
      delete approvedParents[tabId];
      delete managerIncarnations[tabId];
      delete managerSites[tabId];
      delete tabTitles[tabId];
      retired++;
      continue;
    }
    const outstanding=(await persistedClosureDecisions()).some((entry)=>
      entry.browserSessionId===browserSessionId &&
      entry.oldTabId===tabId&&entry.incarnationId===incarnation &&
      entry.status!=='resolved');
    if(!outstanding) {
      await persistAgentClosure({
        id:crypto.randomUUID(),browserSessionId,oldTabId:tabId,
        incarnationId:incarnation,kind:'parent',parentTabId:null,
        originalOwner:null,url:normalizedClosedTabUrl(workerUrls[tabId]),
        title:(tabTitles[tabId]||'Previously approved Parent').slice(0,140),
        descendants:descendantsOf(tabId),
        createdAt:Date.now(),status:'pending',
        source:'verified_absent_after_reconnect',
      });
      recorded++;
    }
    delete approvedParents[tabId];
    retired++;
  }
  if(retired)await saveState();
  return {recorded,intentionally_retired:retired-recorded,inventory_verified:true};
}

// D-068: MV3 suspension or a disconnected extension can also miss a Child's
// onRemoved event. Reuse the *same* user-mediated closure handling as a live
// removal; never silently discard an absent Child merely to free a worker slot.
async function reconcileMissedChildClosures() {
  await stateReady;
  const open=await chrome.tabs.query({});
  if(!Array.isArray(open))throw new Error('Browser inventory unavailable');
  const openIds=new Set(open.map((tab)=>tab.id));
  let examined=0;
  for(const tabId of [...workers]){
    if(openIds.has(tabId))continue;
    if(!/^[0-9a-f-]{36}$/i.test(workerIncarnations[tabId]||''))
      throw new Error('Absent Child has no reliable incarnation; manual reconciliation required');
    await handleManagedTabRemoved(tabId);
    examined++;
  }
  return {examined,inventory_verified:true};
}

function changePersistedClosure(id,operation) {
  const pending=closureWriteTail.then(async()=>{
    const list=await persistedClosureDecisions();
    const index=list.findIndex((item)=>item.id===id);
    if(index<0) throw new Error('Closure decision is no longer available');
    const original=list[index];
    const updated=await operation({...original});
    if (!updated || updated.id!==id) throw new Error('Invalid closure decision transition');
    list[index]=updated;
    await chrome.storage.local.set({pendingAgentClosures:list});
    return updated;
  });
  closureWriteTail=pending.catch(()=>{});
  return pending;
}

async function verifiedPendingClosure(id,allowRestoring=false) {
  if (typeof id!=='string' ||
      !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id))
    throw new Error('Valid closure decision ID required');
  await closureWriteTail;
  const decision=(await persistedClosureDecisions()).find((entry)=>entry.id===id);
  if (!decision || decision.browserSessionId!==browserSessionId ||
      !['pending',...(allowRestoring?['restoring','creating','restoring_children']:[])].includes(decision.status))
    throw new Error('Closure decision is unavailable or belongs to a different browser session');
  if(Date.now()-decision.createdAt<5000)
    throw new Error('Closure decision buttons are disabled for five seconds');
  const tab=await chrome.tabs.get(decision.oldTabId).catch(()=>null);
  if (tab && ((decision.kind==='parent' &&
        managerIncarnations[decision.oldTabId]===decision.incarnationId) ||
      (decision.kind==='child' &&
        workerIncarnations[decision.oldTabId]===decision.incarnationId)))
    throw new Error('Original Agent tab is unexpectedly still present');
  return decision;
}

async function parentOriginRoute(p,cfg) {
  const tabId=await callerManagerTab(p,cfg);
  const tab=await chrome.tabs.get(tabId).catch(()=>null);
  return safeConversationRoute(tab?.url);
}

// ------------------------------------------------------------------ state
let tasks = {}; // taskId -> task
let workers = []; // tab ids opened by spawn_worker
let taskLog = []; // timestamps, for rate limiting
let workerOwners = {}; // worker tab id -> local profile ownership; legacy tasks remain separate
let workerParents = {}; // worker tab id -> direct Parent tab id, preserved for dependency gating
let workerIncarnations = {}; // tab id -> UUID assigned at creation, never inferred from reused tab IDs
let workerUrls = {}; // last known supported chat URL
let detachedTabNotices = {}; // Cancel leaves live descendants unmanaged but visibly orphaned
let dismissedParentOffers = {}; // A user's No is sticky for that physical tab
let lostWorkers = {}; // original task ID -> recoverable, owner-bound closed conversation
let queuedFollowups = []; // accepted but not yet submitted; operational instructions, not chat archives
let queuedIndependent = []; // new independent tasks wait for explicit Parent review
const queuedDispatches = new Set();
const independentDispatches = new Set();
const intentionalClosures = new Set();
// Chrome may suspend the MV3 worker while the entire browser profile is being
// closed. Persist only the exact managed tab/incarnation IDs selected by the
// user's explicit Desktop Quit; ordinary user tab closures remain interactive.
const INTENTIONAL_EXIT_TTL_MS=2*60*1000;
async function intentionalDesktopExitFor(tabId,incarnationId){
  if(!incarnationId)return false;
  try{
    const {intentionalManagedExit}=await chrome.storage.local.get('intentionalManagedExit');
    return intentionalManagedExit?.browserSessionId===browserSessionId &&
      Number.isFinite(intentionalManagedExit.createdAt) &&
      Date.now()>=intentionalManagedExit.createdAt &&
      Date.now()-intentionalManagedExit.createdAt<INTENTIONAL_EXIT_TTL_MS &&
      Array.isArray(intentionalManagedExit.tabs) &&
      intentionalManagedExit.tabs.some((tab)=>tab.tabId===tabId &&
        tab.incarnationId===incarnationId);
  }catch{return false;} // Missing/unreadable evidence never suppresses a closure decision.
}
let roleSeats = {}; // profile + reusable seat label -> one reusable tab
const roleSeatReservations = new Set(); // serialize simultaneous same-seat startup
const workerSlotReservations = new Set(); // atomic slots across concurrent spawn calls
let managerWakes = {}; // batch UUID -> one-shot manager submission ledger (session only)
let browserSessionId = null; // chrome.storage.session resets after browser restart
let managerIncarnations = {}; // tab id -> attested UUID in this browser session
let managerSites = {}; // tab id -> last attested provider; never store URLs
let approvedParents = {}; // tab id -> explicit user-approved root incarnation
let parentInitializations = {}; // tab incarnation -> single approval-triggered send attempt
let tabTitles = {}; // short user-visible labels, never part of authorization
let closureWriteTail=Promise.resolve(); // serialize whole-window multi-tab close events
let workspaceWindow = null; // {windowId, anchorTabId, browserSessionId}; never an owner key
let workspaceGroups = {}; // root tab+incarnation -> {groupId, windowId, rootTabId, rootIncarnationId}
let workspaceSerial = Promise.resolve(); // serializes concurrent managed-window/group creation
const waiters = {}; // taskId -> [resolve]

// Privacy-preserving extension diagnostics: schema is intentionally small.
// Never serialize a prompt, response, URL, token, error.message or full tab.
const DIAG_FIELDS = new Set(['tabId','rootTabId','parentTabId','windowId','groupId',
  'expectedWindowId','actualWindowId','expectedGroupId','actualGroupId','requestId',
  'batchId','taskId','method','phase','site','reason','attempt','count','batchSize',
  'success','reused','connected','build','durationMs','settledMs','remainingMs','polls',
  'timeoutMs','wasTracked','urlChanged','tabExists','tabStatus','documentComplete',
  'ready','active','browserSessionId','taskLength','lineCount','deferred','roleScopePresent',
  'promptLength','contextLength','maxWorkers','maxTasksPerHour','taskTimeoutMin','expectedLength',
  'tasksLastHour','focused','workerOwned','incarnationPresent','createdTab','blockingCount',
  'scriptCount','errorType','replyOk','state','draftLength','expectedLength','matchingDraft',
  'whitespaceEquivalent','uncertain','notSubmitted','unresolved','cmd','senderTabId',
  'frameId','ok','selectedIndex','newlineCount','actualCodePoint','expectedCodePoint',
  'actualLength','reusedTab','prepared','workerCount','taskCount','status','exactMatch',
  'whitespaceMatch','firstDifference','formTestId','activeTag','activeRole','contentEditable',
  'ariaLabel','testId','enabled','disabled','ariaDisabled','inComposer','scopeTag','scopeTestId']);
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
  const s = await chrome.storage.session.get(['tasks', 'workers', 'taskLog', 'workerOwners', 'workerParents', 'workerIncarnations', 'roleSeats', 'managerWakes', 'browserSessionId', 'managerIncarnations', 'managerSites', 'approvedParents', 'parentInitializations', 'tabTitles', 'workerUrls', 'detachedTabNotices', 'dismissedParentOffers', 'lostWorkers','queuedFollowups','queuedIndependent','workspaceWindow','workspaceGroups','proxySessionId']);
  proxySessionId = s.proxySessionId || null;
  tasks = s.tasks || {};
  workers = s.workers || [];
  taskLog = s.taskLog || [];
  workerOwners = s.workerOwners || {};
  workerParents = s.workerParents || {};
  workerIncarnations = s.workerIncarnations || {};
  workerUrls = s.workerUrls || {};
  detachedTabNotices = s.detachedTabNotices || {};
  dismissedParentOffers = s.dismissedParentOffers || {};
  lostWorkers = s.lostWorkers || {};
  queuedFollowups = Array.isArray(s.queuedFollowups) ? s.queuedFollowups : [];
  queuedIndependent = Array.isArray(s.queuedIndependent) ? s.queuedIndependent : [];
  roleSeats = s.roleSeats || {};
  managerWakes = s.managerWakes || {};
  browserSessionId = /^[0-9a-f-]{36}$/i.test(s.browserSessionId || '')
    ? s.browserSessionId : crypto.randomUUID();
  managerIncarnations = s.managerIncarnations || {};
  managerSites = s.managerSites || {};
  approvedParents = s.approvedParents || {};
  parentInitializations = s.parentInitializations || {};
  tabTitles = s.tabTitles || {};
  workspaceWindow = s.workspaceWindow?.browserSessionId === browserSessionId ? s.workspaceWindow : null;
  workspaceGroups = workspaceWindow && s.workspaceGroups && typeof s.workspaceGroups === 'object'
    ? s.workspaceGroups : {};
  await chrome.storage.session.set({ browserSessionId, managerIncarnations, managerSites });
})();

const saveState = () => chrome.storage.session.set({ tasks, workers, taskLog, workerOwners, workerParents, workerIncarnations, workerUrls, detachedTabNotices, dismissedParentOffers, lostWorkers,queuedFollowups,queuedIndependent,roleSeats,managerWakes,browserSessionId,managerIncarnations,managerSites,approvedParents,parentInitializations,tabTitles,workspaceWindow,workspaceGroups });

async function resetSession() {
  await stateReady;
  for (const resolvers of Object.values(waiters)) resolvers.forEach((resolve) => resolve());
  for (const key of Object.keys(waiters)) delete waiters[key];
  tasks = {}; workers = []; taskLog = [];
  workerOwners = {}; workerParents = {}; workerIncarnations = {}; workerUrls = {}; detachedTabNotices = {}; dismissedParentOffers = {}; lostWorkers = {}; queuedFollowups = []; queuedIndependent = [];
  roleSeats = {}; managerWakes = {}; managerIncarnations = {}; managerSites = {}; approvedParents = {}; parentInitializations = {}; tabTitles = {};
  workspaceWindow = null; workspaceGroups = {};
  browserSessionId = crypto.randomUUID();
  proxySessionId = null;
  connectionGeneration = 0;
  await chrome.storage.session.remove(['proxySessionId',
    'tasks','workers','taskLog','workerOwners','workerParents','workerIncarnations','workerUrls','detachedTabNotices','dismissedParentOffers','lostWorkers','queuedFollowups','queuedIndependent',
    'roleSeats','managerWakes','browserSessionId','managerIncarnations','managerSites','approvedParents','parentInitializations','tabTitles',
    'workspaceWindow','workspaceGroups']);
  await saveState();
}

// Proxy restart must not erase the Child tabs that are still open in Chrome.
async function preserveOnProxyReconnect(nextProxySessionId) {
  await stateReady;
  for (const task of Object.values(tasks)) {
    if (task.status==='running') {
      task.status='uncertain';
      task.error='Proxy restarted during task; inspect its existing response';
    }
  }
  for (const wake of Object.values(managerWakes))
    if (wake.status!=='processed') wake.status='uncertain';
  proxySessionId=nextProxySessionId;
  await saveState();
  await chrome.storage.session.set({proxySessionId});
}

function callerOwner(p = {}) {
  const principal = p.__trustedPrincipal;
  if (!principal || principal.mode === 'legacy') return 'legacy';
  if (principal.mode !== 'profile' ||
      typeof principal.browserSessionId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(principal.browserSessionId) ||
      !/^[0-9a-f-]{36}$/i.test(principal.credentialId) ||
      !Number.isSafeInteger(principal.callerTabId) || principal.callerTabId <= 0) {
    throw new Error('Invalid profile caller context');
  }
  return `credential:${principal.credentialId}`;
}

function ownedWorker(tabId, owner) {
  return workers.includes(tabId) && (workerOwners[tabId] || 'legacy') === owner;
}

function isApprovedParent(tabId) {
  const incarnation=managerIncarnations[tabId];
  // Without an explicit stored UUID, undefined === undefined must NEVER
  // grant Parent status, page injection, closure prompts or MCP authority.
  return !workers.includes(tabId) &&
    typeof incarnation==='string' &&
    /^[0-9a-f-]{36}$/i.test(incarnation) &&
    approvedParents[tabId]===incarnation;
}

function managedAgentStatus(tabId) {
  const worker=workers.includes(tabId);
  const parent=isApprovedParent(tabId);
  return {managed:worker||parent,role:parent?'parent':worker?'child':null,
    detached:!worker&&!parent&&detachedTabNotices[tabId]===true,
    offerParent:!worker&&!parent&&!detachedTabNotices[tabId] &&
      !dismissedParentOffers[tabId] && wsState==='connected' &&
      ws?.readyState===WebSocket.OPEN,
    connected:wsState==='connected'&&ws?.readyState===WebSocket.OPEN,
    activeChildren:workers.filter((id)=>workerParents[id]===tabId).length};
}
async function pushManagedAgentStatus(tabId) {
  try {
    const tab=await chrome.tabs.get(tabId);
    if(siteOfUrl(tab?.url)!=='chatgpt')return;
    await chrome.tabs.sendMessage(tabId,{
      cmd:'set_managed_agent_status',status:managedAgentStatus(tabId)});
  } catch { /* A newly loading or closed tab will request status itself. */ }
}
async function pushAllManagedAgentStatuses() {
  await stateReady;
  const ids=new Set([...workers,...Object.keys(approvedParents).map(Number),
    ...Object.keys(detachedTabNotices).map(Number)]);
  // Newly detected supported ChatGPT tabs remain unregistered until the
  // human answers Yes. Notify those ordinary tabs about the opt-in offer too.
  try {
    const open=await chrome.tabs.query({url:['https://chatgpt.com/*','https://chat.openai.com/*']});
    for(const tab of open)if(Number.isSafeInteger(tab.id))ids.add(tab.id);
  }catch{}
  for(const id of ids)void pushManagedAgentStatus(id);
}

// Focusly-style page-facing focus emulation, limited to managed ChatGPT tabs.
// The early MAIN-world bootstrap is inert until explicitly enabled here.
async function enableManagedAntiFreeze(tabId) {
  await stateReady;
  if(!managedAgentStatus(tabId).managed ||
      !chrome.scripting?.executeScript)return false;
  const tab=await chrome.tabs.get(tabId).catch(()=>null);
  if(siteOfUrl(tab?.url)!=='chatgpt')return false;
  try {
    // Old tabs may predate this extension reload; reinstalling is idempotent.
    await chrome.scripting.executeScript({
      target:{tabId,allFrames:false},world:'MAIN',
      files:['managed-focus-main.js'],
    });
    const activation=await chrome.scripting.executeScript({
      target:{tabId,allFrames:false},world:'MAIN',
      func:()=>document[Symbol.for('chat-orchestrator.managed-focus.v2')]
        ?.setEnabled(true)===true,
    });
    const verified=activation?.[0]?.result===true;
    if(!verified)extensionDiagnostic('warn','worker.focus_emulation_unverified',{tabId});
    return verified;
  } catch(error) {
    extensionDiagnostic('warn','worker.focus_emulation_failed',{
      tabId,errorType:error?.name||'Error'});
    return false;
  }
}
async function disableManagedAntiFreeze(tabId) {
  if(!chrome.scripting?.executeScript)return;
  try {
    await chrome.scripting.executeScript({
      target:{tabId,allFrames:false},world:'MAIN',
      func:()=>{
        document[Symbol.for('chat-orchestrator.managed-focus.v2')]
          ?.setEnabled(false);
      },
    });
  } catch{}
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
  if (!tab || !siteOfUrl(tab.url)) throw new Error(
    `Manager tab ${principal.callerTabId} is unavailable or no longer on a supported chat page; `+
    'Recheck/Retry require the original paired tab. If it cannot be restored, use Skip batch ' +
    'with an operator reason to release the FIFO without sending another notification');
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
  // D-053: provider or conversation navigation in an existing physical tab
  // does not rotate its approved logical Agent identity. Browser closure and
  // explicit detach revoke identity; unsupported pages simply cannot call.
  if (!incarnation) incarnation = managerIncarnations[tabId] = crypto.randomUUID();
  if (!workers.includes(tabId) && managerSites[tabId] !== site) {
    managerSites[tabId] = site;
    await saveState();
  } else if (managerIncarnations[tabId] === incarnation && !managerSites[tabId]) {
    managerSites[tabId]=site;
    await saveState();
  }
  const identity = new TextEncoder().encode([browserSessionId,tabId,incarnation,site].join(':'));
  const digest = await crypto.subtle.digest('SHA-256',identity);
  const routeHash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join('');
  return {tab_id:tabId, site, browser_session_id:browserSessionId,
    incarnation_id:incarnation, route_hash:routeHash,
    parent_approved:isApprovedParent(tabId),
    is_managed_worker:workers.includes(tabId)};
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
    submission_confirmed: t.submissionConfirmed === true,
  };
  if (t.originParentUrl) out.origin_parent_url=t.originParentUrl;
  if (Number.isSafeInteger(t.recoveredTabId)) {
    out.recovered_tab_id=t.recoveredTabId;
    out.note='A replacement browser tab exists. Inspect it manually; the original task has not been replayed or proven complete.';
  }
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
  if (t.status === 'queued') out.note = 'Accepted into this Child FIFO; prompt has NOT been submitted yet.';
  if (t.status === 'closed_pending_decision')
    out.note = 'Agent tab closed. Waiting for the user to choose Accident / Yes / Cancel; the task has NOT been marked complete or automatically replayed.';
  if (t.status === 'detached')
    out.note = 'The user chose Cancel. The browser conversation may remain open, but the Agent is no longer managed and this task was not verified complete.';
  if (t.status === 'waiting_for_children')
    out.note = 'This Agent response finished, but its delegated descendants must finish and be reviewed before the task is complete.';
  if (t.status === 'waiting_for_parent_context') {
    out.note='Child requested instructions from its direct Parent. The original task remains pending.';
    out.context_pending=true;
  }
  if (t.status === 'running') out.note = 'Still running. Finish your current response and await the orchestrator completion notification; do not repeatedly poll get_result.';
  return out;
}

function hasUnreviewedDescendants(parentTabId,seen=new Set()) {
  if (seen.has(parentTabId)) return true; // corrupted cycle: fail closed
  seen.add(parentTabId);
  for (const childId of workers.filter((id)=>workerParents[id]===parentTabId)) {
    const childTasks=Object.values(tasks).filter((task)=>task.tabId===childId);
    // A recovered tab may have no *new* task: after explicit Parent review
    // of its original lost task that tab is safe to keep open without
    // deadlocking its own Parent's waiting_for_children completion.
    const recoveredAndReviewed=Object.values(lostWorkers).some((entry)=>
      entry.reopenedTabId===childId && entry.reviewResolved===true &&
      workerIncarnations[childId]===entry.reopenedIncarnation);
    if ((childTasks.length===0 && !recoveredAndReviewed) || childTasks.some((task)=>
        !['done','failed'].includes(task.status) || task.parentReviewed!==true))
      return true;
    if (hasUnreviewedDescendants(childId,new Set(seen))) return true;
  }
  return Object.values(lostWorkers).some((entry)=>
    entry.parentTabId===parentTabId && entry.reviewResolved!==true);
}

async function releaseReadyParentTasks() {
  const ready=Object.values(tasks).filter((task)=>
    task.status==='waiting_for_children' && !hasUnreviewedDescendants(task.tabId));
  for (const task of ready) {
    const result=task.deferredCompletion;
    if (!result || !['done','failed'].includes(result.status)) continue;
    delete task.deferredCompletion;
    Object.assign(task,result,{finishedAt:Date.now()});
    await saveState();
    (waiters[task.id] || []).forEach((r)=>r());
    delete waiters[task.id];
    try {await submitPrivateWorkerReceipt(task);}
    catch {/* The original result remains terminal and can be reconciled without re-submission. */}
    void dispatchQueuedFollowups(task.tabId);
    void dispatchQueuedIndependent(task.tabId);
  }
}

function finishTask(id, patch) {
  const t = tasks[id];
  if (!t || !['running', 'uncertain'].includes(t.status)) return;
  if (['done','failed'].includes(patch.status) && hasUnreviewedDescendants(t.tabId)) {
    t.status='waiting_for_children';
    t.deferredCompletion=patch;
    void saveState();
    return;
  }
  Object.assign(t, patch, { finishedAt: Date.now() });
  saveState();
  (waiters[id] || []).forEach((r) => r());
  delete waiters[id];
  if (['done','failed'].includes(patch.status))
    void Promise.resolve().then(() => dispatchQueuedFollowups(t.tabId));
}

function waitTask(id, ms) {
  return new Promise((resolve) => {
    const t = tasks[id];
    if (!t || t.status !== 'running' || ms <= 0) return resolve();
    (waiters[id] ||= []).push(resolve);
    setTimeout(resolve, ms);
  });
}

// D-044: the monitor is an observation scheduler, NOT a prompt retry loop.
// Every scheduled check is claimed durably before reloading the verified tab,
// so service-worker restarts cannot overlap refreshes on the same task.
const completionChecksInFlight=new Set();
function completionMonitorSettings(){
  return proxySettings?.completionMonitor||{
    initialMinutes:5,retryMinutes:[5,3,1],hydrationSeconds:5,continuedMinutes:2};
}
function scheduleNextCompletionCheck(task,settings,now=Date.now()){
  const monitor=task.monitor;
  const retries=settings.retryMinutes;
  const step=monitor.step||0;
  const gap=step<retries.length?retries[step]:settings.continuedMinutes;
  monitor.step=step+1;
  monitor.manualRequired=step>=retries.length;
  monitor.nextCheckAt=now+gap*60000;
  monitor.claimedAt=now;
}
async function inspectDueCompletion(taskId){
  if(completionChecksInFlight.has(taskId))return;
  completionChecksInFlight.add(taskId);
  try {
    const task=tasks[taskId];
    if(!task||!['running','uncertain'].includes(task.status)||!task.monitor||
        Date.now()<task.monitor.nextCheckAt)return;
    const config=completionMonitorSettings();
    scheduleNextCompletionCheck(task,config);
    await saveState();
    const live=await chrome.tabs.get(task.tabId).catch(()=>null);
    if(!live||!workers.includes(task.tabId) ||
        workerIncarnations[task.tabId]!==task.workerIncarnationId ||
        siteOfUrl(live.url)!==task.site)return;
    const before=safeConversationRoute(live.url);
    if(!before || (task.uiCandidate?.conversationRoute &&
        task.uiCandidate.conversationRoute!==before))return;
    // Never refresh a detached, closed, replaced or unrelated Agent tab.
    await chrome.tabs.reload(task.tabId);
    await pageSettling.waitForReady(task.tabId,45000);
    await sleep(config.hydrationSeconds*1000);
    const afterTab=await chrome.tabs.get(task.tabId).catch(()=>null);
    if(!afterTab||safeConversationRoute(afterTab.url)!==before ||
        workerIncarnations[task.tabId]!==task.workerIncarnationId)return;
    const state=await tabMessage(task.tabId,{cmd:'observe_state'});
    const chat=await tabMessage(task.tabId,{cmd:'read_chat',lastN:2});
    const normalized=(value)=>String(value||'').replace(/\s+/g,' ').trim();
    const lastAssistant=String(chat?.transcript||'').split(/(?:^|\n\n)Assistant:\s*/).at(-1);
    const signature=normalized(task.uiCandidate?.signature||'');
    if(state?.ok===true&&state.state==='idle' && chat?.ok===true &&
        signature.length>=12 && normalized(lastAssistant).includes(signature)){
      const current=tasks[taskId];
      if(current===task&&['running','uncertain'].includes(current.status)&&
          current.completionEvidence!=='EXPLICIT_MCP'){
        task.completionEvidence='UI_INFERRED';
        finishTask(taskId,{status:'done',
          result:'UI-inferred completion after refresh; use read_chat to review actual answer'});
        await saveState();
        if(task.status==='done'){
          try{await submitPrivateWorkerReceipt(task);}
          catch{task.journalReceiptUncertain=true;await saveState();}
        }
      }
    }
  } catch {
    // A failed reload or unknown UI is not an inferred completion.
  } finally {completionChecksInFlight.delete(taskId);}
}
async function checkDueCompletions(){
  await stateReady;
  for(const task of Object.values(tasks))
    if(['running','uncertain'].includes(task.status)&&task.monitor &&
        Date.now()>=task.monitor.nextCheckAt)
      void inspectDueCompletion(task.id);
}

// -------------------------------------------------------------- guardrails
async function guard({ newWorker = false, reserveSlot = null } = {}) {
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
    // Missing tabs must first become explicit Accident/Yes/Cancel decisions.
    // A failed inventory/persistence check must not discard ownership state.
    await reconcileMissedChildClosures();
    if (workers.length + workerSlotReservations.size >= cfg.maxWorkers) {
      const limit=new Error('SUB_AGENT_LIMIT_REACHED: Complete work inline or reuse an idle Child');
      limit.code='SUB_AGENT_LIMIT_REACHED';
      throw limit;
    }
    // No await between the check and reservation.
    if (reserveSlot) workerSlotReservations.add(reserveSlot);
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
      role:workers.includes(t.id)?'worker':
        t.id === cfg.orchestratorTabId ? 'orchestrator' : 'other',active:t.active}));
  }
  const managerTabId = await callerManagerTab(p, cfg);
  const descendantDiscovery=p.__descendantDiscovery === true && p.__trustedPrincipal?.mode === 'profile';
  return tabs.filter((t) => t.id === managerTabId || ownedWorker(t.id, owner) ||
    (descendantDiscovery && workers.includes(t.id))).map((t) => ({
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
  extensionDiagnostic('debug','content_injection.begin',{tabId});
  const tab = await chrome.tabs.get(tabId);
  const site = siteOfUrl(tab.url);
  const target = { tabId };
  const base = 'reference-exporter/';
  extensionDiagnostic('debug','content_injection.target_resolved',{tabId,site:site || 'unsupported',
    tabStatus:tab.status || 'unknown'});
  if (site === 'chatgpt' && /^https:\/\/chatgpt\.com\//.test(tab.url)) {
    await chrome.scripting.executeScript({ target, world:'MAIN', files:['managed-focus-main.js'] });
    await chrome.scripting.executeScript({ target, world: 'MAIN', files: [`${base}adapters/chatgpt/hook-main.js`] });
    extensionDiagnostic('debug','content_injection.main_hook_done',{tabId,site});
    await chrome.scripting.executeScript({ target, files: [
      `${base}adapters/chatgpt/hook-iso.js`, `${base}core/utils.js`,
      `${base}adapters/chatgpt/api.js`, `${base}adapters/chatgpt/genui.js`,
      `${base}adapters/chatgpt/normalize.js`, 'structured-reader.js', 'content.js',
    ] });
    extensionDiagnostic('debug','content_injection.isolated_scripts_done',{tabId,site,scriptCount:7});
  } else if (site === 'claude') {
    await chrome.scripting.executeScript({ target, files: [
      `${base}core/utils.js`, `${base}adapters/claude/api.js`,
      `${base}adapters/claude/widgets.js`, `${base}adapters/claude/normalize.js`,
      'structured-reader.js', 'content.js',
    ] });
    extensionDiagnostic('debug','content_injection.scripts_done',{tabId,site,scriptCount:6});
  } else if (site === 'gemini') {
    await chrome.scripting.executeScript({ target, world: 'MAIN', files: [`${base}adapters/gemini/hook-main.js`] });
    extensionDiagnostic('debug','content_injection.main_hook_done',{tabId,site});
    await chrome.scripting.executeScript({ target, files: [
      `${base}adapters/gemini/hook-iso.js`, `${base}core/utils.js`,
      `${base}adapters/gemini/api.js`, `${base}adapters/gemini/normalize.js`,
      'structured-reader.js', 'content.js',
    ] });
    extensionDiagnostic('debug','content_injection.isolated_scripts_done',{tabId,site,scriptCount:6});
  } else {
    await chrome.scripting.executeScript({ target, files: ['content.js'] });
    extensionDiagnostic('debug','content_injection.scripts_done',{tabId,site:site || 'fallback',scriptCount:1});
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
  const requestId=crypto.randomUUID(),startedAt=Date.now();
  const safeCmd=typeof msg?.cmd==='string'?msg.cmd:'internal';
  extensionDiagnostic('debug','tab_message.begin',{tabId,requestId,method:safeCmd});
  let firstErr;
  try {
    const result=await chrome.tabs.sendMessage(tabId,msg);
    extensionDiagnostic('debug','tab_message.reply',{tabId,requestId,method:safeCmd,
      durationMs:Date.now()-startedAt,success:true,replyOk:result?.ok!==false,
      state:typeof result?.state==='string'?result.state:'none'});
    return result;
  } catch (e) {
    firstErr = e;
    extensionDiagnostic('warn','tab_message.initial_failure',{tabId,requestId,method:safeCmd,
      durationMs:Date.now()-startedAt,errorType:e?.name || 'Error'});
  }
  // These commands can send a chat message. A lost callback does NOT prove
  // that the content script failed to submit it. Never reinject and replay.
  if (['run_prompt','submit_manager_batch','submit_parent_initialization',
       'retry_manager_draft'].includes(safeCmd)) {
    extensionDiagnostic('warn','tab_message.delivery_uncertain',{tabId,requestId,method:safeCmd,
      reason:'SIDE_EFFECTING_ACK_LOST'});
    throw new Error('Chat submission receipt lost; inspect the existing tab before retrying');
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error(`Tab ${tabId} no longer exists (it was closed).`);
  if (!siteOfUrl(tab.url)) throw new Error(`Tab ${tabId} is not a supported chat page.`);

  // The script is missing or orphaned: (re)inject it, then retry a few times.
  let injectErr = null;
  try {
    await injectContentScript(tabId);
    extensionDiagnostic('debug','content_injection.recovery_done',{tabId,requestId});
  } catch (e) {
    injectErr = e;
    extensionDiagnostic('warn','content_injection.recovery_failed',{tabId,requestId,
      errorType:e?.name || 'Error'});
  }
  let lastErr = firstErr;
  for (let i = 0; i < 6; i++) {
    await sleep(300);
    try {
      const result=await chrome.tabs.sendMessage(tabId,msg);
      extensionDiagnostic('debug','tab_message.retry_reply',{tabId,requestId,method:safeCmd,
        attempt:i+1,durationMs:Date.now()-startedAt,success:true,replyOk:result?.ok!==false});
      return result;
    } catch (e) {
      lastErr = e;
      extensionDiagnostic('debug','tab_message.retry_failed',{tabId,requestId,method:safeCmd,
        attempt:i+1,errorType:e?.name || 'Error'});
    }
  }
  throw new Error(
    `Tab ${tabId} is not reachable. Injection ${injectErr ? 'failed: ' + injectErr.message : 'ran but got no reply'}; ` +
      `last error: ${lastErr?.message || lastErr}. Reload the extension and refresh that tab once.`
  );
}

async function waitReady(tabId, expectedText, timeoutMs = 45000, focusEmulationReady = false) {
  const deadline = Date.now() + timeoutMs;
  let stableSince = null;
  let mismatchedDraftSince = null;
  let lastState = 'unobserved';
  let lastPage = null;
  let lastError = '';
  let lastLoggedState = '';
  let lastDraftLength = 0;
  let lastExpectedLength = 0;
  let lastMatchingDraft = false;
  let lastWhitespaceEquivalent = false;
  while (Date.now() < deadline) {
    try {
      lastPage = await pageSettling.snapshot(tabId);
      const tab = await chrome.tabs.get(tabId);
      if (lastPage.ready && (tab?.active || focusEmulationReady)) {
        extensionDiagnostic('debug','worker.readiness_ping_begin',{tabId,settledMs:lastPage.settledMs,
          active:tab.active});
        const observed = await tabMessage(tabId,{cmd:'ping',expectedText});
        extensionDiagnostic('debug','worker.readiness_ping_done',{tabId,ready:observed?.ready===true,
          state:observed?.state || 'unknown',draftLength:observed?.draftLength ?? 0,
          expectedLength:observed?.expectedLength ?? expectedText?.length ?? 0,
          matchingDraft:observed?.matchingDraft===true});
        lastState = observed?.state || 'unknown';
        lastDraftLength = observed?.draftLength ?? 0;
        lastExpectedLength = observed?.expectedLength ?? 0;
        lastMatchingDraft = observed?.matchingDraft === true;
        lastWhitespaceEquivalent = observed?.whitespaceEquivalent === true;
        const signature = [lastState,observed?.ready,observed?.matchingDraft,
          observed?.draftLength,observed?.expectedLength,observed?.whitespaceEquivalent,
          observed?.documentReady].join(':');
        if (signature !== lastLoggedState) {
          console.info('[chat-orch:background]',{step:'worker_readiness_observed',tabId,
            state:lastState,ready:observed?.ready === true,
            matchingDraft:observed?.matchingDraft === true,draftLength:observed?.draftLength ?? 0,
            expectedLength:observed?.expectedLength ?? 0,
            whitespaceEquivalent:observed?.whitespaceEquivalent === true,
            documentReady:observed?.documentReady === true,remainingSettleMs:lastPage.remainingMs});
          lastLoggedState = signature;
        }
        if (observed?.state === 'draft' && observed.matchingDraft !== true) {
          mismatchedDraftSince ??= Date.now();
          if (Date.now() - mismatchedDraftSince >= 1200) {
            const error = new Error('Worker composer contains a different unsent draft; inspect it before retrying');
            error.code = 'COMPOSER_DRAFT_MISMATCH';
            throw error;
          }
        } else mismatchedDraftSince = null;
        if (observed?.ok === true && observed.ready === true &&
            observed.documentReady === true) {
          if (stableSince === null) stableSince = Date.now();
          if (Date.now() - stableSince >= 1200) {
            console.info('[chat-orch:background]',{step:'worker_readiness_confirmed',tabId,
              state:lastState,matchingDraft:observed.matchingDraft === true});
            return;
          }
        } else stableSince = null;
      } else {
        lastState = !tab?.active && !focusEmulationReady ? 'not-focused' :
          lastPage.documentComplete ? 'post-load-settling' : 'document-loading';
        if (lastState !== lastLoggedState) {
          console.info('[chat-orch:background]',{step:'worker_readiness_observed',tabId,
            state:lastState,active:tab?.active === true,remainingSettleMs:lastPage.remainingMs});
          lastLoggedState = lastState;
        }
        stableSince = null;
        mismatchedDraftSince = null;
      }
    } catch (error) {
      if (error?.code === 'COMPOSER_DRAFT_MISMATCH') throw error;
      lastError = String(error?.message || error);
      if (lastLoggedState !== 'observation_error') {
        console.warn('[chat-orch:background]',{step:'worker_readiness_error',tabId,
          errorType:error?.name || 'Error'});
        lastLoggedState = 'observation_error';
      }
      stableSince = null;
      mismatchedDraftSince = null;
    }
    await sleep(250);
  }
  console.warn('[chat-orch:background]',{step:'worker_readiness_timeout',tabId,
    state:lastState,draftLength:lastDraftLength,expectedLength:lastExpectedLength,
    matchingDraft:lastMatchingDraft,whitespaceEquivalent:lastWhitespaceEquivalent,
    remainingSettleMs:lastPage?.remainingMs});
  throw new Error('Worker composer did not become stably ready: state='+lastState+
    ', draftLength='+lastDraftLength+', expectedLength='+lastExpectedLength+
    ', matchingDraft='+lastMatchingDraft+', whitespaceEquivalent='+lastWhitespaceEquivalent+
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
async function issueManagedChildPairing(tabId) {
  if(!workers.includes(tabId) || !workerIncarnations[tabId])
    throw new Error('Automatic Child pairing requires an existing owned worker tab');
  if(!ws || ws.readyState!==WebSocket.OPEN || wsState!=='connected')
    throw new Error('MCP connection unavailable; refusing to start an unpaired autonomous Child');
  const live=await inspectChatTab(tabId);
  if(!live.is_managed_worker || live.incarnation_id!==workerIncarnations[tabId])
    throw new Error('Managed Child incarnation changed before first task');
  const code=crypto.randomUUID(),requestId=crypto.randomUUID();
  const acknowledgment=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{
      pairingWaiters.delete(requestId);
      reject(new Error('Child pairing offer acknowledgment timed out'));
    },12000);
    pairingWaiters.set(requestId,{resolve,reject,timer});
  });
  try {
    ws.send(JSON.stringify({type:'pairing_offer',request_id:requestId,
      code,tab_id:live.tab_id,incarnation_id:live.incarnation_id,
      route_hash:live.route_hash}));
    await acknowledgment;
    return code;
  } catch (error) {
    const pending=pairingWaiters.get(requestId);
    if(pending){clearTimeout(pending.timer);pairingWaiters.delete(requestId);}
    throw error;
  }
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
  console.info('[chat-orch:background]',{step:'worker_idle_first',tabId,state:first?.state,
    ready:first?.ready === true,matchingDraft:first?.matchingDraft === true,
    draftLength:first?.draftLength ?? 0});
  if (first?.ok !== true || first.ready !== true) {
    throw new Error('Worker tab is not ready ('+(first?.state || 'unknown')+')');
  }
  await sleep(600);
  const second = await tabMessage(tabId, {cmd:'observe_state',expectedText});
  console.info('[chat-orch:background]',{step:'worker_idle_second',tabId,state:second?.state,
    ready:second?.ready === true,matchingDraft:second?.matchingDraft === true,
    draftLength:second?.draftLength ?? 0});
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
// Opt-in only. A page-facing hasFocus()/visibility shim cannot resume a
// background Chromium compositor or deliver trusted native user input.
// Temporarily foreground the dedicated worker window while its first user
// turn is prepared and verified; never focus during worker tab creation.
async function acquireForegroundSubmitLease(tabId,kind='child') {
  const preference=await chrome.storage.local.get('foregroundSubmitEnabled');
  if(preference?.foregroundSubmitEnabled!==true)return null;
  const tab=await chrome.tabs.get(tabId);
  const approved=kind==='manager'
    ? managedAgentStatus(tabId).managed===true
    : ownedWorker(tabId,workerOwners[tabId]);
  if(!tab || siteOfUrl(tab.url)!=='chatgpt' || !approved)
    throw new Error('Foreground submission is restricted to a managed ChatGPT agent');
  if(!Number.isSafeInteger(tab.windowId))
    throw new Error('Managed worker has no browser window to focus');
  const originalWindow=await chrome.windows.get(tab.windowId);
  if(!originalWindow || originalWindow.state==='minimized')
    throw new Error('Open the managed browser window before foreground submission');
  const previous=await chrome.windows.getLastFocused().catch(()=>null);
  const previousBrowserWindowId=previous?.id??null;
  const previousBrowserWindowWasFocused=previous?.focused===true;
  const activeBefore=await chrome.tabs.query({active:true,windowId:tab.windowId})
    .catch(()=>[]);
  try {
    await chrome.windows.update(tab.windowId,{focused:true});
    if(kind==='manager')await chrome.tabs.update(tabId,{active:true});
    const focused=await chrome.windows.get(tab.windowId);
    if(focused?.focused!==true)
      throw new Error('Browser declined real foreground focus; no prompt submitted');
  }catch(error){
    if(previousBrowserWindowWasFocused && previousBrowserWindowId!==tab.windowId)
      await chrome.windows.update(previousBrowserWindowId,{focused:true}).catch(()=>{});
    throw error;
  }
  extensionDiagnostic('info','worker.real_foreground_acquired',{tabId,
    windowId:tab.windowId,previousBrowserWindowId});
  let released=false;
  return async()=>{
    if(released)return;
    released=true;
    try {
      // Never overwrite a user's later window/tab switch.
      const current=await chrome.windows.get(tab.windowId);
      if(current?.focused!==true)return;
      const active=await chrome.tabs.query({active:true,windowId:tab.windowId});
      if(active?.[0]?.id!==tabId)return;
      if(previousBrowserWindowWasFocused && previousBrowserWindowId!==tab.windowId){
        await chrome.windows.update(previousBrowserWindowId,{focused:true});
      } else if(previousBrowserWindowId===tab.windowId && activeBefore?.[0]?.id!==tabId &&
          Number.isSafeInteger(activeBefore?.[0]?.id)) {
        await chrome.tabs.update(activeBefore[0].id,{active:true});
      }
      // The extension cannot restore focus to a non-browser application.
      extensionDiagnostic('info','worker.real_foreground_released',{tabId,
        restoredBrowserWindow:previousBrowserWindowWasFocused});
    }catch(error){
      extensionDiagnostic('warn','worker.real_foreground_restore_failed',{
        tabId,errorType:error?.name||'Error'});
    }
  };
}
async function focusWorkerForStartup(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab || !ownedWorker(tabId, workerOwners[tabId]))
    throw new Error('Worker tab is unavailable or no longer owned');
  // Edge briefly locks tab edits while settling a freshly created group.
  // Only retry that transient failure; never create another worker tab.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      // Activate only inside our dedicated worker workspace; never steal the
      // user's foreground OS window while initializing another Agent.
      await chrome.tabs.update(tabId,{active:true});
      const visibleTab = await chrome.tabs.get(tabId);
      if (!visibleTab?.active || visibleTab.windowId !== tab.windowId)
        throw new Error('Worker tab could not be activated for page initialization');
      console.info('[chat-orch:background]',{step:'worker_focus_confirmed',tabId,attempt});
      return;
    } catch (error) {
      const transient = /tabs cannot be edited right now/i.test(String(error?.message || error));
      console.warn('[chat-orch:background]',{step:'worker_focus_failed',tabId,attempt,
        transient,errorType:error?.name || 'Error',reason:transient?'TAB_EDIT_LOCK':
          /activated for page initialization/.test(String(error?.message))?'FOCUS_UNCONFIRMED':'OTHER'});
      if (!transient || attempt === 5) {
        // A tab can lose browser activation while the worker window is being
        // rearranged. Only a verified managed ChatGPT focus shim can replace
        // this optimization; never pretend an unknown tab is foregrounded.
        if(siteOfUrl(tab.url)==='chatgpt' &&
            await enableManagedAntiFreeze(tabId)){
          extensionDiagnostic('info','worker.startup_virtual_focus_fallback',{
            tabId,attempt});
          return;
        }
        throw error;
      }
      await sleep(300 * attempt);
    }
  }
}

async function startTask(tabId, site, text, waitSecs, cfg, autoClose = false, owner = 'legacy', queuedTaskId = null, originParentUrl=null) {
  // Serializing submission—not inference—prevents an unfocused second tab
  // from racing against the first tab's deferred application initialization.
  const id = await serializePromptStartup(async () => {
    const blockingTasks=Object.values(tasks).filter((task)=>task.tabId===tabId&&
      ['running','uncertain','waiting_for_children'].includes(task.status));
    extensionDiagnostic('debug','worker.startup_existing_tasks_checked',{tabId,
      blockingCount:blockingTasks.length,status:blockingTasks[0]?.status || 'none'});
    if (blockingTasks.length) {
      throw new Error('Worker has an outstanding task (running or uncertain); reconcile before reuse');
    }
    const releaseForeground=site==='chatgpt'
      ? await acquireForegroundSubmitLease(tabId) : null;
    try {
    console.info('[chat-orch:background]', {step:'worker_focus', tabId, site});
    try {
      await focusWorkerForStartup(tabId);
      extensionDiagnostic('info','worker.startup_focus_complete',{tabId,site});
    } catch (error) {
      console.warn('[chat-orch:background]',{step:'worker_startup_blocked',tabId,site,
        phase:'focus',errorType:error?.name || 'Error'});
      throw error;
    }
    console.info('[chat-orch:background]', {step:'worker_readiness', tabId, site});
    // The early shim is installed on every supported ChatGPT document, but
    // only this explicitly managed worker may enable it. Do not rely on the
    // earlier fire-and-forget registration-side injection.
    let focusEmulationReady=site==='chatgpt' &&
      await enableManagedAntiFreeze(tabId);
    extensionDiagnostic(focusEmulationReady?'info':'warn','worker.focus_emulation_checked',{
      tabId,site,verified:focusEmulationReady});
    try {
      await waitReady(tabId,text,45000,focusEmulationReady);
      extensionDiagnostic('info','worker.readiness_complete',{tabId,site});
      await confirmTabIdle(tabId,text);
      extensionDiagnostic('info','worker.idle_confirmation_complete',{tabId,site});
    } catch (error) {
      console.warn('[chat-orch:background]',{step:'worker_startup_blocked',tabId,site,
        phase:'readiness',errorType:error?.name || 'Error',
        reason:error?.code === 'COMPOSER_DRAFT_MISMATCH' || /state=draft/.test(String(error?.message))?'COMPOSER_DRAFT':
          /not stably ready/.test(String(error?.message))?'READINESS_TIMEOUT':'OTHER'});
      throw error;
    }

    extensionDiagnostic('info','worker.task_record_begin',{tabId,site});
    const taskId = queuedTaskId || crypto.randomUUID();
    // Pair each newly opened Child using a one-time offer in its FIRST task
    // message. Do not rotate the credential on queued follow-ups or reuse.
    let dispatchText=text;
    if(owner!=='legacy' && site==='chatgpt' &&
        !Object.values(tasks).some((task)=>task.tabId===tabId &&
          task.workerIncarnationId===workerIncarnations[tabId])) {
      const connectorGuidance=requireConnectorRoutingReady();
      const code=await issueManagedChildPairing(tabId);
      const onboarding='<managed_child_setup>\n'
        +'You are an already-owned Child Agent, not a new Parent. '
        +connectorGuidance+' '
        +'Before other Chat Orchestrator MCP calls, call pair_conversation from connector "'+
        proxySettings.connectorName+'" with code '
        +code+' and a fresh idempotency_key UUID. '
        +'Use its returned agent_credential for later Orchestrator tool calls. '
        +'Use a fresh UUID idempotency_key for each independent tool call; reuse a key only for exact retries. '
        +'Never expose the credential or one-time pairing code in your final answer. '
        +'After finishing your own work, call complete_task with assigned task_id '
        +taskId+' and a fresh UUID idempotency_key. '
        +'If you delegate to children or grandchildren, submit the intended tasks, then end your current response without polling their status; the orchestrator will notify you of completion. '
        +'You may call complete_task when your own work is ready even if descendants are still running: the task stays waiting_for_children until all required descendant results are reviewed. '
        +'Review results when notified, then yield again if other descendants remain. '
        +'If MCP tools cannot be accessed, report the limitation instead of inventing success.\n'
        +'</managed_child_setup>\n\n';
      dispatchText=onboarding+text;
    }
    if (queuedTaskId && (tasks[taskId]?.status !== 'queued' ||
        tasks[taskId].tabId !== tabId || tasks[taskId].owner !== owner ||
        tasks[taskId].workerIncarnationId !== workerIncarnations[tabId]))
      throw new Error('Queued task identity or ownership changed; refuse to replay');
    const receiptNonce = crypto.randomUUID();
    const priorTask=queuedTaskId?tasks[taskId]:null;
    const task = { id:taskId, tabId, site, status:'running',
      startedAt:priorTask?.contextRequestedAt?priorTask.startedAt:Date.now(),
      autoClose, receiptNonce, owner,
      originParentUrl,
      ...(priorTask?.contextRequestedAt
        ? {contextRequestedAt:priorTask.contextRequestedAt,
          contextResponseCount:(priorTask.contextResponseCount||0)+1,
          previousReceiptNonces:[...(priorTask.previousReceiptNonces||[]),
            priorTask.receiptNonce].filter(Boolean).slice(-4)}:{}),
      workerIncarnationId: workerIncarnations[tabId] || null };
    // Browser response observation is only provisional. Explicit complete_task
    // has the first 5 minutes; a verified reload-based check runs afterward.
    const monitorSettings=cfg.completionMonitor||{
      initialMinutes:5,retryMinutes:[5,3,1],hydrationSeconds:5,continuedMinutes:2};
    task.monitor=priorTask?.monitor||{
      step:0,nextCheckAt:Date.now()+monitorSettings.initialMinutes*60000,
      manualRequired:false,noticeShown:false};
    tasks[taskId] = task;
    taskLog.push(Date.now());
    await saveState();
    extensionDiagnostic('info','worker.task_record_saved',{tabId,taskId,site});
    console.info('[chat-orch:background]', {step:'worker_dispatch', taskId, tabId, site});

    let ack;
    let dispatchAttempted=false;
    try {
      // The content script now acknowledges only after it confirms that
      // the user message was submitted; response collection continues async.
      extensionDiagnostic('info','worker.content_dispatch_begin',{tabId,taskId,site});
      const dispatchTab=await chrome.tabs.get(tabId);
      if(!ownedWorker(tabId,owner))
        throw new Error('Worker ownership changed before prompt submission; no dispatch attempted');
      // The user may activate another tab during page settling. Re-verify
      // the shim on the CURRENT document; do not switch the user back.
      if(site==='chatgpt')
        focusEmulationReady=await enableManagedAntiFreeze(tabId);
      if(!dispatchTab?.active && !focusEmulationReady)
        throw new Error('Worker tab became inactive and focus emulation is unavailable; no dispatch attempted');
      if(releaseForeground){
        const foregroundWindow=await chrome.windows.get(dispatchTab.windowId);
        if(!dispatchTab?.active || foregroundWindow?.focused!==true)
          throw new Error('User switched away before foreground Send; no dispatch attempted');
      }
      extensionDiagnostic('info','worker.background_dispatch_authorized',{
        tabId,active:dispatchTab?.active===true,focusEmulationReady});
      dispatchAttempted=true;
      ack = await tabMessage(tabId, {cmd:'run_prompt',taskId,receiptNonce,
        text:dispatchText,timeoutMs:cfg.taskTimeoutMin * 60000});
      extensionDiagnostic('info','worker.content_dispatch_ack',{tabId,taskId,
        success:ack?.ok===true,uncertain:ack?.uncertain===true,notSubmitted:ack?.notSubmitted===true});
    } catch (error) {
      console.warn('[chat-orch:background]', {step:'worker_dispatch_error', taskId, tabId,
        errorType:error?.name || 'Error'});
      extensionDiagnostic('error','worker.content_dispatch_error',{tabId,taskId,
        reason:dispatchAttempted?'NO_CONTENT_ACK':'DISPATCH_PRECHECK_REJECTED'});
      if (task.status === 'running') {
        task.status = dispatchAttempted?'uncertain':'failed';
        task.error = dispatchAttempted
          ? 'Prompt submission receipt lost; inspect this tab before retrying'
          : String(error?.message||'Dispatch precheck failed; no message sent');
        await saveState();
        (waiters[taskId] || []).forEach((resolve) => resolve());
        delete waiters[taskId];
      }
      return taskId;
    }
    console.info('[chat-orch:background]', {step:'worker_submission_receipt',taskId,tabId,
      ok:ack?.ok === true,uncertain:ack?.uncertain === true,
      notSubmitted:ack?.notSubmitted === true});
    if(ack?.ok===true && ack?.submitted===true) {
      task.submissionConfirmed=true;
      await saveState();
    } else if(task.submissionConfirmed===true) {
      // The Child may have already used its unique pairing offer while
      // ChatGPT's rendered user-turn selector was still inconclusive.
      // Verified pairing is stronger delivery evidence than that selector;
      // it does NOT imply that the model's task is complete.
      extensionDiagnostic('info','worker.submission_already_confirmed',{
        tabId,taskId,proofType:task.submissionEvidence || 'USER_TURN'});
    } else if (task.status === 'running') {
      finishTask(taskId,ack?.uncertain || ack?.notSubmitted!==true
        ? {status:'uncertain',error:ack?.error || 'Submission outcome uncertain'}
        : {status:'failed',error:ack?.error || 'Tab refused the task before submission'});
    }
    return taskId;
    } finally {
      if(releaseForeground)await releaseForeground();
    }
  });
  if (waitSecs > 0 && tasks[id]?.status === 'running') {
    await waitTask(id,Math.min(waitSecs,50)*1000);
  }
  return summarize(tasks[id]);
}

// Accepted follow-ups have distinct task IDs before any browser side effect.
// Dispatch one at a time, preserving FIFO, only while the managed Child is idle.
// An uncertain send is NEVER retried; the queue entry is consumed and requires
// Parent reconciliation rather than a silent second submission.
async function dispatchQueuedFollowups(tabId) {
  if (queuedDispatches.has(tabId)) return;
  queuedDispatches.add(tabId);
  try {
    while (true) {
      const next=queuedFollowups.find((item)=>item.tabId===tabId);
      if (!next) return;
      const task=tasks[next.taskId];
      if(next.resumeContext===true && task?.status==='waiting_for_parent_context'){
        task.status='queued';
        await saveState();
      }
      if (!task || task.status !== 'queued') {
        queuedFollowups=queuedFollowups.filter((item)=>item.taskId!==next.taskId);
        await saveState();
        continue;
      }
      if (Object.values(tasks).some((item)=>item.tabId===tabId &&
          ['running','uncertain','waiting_for_children'].includes(item.status))) return;
      const tab=await chrome.tabs.get(tabId).catch(()=>null);
      if (!tab || siteOfUrl(tab.url)!==next.site ||
          !ownedWorker(tabId,next.owner) ||
          workerIncarnations[tabId]!==task.workerIncarnationId) {
        task.status='uncertain';
        task.error='Queued Child identity changed; Parent must reconcile before resubmission';
        task.finishedAt=Date.now();
        queuedFollowups=queuedFollowups.filter((item)=>item.taskId!==next.taskId);
        await saveState();
        return;
      }
      try {
        const cfg=await guard();
        await startTask(tabId,next.site,next.text,0,cfg,false,next.owner,next.taskId,
          next.originParentUrl || null);
      } catch (error) {
        if (/Rate limit:|Automation is disabled|Proxy settings not synchronized/.test(String(error?.message))) {
          return; // Still queued: retry only after configuration or periodic queue check.
        }
        if (task.status==='queued') {
          task.status='uncertain';task.finishedAt=Date.now();
          task.error='Queued dispatch rejected; inspect the Child before retrying';
        }
      }
      queuedFollowups=queuedFollowups.filter((item)=>item.taskId!==next.taskId);
      await saveState();
      if (['running','uncertain'].includes(tasks[next.taskId]?.status)) return;
    }
  } finally {
    queuedDispatches.delete(tabId);
  }
}

// Independent tasks are not just chat messages. A new task for a reused
// Child is held until the direct Parent explicitly reviews earlier work.
function unreviewedIndependentWork(tabId) {
  return Object.values(tasks).some((task)=>task.tabId===tabId &&
    (task.status==='queued' || !['done','failed'].includes(task.status) ||
     task.parentReviewed !== true));
}

async function launchOrQueueIndependent(tabId,site,text,waitSecs,cfg,owner,originParentUrl=null) {
  if (!unreviewedIndependentWork(tabId) &&
      !queuedFollowups.some((item)=>item.tabId===tabId))
    return startTask(tabId,site,text,waitSecs,cfg,false,owner,null,originParentUrl);
  const id=crypto.randomUUID();
  const task={id,tabId,site,status:'queued',startedAt:Date.now(),
    owner,autoClose:false,independent:true,parentReviewed:false,
    originParentUrl,
    workerIncarnationId:workerIncarnations[tabId] || null};
  tasks[id]=task;
  queuedIndependent.push({taskId:id,tabId,site,text,owner,originParentUrl});
  await saveState();
  return summarize(task);
}

async function dispatchQueuedIndependent(tabId) {
  if (independentDispatches.has(tabId)) return;
  independentDispatches.add(tabId);
  try {
    const next=queuedIndependent.find((entry)=>entry.tabId===tabId);
    if (!next) return;
    const task=tasks[next.taskId];
    if (!task || task.status!=='queued') return;
    if (queuedFollowups.some((item)=>item.tabId===tabId)) return;
    if (Object.values(tasks).some((item)=>item.tabId===tabId &&
        item.id!==task.id && item.startedAt<=task.startedAt &&
        (item.status==='queued' || !['done','failed'].includes(item.status) ||
         item.parentReviewed!==true))) return;
    const tab=await chrome.tabs.get(tabId).catch(()=>null);
    if (!tab || !ownedWorker(tabId,next.owner) ||
        workerIncarnations[tabId]!==task.workerIncarnationId ||
        siteOfUrl(tab.url)!==next.site) {
      task.status='uncertain';
      task.error='Queued independent task lost its original Child identity';
      task.finishedAt=Date.now();
    } else {
      try {
        const cfg=await guard();
        await startTask(tabId,next.site,next.text,0,cfg,false,next.owner,next.taskId,
          next.originParentUrl || null);
      } catch(error) {
        if (/Rate limit:|Automation is disabled|Proxy settings not synchronized/.test(String(error?.message)))
          return;
        if (task.status==='queued') {
          task.status='uncertain';
          task.error='Independent task not dispatched reliably; Parent reconciliation required';
          task.finishedAt=Date.now();
        }
      }
    }
    queuedIndependent=queuedIndependent.filter((entry)=>entry.taskId!==next.taskId);
    await saveState();
  } finally {
    independentDispatches.delete(tabId);
  }
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
    case 'desktop_list_agent_closures': {
      if(p.__trustedDesktopConsent!==true)
        throw new Error('Trusted desktop access required');
      await closureWriteTail;
      const unresolved=(await persistedClosureDecisions())
        .filter((entry)=>entry.status!=='resolved');
      // A Parent decision governs its entire subtree. Suppress overlapping
      // Child dialogs while that Parent closure remains unresolved; do not
      // delete their evidence from the durable operational record.
      return unresolved.filter((entry)=>!unresolved.some((ancestor)=>
        ancestor.id!==entry.id && ancestor.browserSessionId===entry.browserSessionId &&
        ancestor.descendants?.some((child)=>child.tabId===entry.oldTabId)))
        .map(({id,browserSessionId,kind,oldTabId,parentTabId,url,title,descendants,
          createdAt,status,candidateTabId,candidateIncarnationId,error})=>({
          id,browserSessionId,kind,oldTabId,parentTabId,url,title,descendants,
          createdAt,status,candidateTabId,candidateIncarnationId,error,
        }));
    }
    case 'desktop_prepare_accident_restore': {
      if(p.__trustedDesktopConsent!==true)
        throw new Error('Trusted desktop recovery consent required');
      const decision=await verifiedPendingClosure(p.decision_id,true);
      if (decision.status==='restoring' && decision.candidateTabId) {
        const tab=await chrome.tabs.get(decision.candidateTabId).catch(()=>null);
        if (!tab || normalizedClosedTabUrl(tab.url)!==decision.url)
          throw new Error('Previous restoration candidate changed; manual reconciliation required');
        return {candidate_tab_id:tab.id,decision_id:decision.id,
          reused_candidate:true,no_task_replay:true};
      }
      if(decision.status!=='pending')
        throw new Error('Previous tab restoration is UNCERTAIN; do not open a duplicate');
      if(!decision.url) throw new Error('No verified saved conversation URL to restore');
      if(decision.parentTabId!=null) {
        const parent=await chrome.tabs.get(decision.parentTabId).catch(()=>null);
        if(!parent || !siteOfUrl(parent.url))
          throw new Error('Original owning Parent must be restored before its Child');
      }
      await changePersistedClosure(decision.id,(entry)=>{
        if(entry.status!=='pending')throw new Error('Closure recovery already started');
        return {...entry,status:'creating'};
      });
      // The creating marker is durable BEFORE chrome.tabs.create. A lost ACK
      // must never lead to an automatic second tab.
      const tab=await chrome.tabs.create({url:decision.url,active:false});
      if(!Number.isSafeInteger(tab?.id) || tab.id===decision.oldTabId)
        throw new Error('Restored tab ID was not new and verified');
      const newIncarnation=crypto.randomUUID();
      if(decision.kind==='child') {
        workers.push(tab.id);
        workerOwners[tab.id]=decision.originalOwner;
        workerParents[tab.id]=decision.parentTabId;
        workerIncarnations[tab.id]=newIncarnation;
      } else {
        managerIncarnations[tab.id]=newIncarnation;
        approvedParents[tab.id]=newIncarnation;
      }
      workerUrls[tab.id]=decision.url;
      tabTitles[tab.id]=decision.title;
      await saveState();
      await changePersistedClosure(decision.id,(entry)=>({
        ...entry,status:'restoring',candidateTabId:tab.id,
        candidateIncarnationId:newIncarnation,
      }));
      const inspected=await inspectChatTab(tab.id);
      if(inspected.incarnation_id!==newIncarnation ||
          inspected.site!==siteOfUrl(decision.url))
        throw new Error('New tab did not attest the saved Agent site');
      return {candidate_tab_id:tab.id,decision_id:decision.id,
        new_incarnation_id:newIncarnation,no_task_replay:true};
    }
    case 'desktop_commit_accident_restore': {
      if(p.__trustedDesktopConsent!==true)
        throw new Error('Trusted desktop recovery consent required');
      const decision=await verifiedPendingClosure(p.decision_id,true);
      if(decision.status!=='restoring' || decision.candidateTabId!==p.new_tab_id)
        throw new Error('No matching verified restoration candidate');
      const live=await inspectChatTab(decision.candidateTabId);
      if(live.incarnation_id!==decision.candidateIncarnationId ||
          live.browser_session_id!==browserSessionId)
        throw new Error('Recovery candidate incarnation changed');
      if(!/^[0-9a-f-]{36}$/i.test(p.new_parent_owner||''))
        throw new Error('Verified replacement owner scope required');
      const oldOwner=decision.kind==='parent'
        ? null : decision.originalOwner;
      const direct=decision.descendants.filter((entry)=>entry.parentTabId===decision.oldTabId);
      for(const child of direct) {
        if (!workers.includes(child.tabId) ||
            workerIncarnations[child.tabId]!==child.incarnationId) continue;
        if(workerParents[child.tabId]!==decision.oldTabId)
          throw new Error('Descendant ownership changed before recovery');
        const oldChildOwner=workerOwners[child.tabId];
        workerParents[child.tabId]=decision.candidateTabId;
        workerOwners[child.tabId]='credential:'+p.new_parent_owner;
        for(const task of Object.values(tasks)) {
          if(task.tabId===child.tabId && task.owner===oldChildOwner)
            task.owner=workerOwners[child.tabId];
        }
        for(const item of [...queuedFollowups,...queuedIndependent]) {
          if(item.tabId===child.tabId && item.owner===oldChildOwner)
            item.owner=workerOwners[child.tabId];
        }
      }
      for(const lost of Object.values(lostWorkers)) {
        if(lost.tabId===decision.oldTabId) {
          lost.reopenedTabId=decision.candidateTabId;
          lost.reopenedIncarnation=decision.candidateIncarnationId;
        }
      }
      for (const task of Object.values(tasks)) {
        if (task.tabId===decision.oldTabId &&
            task.workerIncarnationId===decision.incarnationId &&
            task.status==='closed_pending_decision') {
          // Reopening does not prove the provider resumed the original work.
          // Keep the old task identity for reconciliation; never replay it.
          task.status='uncertain';
          task.error='Original Agent tab restored as '+decision.candidateTabId+
            '; inspect the conversation before marking completion';
          task.recoveredTabId=decision.candidateTabId;
        }
      }
      await saveState();
      await changePersistedClosure(decision.id,(entry)=>({
        ...entry,status:'restoring_children',resolution:'accident',
        parentRestoredAt:Date.now(),restoredDescendants:entry.restoredDescendants||{},
      }));
      return {restored:true,old_tab_id:decision.oldTabId,
        new_tab_id:decision.candidateTabId,
        descendants_rebound:direct.length,needs_pairing:true,
        descendant_restoration_pending:decision.descendants.length>0,
        no_task_replay:true};
    }
    case 'desktop_restore_closure_descendant': {
      // D-021/D-022: one immediate-child edge at a time, top-down. The Proxy
      // provides the verified NEW Parent binding and its scoped credential.
      // The user's Accident consent applies to the entire captured subtree.
      if(p.__trustedDesktopConsent!==true ||
          !Number.isSafeInteger(p.old_tab_id) || p.old_tab_id<=0 ||
          !Number.isSafeInteger(p.old_parent_tab_id) || p.old_parent_tab_id<=0 ||
          !Number.isSafeInteger(p.new_parent_tab_id) || p.new_parent_tab_id<=0 ||
          !/^[0-9a-f-]{36}$/i.test(p.expected_parent_incarnation||'') ||
          !/^[0-9a-f-]{36}$/i.test(p.new_parent_owner||''))
        throw new Error('Verified Desktop subtree-recovery authority required');
      const decision=await verifiedPendingClosure(p.decision_id,true);
      if(decision.status!=='restoring_children')
        throw new Error('Parent Accident restoration has not been verified');
      const entry=decision.descendants.find((item)=>
        item.tabId===p.old_tab_id && item.parentTabId===p.old_parent_tab_id);
      const safeUrl=normalizedClosedTabUrl(entry?.lastUrl);
      if(!entry || entry.site!=='chatgpt' || !safeUrl ||
          safeUrl!==entry.lastUrl)
        throw new Error('Captured Child URL/ancestry is not safe to restore');
      const parent=await chrome.tabs.get(p.new_parent_tab_id).catch(()=>null);
      if(!parent || siteOfUrl(parent.url)!=='chatgpt' ||
          (!workers.includes(parent.id) && !isApprovedParent(parent.id)) ||
          (workerIncarnations[parent.id]||managerIncarnations[parent.id])!==
            p.expected_parent_incarnation)
        throw new Error('New owning Parent tab failed current identity verification');
      const ready=decision.restoredDescendants?.[entry.tabId];
      if(ready) {
        if(ready.status!=='ready') {
          throw new Error('Previous Child tab creation is UNCERTAIN; inspect before retrying');
        }
        const live=await chrome.tabs.get(ready.tabId).catch(()=>null);
        if(!live||!workers.includes(ready.tabId)||
            workerIncarnations[ready.tabId]!==ready.incarnationId ||
            workerParents[ready.tabId]!==p.new_parent_tab_id ||
            workerOwners[ready.tabId]!=='credential:'+p.new_parent_owner ||
            normalizedClosedTabUrl(live.url)!==safeUrl)
          throw new Error('Previously restored Child identity changed; reconciliation required');
        return {old_tab_id:entry.tabId,tab_id:ready.tabId,
          incarnation_id:ready.incarnationId,
          created:ready.created===true,reused:true,no_task_replay:true};
      }
      const oldTab=await chrome.tabs.get(entry.tabId).catch(()=>null);
      const stillLive=Boolean(oldTab && workers.includes(entry.tabId) &&
        workerIncarnations[entry.tabId]===entry.incarnationId &&
        normalizedClosedTabUrl(oldTab.url)===safeUrl);
      if(oldTab && workers.includes(entry.tabId) && !stillLive)
        throw new Error('Original numeric Child tab ID has conflicting live identity');
      let tabId=entry.tabId;
      let incarnation=entry.incarnationId;
      if(!stillLive) {
        // Durable reservation BEFORE tab creation. An unknown create result
        // never licenses a second browser tab or prompt replay.
        await changePersistedClosure(decision.id,(record)=>{
          // Atomic compare-and-set under closureWriteTail. Two concurrent
          // Accident/resume calls must not both reserve the same Child.
          if(record.status!=='restoring_children' ||
              Object.hasOwn(record.restoredDescendants||{},entry.tabId))
            throw new Error('Child restoration already reserved; outcome UNCERTAIN until verified');
          return {...record,restoredDescendants:{
            ...(record.restoredDescendants||{}),
            [entry.tabId]:{status:'creating',oldParentTabId:entry.parentTabId,
              newParentTabId:p.new_parent_tab_id,startedAt:Date.now()},
          }};
        });
        const created=await chrome.tabs.create({url:safeUrl,active:false});
        if(!Number.isSafeInteger(created?.id) || created.id<=0 ||
            created.id===entry.tabId || workers.includes(created.id) ||
            isApprovedParent(created.id))
          throw new Error('Restored Child received an invalid or reused numeric tab ID');
        tabId=created.id;
        incarnation=crypto.randomUUID();
        workers.push(tabId);
        workerIncarnations[tabId]=incarnation;
        workerUrls[tabId]=safeUrl;
        tabTitles[tabId]=(entry.title||'Restored Child').slice(0,140);
      }
      workerParents[tabId]=p.new_parent_tab_id;
      workerOwners[tabId]='credential:'+p.new_parent_owner;
      for(const task of Object.values(tasks)) {
        if(task.tabId!==entry.tabId ||
            task.workerIncarnationId!==entry.incarnationId)continue;
        task.owner=workerOwners[tabId];
        if(!stillLive) {
          task.recoveredTabId=tabId;
          task.parentReviewed=false;
          if(['closed_pending_decision','running','waiting_for_children','queued'].includes(task.status)) {
            task.status='uncertain';
            task.error='Child conversation reopened; original task outcome remains unverified';
          }
        }
      }
      for(const lost of Object.values(lostWorkers)) {
        if(lost.tabId!==entry.tabId||lost.incarnation!==entry.incarnationId)continue;
        lost.owner=workerOwners[tabId];
        lost.parentTabId=p.new_parent_tab_id;
        if(!stillLive){
          lost.reopenedTabId=tabId;
          lost.reopenedIncarnation=incarnation;
        }
      }
      if(stillLive) {
        for(const item of [...queuedFollowups,...queuedIndependent])
          if(item.tabId===entry.tabId)item.owner=workerOwners[tabId];
      }
      await saveState();
      const live=await inspectChatTab(tabId);
      if(live.incarnation_id!==incarnation || !live.is_managed_worker ||
          live.browser_session_id!==browserSessionId ||
          live.site!=='chatgpt')
        throw new Error('Restored Child browser identity verification failed');
      // An extension suspended during whole-browser closure might have missed
      // onRemoved for this Child. Only after the replacement is independently
      // verified may we retire its definitely absent old physical tab binding.
      // Never transfer an old queued prompt to a replacement automatically.
      if(!stillLive && !oldTab &&
          workers.includes(entry.tabId) &&
          workerIncarnations[entry.tabId]===entry.incarnationId) {
        workers=workers.filter((id)=>id!==entry.tabId);
        delete workerParents[entry.tabId];
        delete workerOwners[entry.tabId];
        delete workerIncarnations[entry.tabId];
        delete workerUrls[entry.tabId];
        delete tabTitles[entry.tabId];
        clearRoleSeatsForTab(entry.tabId);
        for(const queued of [...queuedFollowups,...queuedIndependent]) {
          if(queued.tabId!==entry.tabId)continue;
          const original=tasks[queued.taskId];
          if(original && original.status==='queued') {
            original.status='uncertain';
            original.error='Old Child tab closed before queued prompt; not automatically replayed';
          }
        }
        queuedFollowups=queuedFollowups.filter((item)=>item.tabId!==entry.tabId);
        queuedIndependent=queuedIndependent.filter((item)=>item.tabId!==entry.tabId);
        await saveState();
      }
      await changePersistedClosure(decision.id,(record)=>({
        ...record,restoredDescendants:{
          ...(record.restoredDescendants||{}),
          [entry.tabId]:{status:'ready',tabId,incarnationId:incarnation,
            oldParentTabId:entry.parentTabId,newParentTabId:p.new_parent_tab_id,
            created:!stillLive,owner:workerOwners[tabId]},
        },
      }));
      void pushManagedAgentStatus(p.new_parent_tab_id);
      void pushManagedAgentStatus(tabId);
      void enableManagedAntiFreeze(tabId);
      return {old_tab_id:entry.tabId,tab_id:tabId,
        incarnation_id:incarnation,created:!stillLive,
        reused:stillLive,no_task_replay:true};
    }
    case 'desktop_finalize_accident_restore': {
      if(p.__trustedDesktopConsent!==true)
        throw new Error('Verified Desktop Accident completion required');
      const decision=await verifiedPendingClosure(p.decision_id,true);
      if(decision.status!=='restoring_children')
        throw new Error('No active Parent/Child subtree restoration to finalize');
      const root=await chrome.tabs.get(decision.candidateTabId).catch(()=>null);
      if(!root ||
          normalizedClosedTabUrl(root.url)!==decision.url ||
          (workerIncarnations[root.id]||managerIncarnations[root.id])!==
            decision.candidateIncarnationId)
        throw new Error('Restored ancestor identity is not live');
      for(const item of decision.descendants){
        const restored=decision.restoredDescendants?.[item.tabId];
        if(restored?.status!=='ready')
          throw new Error('Subtree restoration incomplete; missing Child '+item.tabId);
        const live=await chrome.tabs.get(restored.tabId).catch(()=>null);
        if(!live||!workers.includes(restored.tabId)||
            workerIncarnations[restored.tabId]!==restored.incarnationId ||
            workerParents[restored.tabId]!==restored.newParentTabId ||
            workerOwners[restored.tabId]!==restored.owner ||
            normalizedClosedTabUrl(live.url)!==
              normalizedClosedTabUrl(item.lastUrl))
          throw new Error('Restored descendant changed before final verification');
      }
      // Suppress overlapping Child decisions from the same closed window.
      // Ancestor Accident already restored those exact original identities.
      const restoredIds=new Set(decision.descendants.map((item)=>item.tabId));
      for(const child of await persistedClosureDecisions()) {
        if(child.id===decision.id ||
            child.browserSessionId!==browserSessionId ||
            !restoredIds.has(child.oldTabId) ||
            child.status==='resolved')continue;
        if(child.status!=='pending')
          throw new Error('Overlapping Child recovery is already in progress');
        await changePersistedClosure(child.id,(entry)=>({
          ...entry,status:'resolved',resolution:'ancestor_accident',
          resolvedAt:Date.now(),
        }));
      }
      await changePersistedClosure(decision.id,(entry)=>({
        ...entry,status:'resolved',resolution:'accident',resolvedAt:Date.now(),
      }));
      return {restored:true,descendants_verified:decision.descendants.length,
        no_task_replay:true};
    }
    case 'desktop_apply_agent_closure': {
      if(p.__trustedDesktopConsent!==true)
        throw new Error('Trusted desktop closure consent required');
      const decision=await verifiedPendingClosure(p.decision_id);
      if(!['yes','cancel'].includes(p.choice))
        throw new Error('Choose Yes or Cancel; Accident uses verified restoration');
      await changePersistedClosure(decision.id,(entry)=>({
        ...entry,status:'applying',resolution:p.choice,
      }));
      // A previously closed Agent's unfinished work is not silently
      // completed. Yes explicitly interrupts it; Cancel relinquishes
      // orchestration ownership while leaving its browser contents alone.
      for (const task of Object.values(tasks)) {
        if (task.tabId!==decision.oldTabId ||
            task.workerIncarnationId!==decision.incarnationId ||
            task.status!=='closed_pending_decision') continue;
        task.status=p.choice==='yes'?'failed':'detached';
        task.error=p.choice==='yes'
          ? 'User confirmed intentional Child closure; original task interrupted'
          : 'User detached the closed Child; completion could not be verified';
        task.finishedAt=Date.now();
      }
      const affected=decision.descendants
        .filter((child)=>workers.includes(child.tabId) &&
          workerIncarnations[child.tabId]===child.incarnationId);
      if(p.choice==='yes') {
        for(const child of [...affected].reverse()) {
          intentionalClosures.add(child.tabId);
          await chrome.tabs.remove(child.tabId).catch((error)=>{
            // A missing descendant was already closed; a still-open tab must
            // never be treated as intentionally closed on API failure.
            throw new Error('Could not close approved descendant '+child.tabId+
              '; reconciliation required: '+(error?.name||'browser error'));
          });
        }
      } else {
        for(const child of affected) {
          workers=workers.filter((id)=>id!==child.tabId);
          delete workerOwners[child.tabId];delete workerParents[child.tabId];
          delete workerIncarnations[child.tabId];
          detachedTabNotices[child.tabId]=true;
          void disableManagedAntiFreeze(child.tabId);
          void pushManagedAgentStatus(child.tabId);
          clearRoleSeatsForTab(child.tabId);
          for(const task of Object.values(tasks))
            if(task.tabId===child.tabId && ['running','queued','uncertain','waiting_for_children'].includes(task.status))
              task.status='detached';
        }
        const removed=new Set(affected.map((entry)=>entry.tabId));
        queuedFollowups=queuedFollowups.filter((item)=>!removed.has(item.tabId));
        queuedIndependent=queuedIndependent.filter((item)=>!removed.has(item.tabId));
        await saveState();
      }
      await changePersistedClosure(decision.id,(entry)=>({
        ...entry,status:'resolved',resolution:p.choice,resolvedAt:Date.now(),
      }));
      if(decision.kind==='child') {
        const originalTask=Object.values(tasks)
          .filter((task)=>task.tabId===decision.oldTabId &&
            task.workerIncarnationId===decision.incarnationId &&
            typeof task.owner==='string' && task.owner.startsWith('credential:'))
          .sort((a,b)=>b.startedAt-a.startedAt)[0];
        if(originalTask)void reportLostWorker({
          tabId:decision.oldTabId,task:originalTask,url:decision.url,
          owner:originalTask.owner,incarnation:decision.incarnationId,
          eventKey:decision.id,
          resolution:p.choice==='yes'?'INTENTIONALLY_CLOSED':'DETACHED',
        }).catch(()=>{});
      }
      return {resolved:true,choice:p.choice,affected_tab_ids:affected.map((x)=>x.tabId),
        tabs_preserved:p.choice==='cancel'};
    }
    case 'desktop_completion_status': {
      if(p.__trustedDesktopConsent!==true)
        throw new Error('Completion monitoring is a local Desktop-only control');
      return Object.values(tasks).filter((task)=>
        ['running','uncertain'].includes(task.status) &&
        task.monitor?.manualRequired===true &&
        workers.includes(task.tabId) &&
        workerIncarnations[task.tabId]===task.workerIncarnationId)
        .map((task)=>({task_id:task.id,tab_id:task.tabId,site:task.site,
          status:task.status,completion_evidence:task.completionEvidence||'UNKNOWN',
          next_check_at:task.monitor.nextCheckAt,manual_required:true}));
    }
    case 'desktop_set_manual_completion': {
      if(p.__trustedDesktopConsent!==true ||
          !/^[0-9a-f-]{36}$/i.test(p.task_id||'') ||
          !['completed','in_progress'].includes(p.status))
        throw new Error('Explicit local user choice and task ID required');
      const task=tasks[p.task_id];
      if(!task||!['running','uncertain'].includes(task.status)||
          !task.monitor?.manualRequired ||
          !workers.includes(task.tabId)||
          workerIncarnations[task.tabId]!==task.workerIncarnationId)
        throw new Error('No eligible Child task for manual status decision');
      if(p.status==='completed') {
        task.completionEvidence='USER_CONFIRMED';
        finishTask(task.id,{status:'done',
          result:'User confirmed completion; actual provider answer needs read_chat review'});
        await saveState();
        if(task.status==='done'){
          try{await submitPrivateWorkerReceipt(task);}
          catch{task.journalReceiptUncertain=true;await saveState();}
        }
      }else{
        task.monitor.manualChoice='IN_PROGRESS';
        task.monitor.nextCheckAt=Date.now()+completionMonitorSettings().continuedMinutes*60000;
        await saveState();
      }
      return {...summarize(task),completion_evidence:task.completionEvidence||null,
        pending_descendants:task.status==='waiting_for_children'};
    }
    case 'desktop_close_managed_browser': {
      // Trusted local desktop IPC only, never exposed to public MCP callers.
      // This extension runs inside the dedicated browser user-data-dir.
      // Close only normal browser windows after the desktop has explicitly
      // displayed a Close Managed Browser confirmation.
      if (p.__trustedDesktopConsent !== true)
        throw new Error('Explicit desktop quit consent required');
      const profile=await chrome.storage.local.get('profileInstallId');
      if (!/^[0-9a-f-]{36}$/i.test(p.expected_profile_install_id||'') ||
          profile.profileInstallId!==p.expected_profile_install_id)
        throw new Error('Managed browser enrollment does not match this extension profile');
      const windows=await chrome.windows.getAll({populate:false});
      const ids=windows.filter((item)=>item.type==='normal' &&
        Number.isSafeInteger(item.id)).map((item)=>item.id);
      if (!ids.length) return {scheduled:false,windows:0,confirmed_closed:0};
      const tracked=[];
      for(const id of ids) {
        const tabs=await chrome.tabs.query({windowId:id});
        for(const tab of tabs)
          if (workers.includes(tab.id) || approvedParents[tab.id]){
            const incarnationId=workerIncarnations[tab.id]||approvedParents[tab.id];
            if(incarnationId)tracked.push({tabId:tab.id,incarnationId,windowId:id});
          }
      }
      // Await persistence before any browser close side effect is scheduled.
      // If this fails, Desktop remains open and the browser is left untouched.
      await chrome.storage.local.set({intentionalManagedExit:{
        browserSessionId,createdAt:Date.now(),tabs:tracked,
      }});
      for(const tab of tracked)intentionalClosures.add(tab.tabId);
      // Verify earlier removals while the extension can still report errors.
      // Closing the final window can terminate this service worker/socket.
      const confirmedWindowIds=new Set();
      for(const id of ids.slice(0,-1)){
        try{await chrome.windows.remove(id);confirmedWindowIds.add(id);}
        catch{
          // The user's Quit choice must not suppress later accidental closes
          // in windows that Chrome actually refused to close.
          for(const item of tracked)
            if(!confirmedWindowIds.has(item.windowId))
              intentionalClosures.delete(item.tabId);
          await chrome.storage.local.set({intentionalManagedExit:{
            browserSessionId,createdAt:Date.now(),
            tabs:tracked.filter((item)=>confirmedWindowIds.has(item.windowId)),
          }});
          throw new Error('Could not close managed browser window '+id+
            '; Desktop remains open for recovery');
        }
      }
      const lastWindowId=ids[ids.length-1];
      // Reply to local IPC before closing the final browser window, which
      // may terminate the extension service worker/WebSocket connection.
      setTimeout(()=>{
        void chrome.windows.remove(lastWindowId).catch((error)=>{
          console.warn('[chat-orch] Final managed browser close failed',error?.name||'Error');
          void chrome.storage.local.set({lastManagedBrowserCloseFailure:{
            browserSessionId,windowId:lastWindowId,at:Date.now(),
            errorClass:error?.name||'Error',
          }}).catch(()=>{});
        });
      },450);
      return {scheduled:true,windows:ids.length,
        confirmed_closed:ids.length-1,remaining_windows:1};
    }
    case 'desktop_verify_managed_browser': {
      if(p.__trustedDesktopConsent!==true)
        throw new Error('Trusted desktop action required');
      const profile=await chrome.storage.local.get('profileInstallId');
      if(!/^[0-9a-f-]{36}$/i.test(profile.profileInstallId||''))
        throw new Error('Extension profile has not completed its authenticated connection');
      return {browser_session_id:browserSessionId,
        profile_install_id:profile.profileInstallId};
    }
    case 'desktop_update_readiness': {
      if(p.__trustedDesktopConsent!==true)
        throw new Error('Trusted desktop action required');
      const blockers=[];
      for(const task of Object.values(tasks)){
        if(!task || typeof task.id!=='string')continue;
        if(!['done','failed'].includes(task.status))
          blockers.push('Task '+task.id+' is '+(task.status||'unknown'));
        else if(task.owner!=='legacy' && task.parentReviewed!==true)
          blockers.push('Task '+task.id+' awaits Parent review');
      }
      if(queuedIndependent.length||queuedFollowups.length)
        blockers.push('Queued independent tasks or follow-ups remain');
      if(Object.values(managerWakes).some((wake)=>wake.status!=='processed'))
        blockers.push('Unprocessed Parent notification or uncertain delivery');
      // A recovered seat may mark the original task reviewResolved without
      // updating the independent closure status. Both are valid reconciliation.
      if(Object.values(lostWorkers).some((lost)=>
        lost.status!=='resolved' && lost.reviewResolved!==true))
        blockers.push('Unreconciled lost Child task');
      await closureWriteTail;
      const pendingClosures=(await persistedClosureDecisions()).filter((d)=>d.status!=='resolved');
      if(pendingClosures.length)blockers.push('Pending Agent closure decisions');
      return {ready:blockers.length===0,blockers:blockers.slice(0,15),
        checked_at:Date.now(),browser_session_id:browserSessionId};
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
      // An already-registered Parent remains the same Agent when its tab
      // navigates. The caller still has to pass current live page checks.
      if (!managerIncarnations[tab.id] && !workerIncarnations[tab.id])
        managerIncarnations[tab.id] = crypto.randomUUID();
      if (!workers.includes(tab.id)) managerSites[tab.id]=observedSite;
      await saveState();
      return { tab_id: tab.id, browser_session_id: browserSessionId,
        incarnation_id: workerIncarnations[tab.id] || managerIncarnations[tab.id],
        connection_generation: connectionGeneration };
    }
    case 'inspect_tab':
      return inspectChatTab(p.tab_id);
    case 'recover_owned_children': {
      // Proxy-internal read-only reconciliation: no browser creation/replay.
      if (p.__trustedRecovery !== true || typeof p.owner_credential!=='string' ||
          !/^[0-9a-f-]{36}$/i.test(p.owner_credential))
        throw new Error('Invalid descendant recovery request');
      const children=[];
      for (const id of workers) {
        if (workerOwners[id]!=='credential:'+p.owner_credential) continue;
        const live=await inspectChatTab(id).catch(()=>null);
        if (live?.is_managed_worker) children.push(live);
      }
      return children;
    }
    case 'inspect_all_tabs': {
      const tabs = await chrome.tabs.query({url:TAB_PATTERNS});
      return tabs.map((tab) => ({tab_id:tab.id,site:siteOfUrl(tab.url),
        title:tab.title,active:tab.active,is_managed_worker:workers.includes(tab.id),
        incarnation_id:workerIncarnations[tab.id] || managerIncarnations[tab.id] || null,
        parent_approved:isApprovedParent(tab.id)}));
    }

    // Internal server-to-extension operations. These are deliberately NOT public
    // Worker Tool MCP registrations. The server supplies verified identity.
    case 'manager_state': {
      if (p.__trustedPrincipal?.mode !== 'profile') throw new Error('Configured profile manager required');
      const cfg = await getConfig();
      const manager = await callerManagerTab(p, cfg);
      const currentTab=await chrome.tabs.get(manager);
      const state = await tabMessage(manager, {cmd:'observe_state'});
      const page = await pageSettling.snapshot(manager);
      return {tab_id:manager,
        conversation_route:safeConversationRoute(currentTab?.url),
        state:page.ready ? state?.state || 'unknown' : 'loading',
        ready:page.ready && state?.ok === true && state.state === 'idle',
        page,
        browser_session_id: browserSessionId,
        incarnation_id: workerIncarnations[manager] || managerIncarnations[manager] };
    }
    case 'focus_manager_tab': {
      if(p.__trustedPrincipal?.mode!=='profile')throw new Error('Paired manager required');
      const tabId=await callerManagerTab(p,await getConfig());
      const tab=await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId,{active:true});
      if(Number.isSafeInteger(tab.windowId))
        await chrome.windows.update(tab.windowId,{focused:true});
      return {focused:true,tab_id:tabId};
    }
    case 'inspect_manager_batch':
    case 'retry_manager_batch':
    case 'clear_skipped_manager_batch': {
      if(p.__trustedPrincipal?.mode!=='profile')throw new Error('Paired manager required');
      if(!/^[0-9a-f-]{36}$/i.test(p.batch_id||'') ||
         typeof p.prompt_text!=='string' || p.prompt_text.length>60000 ||
         !p.prompt_text.includes(p.batch_id))
        throw new Error('Invalid batch recovery request');
      const tabId=await callerManagerTab(p,await getConfig());
      const tab=await chrome.tabs.get(tabId);
      if(siteOfUrl(tab?.url)!=='chatgpt')
        throw new Error('Recovery is restricted to the authenticated ChatGPT manager tab');
      const origin=p.origin_parent_url==null?null:safeConversationRoute(p.origin_parent_url);
      if(p.origin_parent_url!=null && origin!==p.origin_parent_url)
        throw new Error('Invalid original conversation route');
      if(origin && safeConversationRoute(tab.url)!==origin)
        return {ok:false,verified:false,reason:'OPEN_ORIGINAL_PARENT_CONVERSATION'};
      const retry=method==='retry_manager_batch';
      const clear=method==='clear_skipped_manager_batch';
      if(retry){
        await chrome.tabs.update(tabId,{active:true});
        if(Number.isSafeInteger(tab.windowId))
          await chrome.windows.update(tab.windowId,{focused:true});
      }
      const result=await tabMessage(tabId,{cmd:retry?'retry_manager_draft':
        clear?'clear_manager_batch_draft':'inspect_manager_batch',
        batchId:p.batch_id,text:p.prompt_text});
      if(retry && result?.submitted===true){
        const prior=managerWakes[p.batch_id];
        if(prior && prior.owner===owner && prior.managerTabId===tabId){
          prior.status='submitted';await saveState();
        }
      }
      return result;
    }
    case 'resolve_manager_recovery': {
      if(p.__trustedPrincipal?.mode!=='profile')throw new Error('Paired manager required');
      if(!/^[0-9a-f-]{36}$/i.test(p.batch_id||'') ||
         !['submitted','processed'].includes(p.status))
        throw new Error('Invalid manager recovery');
      const tabId=await callerManagerTab(p,await getConfig());
      const prior=managerWakes[p.batch_id];
      if(prior && (prior.owner!==owner || prior.managerTabId!==tabId))
        throw new Error('Manager recovery cannot change an unrelated owner or tab');
      if(p.status==='submitted'){
        const proof=await tabMessage(tabId,{
          cmd:'confirm_manager_batch_sent',batchId:p.batch_id});
        if(proof?.verified!==true)
          throw new Error('Sent message was not verified in the managed Parent user turn');
      }
      managerWakes[p.batch_id]={owner,managerTabId:tabId,
        status:p.status,recordedAt:prior?.recordedAt||Date.now()};
      await saveState();
      return {recorded:true};
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
      const origin=p.origin_parent_url == null ? null : safeConversationRoute(p.origin_parent_url);
      if (p.origin_parent_url != null && origin!==p.origin_parent_url)
        throw new Error('Untrusted Parent conversation URL');
      if (origin && siteOfUrl(managerTab.url)!=='chatgpt')
        throw new Error('Parent provider changed since original delegation');
      const releaseForeground=siteOfUrl(managerTab.url)==='chatgpt'
        ? await acquireForegroundSubmitLease(managerTabId,'manager') : null;
      try {
      // D-056: when a result belongs to an earlier conversation, immediately
      // restore that conversation even if the currently displayed chat has an
      // unsent draft or is generating. The user explicitly accepted this
      // possible interruption. No focus or unrelated tab is changed.
      if(!origin || safeConversationRoute(managerTab.url)===origin)
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
        if (origin && safeConversationRoute(managerTab.url)!==origin) {
          // Navigate only this already-authenticated Parent tab; never steal
          // the user's foreground OS window or open an unrelated tab.
          await chrome.tabs.update(managerTabId,{url:origin});
          await pageSettling.waitForReady(managerTabId);
          const arrived=await chrome.tabs.get(managerTabId);
          if (safeConversationRoute(arrived?.url)!==origin ||
              (workerIncarnations[managerTabId]||managerIncarnations[managerTabId])!==
                p.__trustedPrincipal.sessionIncarnationId)
            throw new Error('Parent tab changed during origin conversation navigation');
          await confirmTabIdle(managerTabId);
        }
        const beforeSend=await chrome.tabs.get(managerTabId);
        if (origin && safeConversationRoute(beforeSend?.url)!==origin)
          throw new Error('Parent navigated away before FIFO delivery');
        if(releaseForeground){
          const focusedWindow=await chrome.windows.get(beforeSend.windowId);
          if(!beforeSend.active || focusedWindow?.focused!==true)
            throw new Error('Parent lost foreground focus before queue Send; no submission attempted');
        }
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
      } finally {
        if(releaseForeground)await releaseForeground();
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
      workerParents[tab.id]=managerTabId;
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
      // D-057/D-071: legacy provider adapters remain internal, but v1 may
      // neither spawn another provider nor scrape a chat transcript for a Child.
      if (p.site !== 'chatgpt')
        return {spawned:false,status:'PROVIDER_NOT_SUPPORTED',
          supported_providers:['chatgpt'],
          message:'This release supports ChatGPT workers only.'};
      if (p.share_context_from != null)
        throw new Error('Automatic chat transcript copying is not supported; include task-specific context in task');
      if (p.__trustedPrincipal?.mode==='profile' && privateQueueMode!=='enabled')
        throw new Error('Parent notification queue unavailable; refusing a managed Child whose completion cannot be delivered');
      extensionDiagnostic('info','worker.spawn_received',{site:p.site,
        taskLength:typeof p.task==='string'?p.task.length:0,
        lineCount:typeof p.task==='string'?p.task.split(/\r?\n/).length:0,
        operation:p.operation || 'task',deferred:p.__defer_start===true,
        roleScopePresent:typeof p.role_scope==='string'});
      const site = SITES[p.site];
      extensionDiagnostic('debug','worker.site_validated',{site:p.site,supported:Boolean(site)});
      if (!site) throw new Error(`Unknown site "${p.site}". Use "chatgpt", "claude" or "gemini".`);
      const seatKey = roleSeatKey(p, owner);
      extensionDiagnostic('debug','worker.seat_resolved',{hasSeat:Boolean(seatKey),reserved:Boolean(seatKey&&roleSeatReservations.has(seatKey)),
        priorSeat:Boolean(seatKey&&roleSeats[seatKey])});
      if (seatKey && roleSeatReservations.has(seatKey)) {
        throw new Error('Role seat is already being started; retry after its startup finishes');
      }
      if (seatKey) roleSeatReservations.add(seatKey);
      let reservedWorkerSlot = null;
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
            const origin=await parentOriginRoute(p,cfg);
            const result = await launchOrQueueIndependent(prior.tabId,p.site,p.task,
              p.wait_seconds || 0,cfg,owner,origin);
            return { ...result, reused_tab: true, seat_role: p.role, seat_scope: p.role_scope };
          }
          delete roleSeats[seatKey];
          await saveState();
        }
        extensionDiagnostic('debug','worker.guard_begin',{newWorker:true});
        reservedWorkerSlot = crypto.randomUUID();
        const cfg = await guard({ newWorker: true, reserveSlot: reservedWorkerSlot });
        extensionDiagnostic('debug','worker.guard_complete',{enabled:cfg.enabled,maxWorkers:cfg.maxWorkers,
          maxTasksPerHour:cfg.maxTasksPerHour,taskTimeoutMin:cfg.taskTimeoutMin,
          runningTasks:Object.values(tasks).filter((task)=>task.status==='running').length,
          workers:workers.length});
        if (p.auto_close === true || (p.keep_open !== true && cfg.autoCloseWorkers)) {
          throw new Error('Automatic worker closure is disabled; parent review and explicit close_worker are required');
        }
        extensionDiagnostic('debug','worker.manager_resolve_begin',{configuredManager:Number.isSafeInteger(cfg.orchestratorTabId)});
        const managerTabId = await callerManagerTab(p, cfg);
        extensionDiagnostic('debug','worker.manager_resolve_done',{tabId:managerTabId});
        extensionDiagnostic('debug','worker.prompt_build_begin',{taskLength:p.task.length,
          contextLength:0,composedPromptPresent:typeof p.prompt_text==='string',
          composedPromptLength:typeof p.prompt_text==='string'?p.prompt_text.length:0});
        const prompt = buildWorkerPrompt(cfg, p.task, '', p.role, p.prompt_text);
        extensionDiagnostic('debug','worker.prompt_build_done',{promptLength:prompt.length,
          lineCount:prompt.split(/\r?\n/).length,contextLength:0});
        extensionDiagnostic('info','worker.tab_creation_begin',{rootTabId:managerTabId,site});
        const createdTab = await createManagedWorkerTab(site.newChatUrl,p,managerTabId);
        const tabId = createdTab.id;
        extensionDiagnostic('info','worker.tab_creation_done',{tabId,site,
          windowId:createdTab.windowId,groupId:createdTab.groupId});
        workers.push(tabId);
        workerOwners[tabId] = owner;
        workerParents[tabId] = managerTabId;
        workerIncarnations[tabId] = crypto.randomUUID();
        workerUrls[tabId] = site.newChatUrl;
        void enableManagedAntiFreeze(tabId);
        void pushManagedAgentStatus(managerTabId);
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
        const origin=await parentOriginRoute(p,cfg);
        const result = await startTask(tabId, p.site, prompt, p.wait_seconds || 0,
          cfg, false, owner, null, origin);
        return seatKey ? { ...result, reused_tab: false, seat_role: p.role, seat_scope: p.role_scope } : result;
      } finally {
        if (reservedWorkerSlot) workerSlotReservations.delete(reservedWorkerSlot);
        if (seatKey) roleSeatReservations.delete(seatKey);
      }
    }

    case 'start_prepared_worker': {
      if (p.site !== 'chatgpt')
        throw new Error('PROVIDER_NOT_SUPPORTED: This release supports ChatGPT workers only');
      if (p.share_context_from != null)
        throw new Error('Automatic chat transcript copying is not supported; include context in task');
      if (p.__trustedPrincipal?.mode==='profile' && privateQueueMode!=='enabled')
        throw new Error('Parent notification queue unavailable; managed task cannot start');
      const tabId = p.tab_id;
      if (!ownedWorker(tabId,owner) || workerIncarnations[tabId] !== p.expected_incarnation_id) {
        throw new Error('Prepared worker ownership/incarnation mismatch');
      }
      const cfg = await guard();
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (siteOfUrl(tab?.url) !== p.site) throw new Error('Prepared worker changed site');
      if (p.auto_close === true) throw new Error('Automatic worker closure is disabled');
      const prompt = p.reused_tab === true ? p.task :
        buildWorkerPrompt(cfg,p.task,'',p.role,p.prompt_text);
      const origin=await parentOriginRoute(p,cfg);
      const result = p.reused_tab === true
        ? await launchOrQueueIndependent(tabId,p.site,prompt,p.wait_seconds || 0,cfg,owner,origin)
        : await startTask(tabId,p.site,prompt,p.wait_seconds || 0,cfg,false,owner,null,origin);
      return {...result,reused_tab:p.reused_tab === true,
        seat_role:p.role || null,seat_scope:p.role_scope || null};
    }


    case 'send_to_tab': {
      const cfg = await guard();
      if (!ownedWorker(p.tab_id, owner)) {
        throw new Error('send_to_tab requires a worker owned by this caller');
      }
      if (p.__trustedPrincipal?.mode==='profile' && privateQueueMode!=='enabled')
        throw new Error('Parent notification queue unavailable; managed follow-up cannot start');
      const tab = await chrome.tabs.get(p.tab_id).catch(() => null);
      const site = siteOfUrl(tab?.url);
      if (!site) throw new Error(`Tab ${p.tab_id} does not support send_to_tab.`);
      const requests=Object.values(tasks).filter((item)=>
        item.tabId===p.tab_id && item.owner===owner &&
        item.workerIncarnationId===workerIncarnations[p.tab_id] &&
        item.status==='waiting_for_parent_context');
      if(requests.length>1)
        throw new Error('Multiple pending context requests; reconcile original tasks');
      if(requests.length===1) {
        const original=requests[0];
        if(queuedFollowups.some((entry)=>entry.taskId===original.id))
          throw new Error('Context response is already queued for this task');
        queuedFollowups.push({taskId:original.id,tabId:p.tab_id,site,text:p.text,owner,
          originParentUrl:original.originParentUrl,resumeContext:true});
        await saveState();
        void dispatchQueuedFollowups(p.tab_id);
        return {...summarize(original),context_status:'QUEUED',
          original_task_id:original.id,new_task_created:false};
      }
      const id=crypto.randomUUID();
      const origin=await parentOriginRoute(p,cfg);
      tasks[id]={id,tabId:p.tab_id,site,status:'queued',
        startedAt:Date.now(),owner,autoClose:false,originParentUrl:origin,
        workerIncarnationId:workerIncarnations[p.tab_id] || null};
      queuedFollowups.push({taskId:id,tabId:p.tab_id,site,text:p.text,owner,
        originParentUrl:origin});
      await saveState();
      // Return a truthful QUEUED receipt, not a fictitious prompt submission.
      // Asynchronous dispatch may start immediately when the Child is idle.
      void dispatchQueuedFollowups(p.tab_id);
      return summarize(tasks[id]);
    }

    case 'get_result': {
      const t = tasks[p.task_id];
      if (!t || (t.owner || 'legacy') !== owner) throw new Error('Unknown task_id in this caller scope (browser session may have restarted).');
      if (p.wait_seconds > 0) await waitTask(t.id, Math.min(p.wait_seconds, 50) * 1000);
      return summarize(tasks[t.id]);
    }
    case 'hold_child_for_context': {
      if(p.__trustedPrincipal?.mode!=='profile')
        throw new Error('A paired managed Child is required to request Parent context');
      const tabId=await callerManagerTab(p,await getConfig());
      if(!workers.includes(tabId))
        throw new Error('Only a managed Child may hold its task for Parent context');
      const matching=Object.values(tasks).filter((item)=>item.tabId===tabId &&
        item.workerIncarnationId===workerIncarnations[tabId] &&
        ['running','waiting_for_parent_context'].includes(item.status) &&
        (!p.task_id||p.task_id===item.id));
      if(matching.length!==1)
        throw new Error('No unambiguous active task for this clarification');
      const task=matching[0];
      if(task.status!=='waiting_for_parent_context'){
        task.status='waiting_for_parent_context';
        task.contextRequestedAt=Date.now();
        await saveState();
      }
      return {task_id:task.id,tab_id:tabId,status:'WAITING_FOR_PARENT_CONTEXT',
        origin_parent_url:task.originParentUrl||null};
    }
    case 'complete_task': {
      // The child can complete ONLY the task running in its own attested tab.
      // It cannot choose another tab or mark its siblings/descendants complete.
      if (p.__trustedPrincipal?.mode!=='profile')
        throw new Error('A paired managed Child is required for explicit completion');
      const agentTabId=await callerManagerTab(p,await getConfig());
      if (!workers.includes(agentTabId))
        throw new Error('Only a managed Child may explicitly complete its assigned task');
      const candidates=Object.values(tasks).filter((task)=>
        task.tabId===agentTabId &&
        task.workerIncarnationId===workerIncarnations[agentTabId] &&
        ['running','uncertain','waiting_for_children','done'].includes(task.status));
      // A unique active task is mandatory unless the child supplies a known
      // task ID. No fallback to the most recent unrelated historical task.
      const current=candidates.filter((task)=>
        ['running','uncertain','waiting_for_children'].includes(task.status));
      const task=p.task_id
        ? candidates.find((item)=>item.id===p.task_id)
        : current.length===1 ? current[0] : null;
      if (!task) throw new Error('No unambiguous assigned task; supply your actual task_id');
      // The authenticated Child has invoked complete_task from its ORIGINAL
      // paired tab, for its own current task and incarnation. That is stronger
      // proof that the setup prompt reached the Child than a fragile ChatGPT
      // user-turn DOM selector. Do not infer submission from UI completion.
      if(!task.submissionConfirmed) {
        task.submissionConfirmed=true;
        task.submissionEvidence='AUTHENTICATED_CHILD_COMPLETION';
        extensionDiagnostic('info','worker.submission_confirmed_by_child_completion',{
          tabId:agentTabId,taskId:task.id});
      }
      if (task.status==='done') {
        task.completionEvidence='EXPLICIT_MCP';
        await saveState();
        return {...summarize(task),already_completed:true,notification_replayed:false};
      }
      if (task.status==='waiting_for_children') {
        task.deferredCompletion={status:'done',
          result:task.deferredCompletion?.result || p.summary || 'Child explicitly completed its own task'};
        task.completionEvidence='EXPLICIT_MCP';
        await saveState();
        return {...summarize(task),pending_descendants:true};
      }
      task.completionEvidence='EXPLICIT_MCP';
      finishTask(task.id,{status:'done',
        result:p.summary || 'Child explicitly completed its own task'});
      await saveState();
      if (task.status==='done') {
        try {await submitPrivateWorkerReceipt(task);}
        catch {task.journalReceiptUncertain=true;await saveState();}
      }
      return {...summarize(task),pending_descendants:task.status==='waiting_for_children'};
    }
    case 'review_task': {
      const task=tasks[p.task_id];
      if (!task || task.owner!==owner || !ownedWorker(p.tab_id,owner))
        throw new Error('Only the direct owning Parent may review this Child task');
      const lost=lostWorkers[p.task_id];
      const recovered=Boolean(lost && lost.owner===owner &&
        lost.reopenedTabId===p.tab_id &&
        workerIncarnations[p.tab_id]===lost.reopenedIncarnation &&
        workerParents[p.tab_id]===p.__trustedPrincipal?.callerTabId);
      if (task.tabId!==p.tab_id && !recovered)
        throw new Error('Review target is not the original or recovered Child tab');
      if (!['done','failed'].includes(task.status))
        throw new Error('Task is still active, queued or uncertain; review not possible');
      if (queuedFollowups.some((item)=>item.tabId===p.tab_id))
        throw new Error('Pending corrections must be delivered and reviewed before starting an independent task');
      // Recovery does not implicitly review the lost conversation. This is
      // the explicit review gate AFTER the Parent inspected the new tab.
      if (recovered) lost.reviewResolved=true;
      task.parentReviewed=true;
      await saveState();
      await releaseReadyParentTasks();
      void dispatchQueuedIndependent(p.tab_id);
      return {task_id:task.id,tab_id:p.tab_id,reviewed:true};
    }
    case 'confirm_child_pairing_submission': {
      // Internal Proxy call after a one-time Child pairing code was
      // consumed against this exact live tab/route/incarnation. Ordinary
      // ChatGPT MCP methods cannot invoke this Extension-only operation.
      if(p.__verifiedChildPairing!==true ||
          p.__sessionBrowserId!==browserSessionId ||
          !workers.includes(p.tab_id) ||
          workerIncarnations[p.tab_id]!==p.worker_incarnation_id ||
          !String(workerOwners[p.tab_id] || '').startsWith('credential:'))
        throw new Error('Only the original verified Child pairing may confirm submission');
      const candidates=Object.values(tasks).filter((task)=>
        task.tabId===p.tab_id && task.owner===workerOwners[p.tab_id] &&
        task.workerIncarnationId===p.worker_incarnation_id &&
        ['running','uncertain'].includes(task.status));
      if(candidates.length!==1)return {verified:false,submission_confirmed:false};
      const task=candidates[0];
      if(!task.submissionConfirmed) {
        task.submissionConfirmed=true;
        task.submissionEvidence='AUTHENTICATED_CHILD_PAIRING';
        if(task.status==='uncertain' &&
            /^(Prompt submission outcome uncertain|Prompt submission receipt lost|.*no new user turn)/i.test(task.error || '')) {
          task.status='running';
          delete task.error;
          delete task.finishedAt;
        }
        await saveState();
        extensionDiagnostic('info','worker.submission_confirmed_by_child_pairing',{
          tabId:p.tab_id,taskId:task.id});
      }
      return {...summarize(task),verified:true};
    }
    case 'verify_worker_submission': {
      // Proxy-internal, read-only verification of a task's exact user turn.
      // A transport timeout or failed content ACK cannot cause a replay.
      if(p.__trustedPrincipal?.mode!=='profile' ||
          !ownedWorker(p.tab_id,owner) ||
          workerIncarnations[p.tab_id]!==p.worker_incarnation_id)
        throw new Error('Worker submission verification requires the original owned Child incarnation');
      const task=tasks[p.task_id];
      if(!task || task.tabId!==p.tab_id || task.owner!==owner ||
          task.workerIncarnationId!==p.worker_incarnation_id)
        throw new Error('Submission verification task identity mismatch');
      if(!task.submissionConfirmed) {
        // An authenticated Child may have completed AFTER spawn_worker
        // returned UNCERTAIN and BEFORE this Proxy next checks the hold.
        // This also reconciles tasks completed on an earlier Extension build.
        const explicitChildCompleted=task.completionEvidence==='EXPLICIT_MCP' &&
          ['done','waiting_for_children'].includes(task.status);
        const proof=explicitChildCompleted?{ok:true,verified:true}:
          await tabMessage(p.tab_id,{cmd:'verify_sent_turn',taskId:task.id});
        if(proof?.ok===true && proof.verified===true) {
          task.submissionConfirmed=true;
          task.submissionEvidence=explicitChildCompleted
            ? 'AUTHENTICATED_CHILD_COMPLETION':'VERIFIED_USER_TURN';
          await saveState();
          extensionDiagnostic('info','worker.submission_reconciled',{
            tabId:p.tab_id,taskId:task.id,
            proofType:explicitChildCompleted?'EXPLICIT_CHILD_COMPLETION':'USER_TURN'});
        }
      }
      return {...summarize(task),verified:task.submissionConfirmed===true};
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
          .map((task) => ({task_id:task.id,status:task.status,
            parent_reviewed:task.parentReviewed === true}))
      };
    }
    case 'read_chat': {
      const cfg = await guard();
      const managerTabId = await callerManagerTab(p, cfg);
      const tabId = p.tab_id == null ? managerTabId : p.tab_id;
      if (!Number.isSafeInteger(tabId)) throw new Error('No paired manager tab; select the orchestrator in the popup');
      // Transitive authorization is performed against the immutable ancestry
      // registry in Proxy. The extension accepts ONLY the read-only result of
      // that check; it does not grant inherited send/close rights.
      if (p.__ancestorRead === true && p.__trustedPrincipal?.mode === 'profile') {
        if (!workers.includes(tabId)) throw new Error('Descendant read target is not a managed worker');
      } else requireOwnedTab(tabId, managerTabId, owner);
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
          task.tabId === p.tab_id && ['queued','running','uncertain','waiting_for_children'].includes(task.status))) {
        throw new Error('Cannot close a Child with queued, running or uncertain work');
      }
      if (Object.values(tasks).some((task)=>task.tabId===p.tab_id &&
          task.workerIncarnationId===p.worker_incarnation_id &&
          task.parentReviewed!==true)) {
        throw new Error('Child still has work not explicitly reviewed by its Parent');
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
          ['queued','running','uncertain','waiting_for_children'].includes(t.status))) {
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
const pairingWaiters = new Map();
let keepTimer = null;
let reconnectTimer = null;
let attempts = 0;

async function connect() {
  if (connectPromise) return connectPromise;
  connectPromise = connectOnce().finally(() => { connectPromise = null; });
  return connectPromise;
}

async function connectOnce() {
  const cfg = await getConfig();
  clearTimeout(reconnectTimer);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  wsState = 'connecting';
  let thisSocket;
  try { thisSocket = new WebSocket(cfg.serverUrl); }
  catch (error) {
    wsState = `error: ${error.message}`;
    scheduleReconnect();
    return;
  }
  socketGeneration++;
  ws = thisSocket;
  thisSocket.onopen = async () => {
    if (thisSocket !== ws) return;
    wsState = 'registering';
    connectionGeneration++;
    extensionDiagnostic('info','bridge.connected',{connected:true});
    extensionDiagnostic('info','extension.build_loaded',{build:'parent-send-trace-20261116-v2'});
    proxySettings = null;
    proxySettingsRevision = 0;
    privateQueueMode = 'unknown';
    attempts = 0;
    lastHeartbeatAck = Date.now();
    const profile=await chrome.storage.local.get(['profileToken','profileInstallId']);
    if(!/^[0-9a-f-]{36}$/i.test(profile.profileInstallId||'')){
      profile.profileInstallId=crypto.randomUUID();
      await chrome.storage.local.set({profileInstallId:profile.profileInstallId});
    }
    if(thisSocket!==ws || thisSocket.readyState!==WebSocket.OPEN)return;
    // Browser brand is a best-effort sanity check, NOT OS process/profile
    // attestation. The dedicated profile still requires explicit user consent.
    const userAgent=typeof navigator==='object' && typeof navigator.userAgent==='string'
      ? navigator.userAgent : '';
    const browserProduct=/Edg\/[0-9]/.test(userAgent)?'edge'
      : /Chrome\/[0-9]/.test(userAgent)?'chrome':'unknown';
    const extensionVersion=chrome.runtime.getManifest?.().version||'';
    thisSocket.send(JSON.stringify({type:'register_session',browser_session_id:browserSessionId,
      profile_token:typeof profile.profileToken==='string'?profile.profileToken:'',
      profile_install_id:profile.profileInstallId,
      browser_product:browserProduct,extension_version:extensionVersion,
      connection_generation:connectionGeneration,proxy_session_id:proxySessionId}));
    clearInterval(keepTimer);
    keepTimer = setInterval(() => {
      if (thisSocket !== ws || thisSocket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastHeartbeatAck > 45000) {
        extensionDiagnostic('warn','bridge.heartbeat_timeout',{attempt:1});
        thisSocket.close(4000,'heartbeat timeout');
        return;
      }
      heartbeatNonce = crypto.randomUUID();
      thisSocket.send(JSON.stringify({type:'session_heartbeat',nonce:heartbeatNonce,
        browser_session_id:browserSessionId,connection_generation:connectionGeneration}));
    },15000);
  };

  ws.onmessage = async (ev) => {
    if (thisSocket !== ws) return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'session_registered') {
      if (msg.session_id !== browserSessionId || msg.connection_generation !== connectionGeneration) {
        thisSocket.close(4002,'session registration mismatch');
        return;
      }
      if (proxySessionId && proxySessionId !== msg.proxy_session_id) {
        try { await preserveOnProxyReconnect(msg.proxy_session_id); }
        finally {
          thisSocket.close(4000,'proxy session changed; reconnecting with preserved managed tabs');
        }
        return;
      }
      proxySessionId = msg.proxy_session_id;
      await chrome.storage.session.set({proxySessionId});
      privateQueueMode = msg.queue_enabled === true ? 'enabled' : 'disabled';
      wsState = 'connected';
      lastHeartbeatAck = Date.now();
      try {
        await reconcileMissedParentClosures();
        await reconcileMissedChildClosures();
      } catch(error) {
        extensionDiagnostic('warn','closure.reconcile_unverified',{
          reason:'BROWSER_INVENTORY_UNAVAILABLE',errorType:error?.name||'Error'});
      }
      thisSocket.send(JSON.stringify({type:'session_ready'}));
      void pushAllManagedAgentStatuses();
      return;
    }
    if (msg.type === 'session_heartbeat_ack') {
      if (msg.nonce === heartbeatNonce && msg.proxy_session_id === proxySessionId) {
        lastHeartbeatAck = Date.now();
      }
      return;
    }
    if (msg.type === 'settings_snapshot') {
      if (!acceptProxySettings(msg)) {
        proxySettings = null;
        wsState = 'invalid proxy settings';
      }
      else if (ws?.readyState === WebSocket.OPEN) {
        // A legacy extension only ACKs the revision, so the server cannot
        // know whether this PC's named connector was actually applied.
        ws.send(JSON.stringify({type:'settings_applied',revision:msg.revision,
          connector_name:proxySettings.connectorName,
          routing_capability:'connector_name_routing_v1'}));
      }
      return;
    }
    if (msg.type === 'coordination_capabilities') {
      if (typeof msg.session_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(msg.session_id)) return;
      if (proxySessionId && proxySessionId !== msg.session_id)
        await preserveOnProxyReconnect(msg.session_id);
      proxySessionId = msg.session_id;
      await chrome.storage.session.set({proxySessionId});
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
    if (msg.type === 'pairing_offer_ack') {
      const pending = pairingWaiters.get(msg.request_id);
      if (!pending) return;
      pairingWaiters.delete(msg.request_id);
      clearTimeout(pending.timer);
      if (msg.ok === true) pending.resolve();
      else pending.reject(new Error(msg.error || 'Pairing offer rejected'));
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
      extensionDiagnostic('debug','bridge.result_send_begin',{requestId:msg.id,method:msg.method});
      socket.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result }));
      extensionDiagnostic('debug','bridge.result_send_done',{requestId:msg.id,method:msg.method});
    } catch (err) {
      extensionDiagnostic('warn','bridge.call_failed',{requestId:msg.id,
        method:msg.method,success:false});
      socket.send(JSON.stringify({ type: 'result', id: msg.id, ok: false,
        error: String(err?.message || err),
        error_code: err?.code === 'COMPOSER_DRAFT_MISMATCH' ? err.code : undefined }));
    }
  };

  thisSocket.onclose = (event) => {
    if (thisSocket !== ws) return;
    wsState = 'disconnected';
    void pushAllManagedAgentStatuses();
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
    if (event.code === 4001) {
      // A normal Proxy shutdown MUST NOT erase the browser session or its
      // still-open Child tabs. A new Proxy process will be paired to the
      // existing browser state after reconnect; uncertain work is never
      // blindly submitted a second time.
      void preserveOnProxyReconnect(null)
        .catch((error)=>console.warn('[chat-orch] Recovery hold failed:',error.message))
        .finally(scheduleReconnect);
    } else if (event.code !== 4003) scheduleReconnect();
  };
  thisSocket.onerror = () => {};
}

// A server fsync ACK is the only successful private event receipt.
async function submitPrivateWorkerReceipt(task) {
  if ((task.owner || 'legacy') === 'legacy') return true;
  if (privateQueueMode === 'disabled')
    throw new Error('Parent notification queue disabled; completion delivery is NOT confirmed');
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
    worker_incarnation_id: task.workerIncarnationId,browser_session_id:browserSessionId,
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
  clearTimeout(reconnectTimer);
  try { ws?.close(4003,'extension settings changed'); } catch {}
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
  if (a.name === 'keepalive') {
    if (!ws || ws.readyState !== WebSocket.OPEN) connect();
    for (const item of queuedFollowups) void dispatchQueuedFollowups(item.tabId);
    for (const item of queuedIndependent) void dispatchQueuedIndependent(item.tabId);
    void releaseReadyParentTasks();
    void checkDueCompletions();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.serverUrl || changes.profileToken)) reconnectNow();
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
  ws.send(JSON.stringify({type:'worker_lost',request_id:requestId,
    event_key:info.eventKey||crypto.randomUUID(),resolution:info.resolution||'UNVERIFIED',
    task_id:info.task.id,tab_id:info.tabId,credential_id:info.owner.slice('credential:'.length),
    worker_incarnation_id:info.incarnation,saved_url:safeUrl,browser_session_id:browserSessionId}));
  try {
    const result=await receipt;
    if (result?.durably_recorded !== true) throw new Error('No durable receipt');
  } catch {console.warn('[coordination] Lost worker event UNCERTAIN; do not retry blindly');}
}
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  pageSettling.onUpdated(tabId,changeInfo,tab);
  await stateReady;
  if(changeInfo?.status==='complete' &&
      siteOfUrl(tab?.url)==='chatgpt') {
    if(managedAgentStatus(tabId).managed)void enableManagedAntiFreeze(tabId);
    void pushManagedAgentStatus(tabId);
  }
  if (changeInfo?.url && managerIncarnations[tabId]) {
    const newSite = siteOfUrl(changeInfo.url);
    // Do not revoke the immutable Parent role on navigation or focus change.
    // A live unsupported page cannot submit/read chats via callerManagerTab,
    // while a later supported page is re-checked before every privileged call.
    if (newSite) {
      managerSites[tabId] = newSite;
      extensionDiagnostic('debug','identity.managed_navigation',{tabId,site:newSite});
    } else {
      extensionDiagnostic('debug','identity.unsupported_page_held',{tabId});
    }
    await saveState();
  }
  const url=changeInfo?.url || tab?.url;
  if (typeof url==='string' && siteOfUrl(url)) {workerUrls[tabId]=url;void saveState();}
  if (typeof tab?.title==='string' && (workers.includes(tabId) || approvedParents[tabId])) {
    tabTitles[tabId]=tab.title.slice(0,140);
    void saveState();
  }
  await stateReady;
});
const managedTabRemovals=new Set();
async function handleManagedTabRemoved(tabId) {
  await stateReady;
  // A live onRemoved event and post-reconnect inventory may race. Only one
  // handler may persist/retire the same browser tab/incarnation at a time.
  if(managedTabRemovals.has(tabId))return;
  managedTabRemovals.add(tabId);
  try {
  pageSettling.forget(tabId);
  delete detachedTabNotices[tabId];
  delete dismissedParentOffers[tabId];
  const managed=workers.includes(tabId);
  const incarnation=workerIncarnations[tabId] || managerIncarnations[tabId];
  const intentional=intentionalClosures.delete(tabId) ||
    await intentionalDesktopExitFor(tabId,incarnation);
  const userApprovedRoot=isApprovedParent(tabId);
  const needsHumanDecision=!intentional && (managed || userApprovedRoot);
  if (needsHumanDecision) {
    // The closure of a whole browser window can emit onRemoved for Parent,
    // Child and Grandchild in rapid succession. One ancestor decision governs
    // the subtree; don't generate contradictory prompts for those tabs.
    await closureWriteTail;
    const existingClosures=await persistedClosureDecisions();
    const coveredByAncestor=existingClosures.some((entry)=>
      entry.status!=='resolved' && entry.browserSessionId===browserSessionId &&
      entry.descendants?.some((child)=>
        child.tabId===tabId && child.incarnationId===incarnation));
    // When Child B closed before its Parent A, B is absent from the live
    // worker list. Carry its pending observation into A's ancestry snapshot
    // so the higher-level Parent decision still governs B and Grandchild C.
    const recordedDescendants=descendantsOf(tabId);
    for (const prior of existingClosures) {
      if (prior.status==='resolved' || prior.browserSessionId!==browserSessionId)
        continue;
      if (prior.parentTabId!==tabId &&
          !recordedDescendants.some((child)=>child.tabId===prior.parentTabId))
        continue;
      recordedDescendants.push({tabId:prior.oldTabId,
        incarnationId:prior.incarnationId,parentTabId:prior.parentTabId,
        title:prior.title,site:siteOfUrl(prior.url),state:'closed_pending_decision',
        lastUrl:prior.url});
      for(const child of prior.descendants||[])
        if(!recordedDescendants.some((item)=>item.tabId===child.tabId))
          recordedDescendants.push(child);
    }
    const decision={
      id:crypto.randomUUID(),browserSessionId,
      oldTabId:tabId,incarnationId:incarnation,
      kind:managed?'child':'parent',parentTabId:managed?workerParents[tabId]:null,
      originalOwner:managed?workerOwners[tabId]:null,
      url:normalizedClosedTabUrl(workerUrls[tabId]),
      title:(tabTitles[tabId] || (managed?'Managed Child':'Approved Parent')).slice(0,140),
      descendants:recordedDescendants,createdAt:Date.now(),status:'pending',
    };
    try {if(!coveredByAncestor)await persistAgentClosure(decision);}
    catch(error) {
      console.error('[chat-orch] Failed to persist user-mediated tab closure; do not restore or close children automatically',
        error?.name||'Error');
      // Keep the ownership record intact so a later verified inventory can
      // retry the durable decision. Otherwise the absent Child is lost forever.
      return;
    }
  }
  delete approvedParents[tabId];
  for (const pending of queuedFollowups.filter((item)=>item.tabId===tabId)) {
    const task=tasks[pending.taskId];
    if (task?.status === 'queued') {
      task.status=needsHumanDecision?'closed_pending_decision':'failed';
      task.error=needsHumanDecision
        ? 'Managed Child tab closed; awaiting Accident / Yes / Cancel, no prompt replay'
        : 'Child closed before the queued instruction was submitted';
      task.finishedAt=Date.now();
    }
  }
  queuedFollowups=queuedFollowups.filter((item)=>item.tabId!==tabId);
  for (const pending of queuedIndependent.filter((item)=>item.tabId===tabId)) {
    const task=tasks[pending.taskId];
    if (task?.status === 'queued') {
      task.status=needsHumanDecision?'closed_pending_decision':'failed';
      task.error=needsHumanDecision
        ? 'Managed Child tab closed; awaiting Accident / Yes / Cancel, no prompt replay'
        : 'Child closed before the queued independent task was submitted';
      task.finishedAt=Date.now();
    }
  }
  queuedIndependent=queuedIndependent.filter((item)=>item.tabId!==tabId);
  const owner=workerOwners[tabId],parentTabId=workerParents[tabId],
    url=workerUrls[tabId];
  const task=Object.values(tasks).filter(t=>t.tabId===tabId&&t.workerIncarnationId===incarnation)
    .sort((a,b)=>b.startedAt-a.startedAt)[0];
  workers=workers.filter(id=>id!==tabId);
  delete workerOwners[tabId];delete workerParents[tabId];delete workerIncarnations[tabId];delete workerUrls[tabId];
  clearRoleSeatsForTab(tabId);delete managerIncarnations[tabId];
  delete managerSites[tabId];delete tabTitles[tabId];
  for (const t of Object.values(tasks)) if(t.tabId===tabId) {
    if(needsHumanDecision &&
        ['running','uncertain','waiting_for_children','queued'].includes(t.status)) {
      t.status='closed_pending_decision';
      delete t.deferredCompletion;
      t.error='Agent tab closed; waiting for explicit user recovery decision';
      (waiters[t.id]||[]).forEach((resolve)=>resolve());
      delete waiters[t.id];
    } else if (!needsHumanDecision) {
      finishTask(t.id,{status:'failed',
        error:'Tab closed or unavailable before task completion'});
    }
  }
  if(managed&&!intentional&&task&&url&&incarnation&&owner?.startsWith('credential:')){
    try {
      const parsed=new URL(url);
      if(parsed.protocol==='https:'&&siteOfUrl(url)) {
        lostWorkers[task.id]={tabId,owner,parentTabId,incarnation,url:parsed.origin+parsed.pathname,
          recordedAt:Date.now()};
        await saveState();
      }
    } catch {}
    // Do not emit CHILD_TASK_COMPLETED or a final-loss outcome before the
    // user's explicit closure choice. A premature queue event would race with
    // Accident and could incorrectly instruct the Parent to re-delegate.
    // The durable closure decision is the pending source of truth.
    await saveState();
  } else await saveState();
  } finally { managedTabRemovals.delete(tabId); }
}
chrome.tabs.onRemoved.addListener(handleManagedTabRemoved);
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await stateReady;
    switch (msg?.type) {
      case 'managed_agent_status_request': {
        if(sender.id!==chrome.runtime.id || sender.frameId!==0 ||
            !Number.isSafeInteger(sender.tab?.id) ||
            siteOfUrl(sender.tab?.url)!=='chatgpt'){
          sendResponse({managed:false});
          break;
        }
        sendResponse(managedAgentStatus(sender.tab.id));
        break;
      }
      case 'dismiss_parent_offer': {
        if(sender.id!==chrome.runtime.id || sender.frameId!==0 ||
            !Number.isSafeInteger(sender.tab?.id) ||
            siteOfUrl(sender.tab?.url)!=='chatgpt' ||
            managedAgentStatus(sender.tab.id).managed){
          sendResponse({ok:false});break;
        }
        dismissedParentOffers[sender.tab.id]=true;
        await saveState();
        sendResponse({ok:true});
        break;
      }
      case 'worker_diagnostic': {
        const diagnostic=msg.diagnostic;
        // Parent initialization uses the same content-script submit path as
        // Child work. The previous worker-only gate silently dropped every
        // Parent submit diagnostic. Preserve strict tab/role authorization.
        const trustedTabId=sender.tab?.id;
        const workerSource=workers.includes(trustedTabId);
        const parentSource=approvedParents[trustedTabId] &&
          approvedParents[trustedTabId]===managerIncarnations[trustedTabId];
        if (sender.id!==chrome.runtime.id || sender.frameId!==0 ||
            !Number.isSafeInteger(trustedTabId) || (!workerSource && !parentSource) ||
            !diagnostic || typeof diagnostic!=='object' ||
            diagnostic.site!==siteOfUrl(sender.tab.url) || typeof diagnostic.step!=='string' ||
            !/^[a-z][a-z0-9_]{0,63}$/.test(diagnostic.step)) {
          sendResponse({ok:false});
          break;
        }
        const allowed=new Set(['taskId','at','textLength','documentReady','composers','cmd',
          'senderTabId','frameId','requestId','ok','lineCount','status','workerCount','taskCount',
          'composerTag','durationMs','composer','inputCounts','selectedIndex','candidates',
          'selector','visible','tag','role','contentEditable','testId','ariaLabel','active',
          'textLength','expectedLength','exactMatch','whitespaceMatch','firstDifference','actualCodePoint','expectedCodePoint',
          'actualClass','expectedClass','actualCollapsedLength','expectedCollapsedLength',
          'actualShape','expectedShape','kind','lines','lineCount','sectionDifferences','name',
          'present','presentActual','presentExpected','actualLength','expectedLength',
          'collapsedEqual','collapsedFirstDifference',
          'collapsedEqual','collapsedFirstDifference','whitespace',
          'index','actualCodePoint','expectedCodePoint','actualLength','newlineCount',
          'formTestId','formAction','activeTag','activeRole','scopeTag','scopeTestId',
          'buttons','enabled','disabled','ariaDisabled','inComposer','connected','step',
          'existingDraftLength','matchesTask','whitespaceEquivalent','sendButtons',
          'userTurnCount','generating','line','accepted','lineLength','valueLength',
          'dispatchAccepted','exact','selectedStart','selectedEnd','rangeCount',
          'selectedTextLength','composerPolls','poll','found','elapsedMs','state',
          'button','sameComposer','matchesTask','testId','userTurnsBefore','confirmed',
          'readinessState','readinessDurationMs','success','replyOk','uncertain',
          'notSubmitted','taskCount','workerCount','operation','promptLength',
          'contextLength','browserSessionId','windowId','groupId','blockerCount',
          'phase','workerOwned','focused','incarnationPresent','tasksLastHour',
          'userTurnsAfter','draftLength','accountChanged','code','reason','submitAttempted',
          'insertedByUs','receiptNonceValid','timeoutMs','baselineAssistantTurns',
          'operation','lineCount','prepared','reusedTab',
          'resultLength','resultType','errorType','attempt','stage','site','cmd','senderTabId',
          'frameId','requestId','ok','timeoutMs','selectedIndex','newlineCount',
          'actualCodePoint','expectedCodePoint','actualLength','textLength','lineCount',
          'reusedTab','prepared','workerCount','taskCount','status','success',
          'remainingMs','settledMs','polls','wasTracked','urlChanged','tabStatus',
          'tabExists','documentComplete','active','durationMs','errorType',
          'exactMatch','whitespaceMatch','firstDifference','formTestId','activeTag',
          'activeRole','contentEditable','ariaLabel','testId','enabled','disabled',
          'ariaDisabled','inComposer','connected','scopeTag','scopeTestId','buttons',
          'candidateCount','selectorCount','inputIndex','delayMs','sameAsBefore','composerConnected',
          'selectors','pollIntervalMs','total','scopeKind','scope','reason','allMatchesDisabled',
          'rootPresent','found','matched','candidateCount','enabledCount','durationMs',
          'inputPresent','connected','charsBefore','activeBefore','activeAfter','selectedStart',
          'selectedEnd','selectionStart','selectionEnd','accepted','exact','valueLength',
          'lineLength','dispatchAccepted','inputLength','empty','remainingLength',
          'candidateCount','userTurnCount','generating','testId','ariaLabel','sameComposer',
          'clearOnlyOwnInsertedDraft','expectedLength','draftLength','matchesTask',
          'whitespaceEquivalent','buttonConnected','buttonEnabled','enabled','disabled',
          'dataDisabled','ariaDisabled','pageReady','documentReady','accountChanged',
          'confirmed','polls','elapsedMs','submitted','resultLength','baselineAssistantTurns',
          'timeoutMs','receiptNonceValid','readinessState','errorType','stage',
          'submissionReported','uncertain','notSubmitted','ok','success',
          'attempt','requestId','cmd','senderTabId','frameId','selected','button',
          'buttonCount','candidateCount','scopeTag','scopeTestId','expectedLength',
          'actualLength','actualCodePoint','expectedCodePoint','actualClass','expectedClass',
          'actualCollapsedLength','expectedCollapsedLength','collapsedEqual','index',
          'newlineCount','textLength','lineCount','at','site','taskId',
          'draftMatches','selected','rootPresent','matched','enabledCount','buttonConnected',
          'buttonEnabled','pageReady','confirmationPolls','clearOnlyOwnInsertedDraft',
          'remainingLength','inputPolls','sendPolls','scopeName','selector','candidateIndex',
          'total','visible','matched','found','selected','durationMs','started',
          'quietMs','quietNeeded','generationStarted','resultMode','completionAttempt',
          'baselineCount','responseLength','timeoutMs','delayMs','accountChanged',
          'draftLength','expectedLength','buttonCount','buttonEnabled','buttonConnected',
          'scopeKind','scopeTestId','scopeTag','dataDisabled','candidateCount','enabledCount',
          'replyOk','responseAccepted','duplicate','submitted','reason','expectedClass',
          'actualClass','expectedCollapsedLength','actualCollapsedLength','collapsedEqual',
          'collapsedFirstDifference','whitespace','allMatchesDisabled']);
        for(const key of ['method','formPresent','errorCode','draftStillPresent',
          'userMarkerVisible','traceId','build','snapshot','editorId',
          'originalEditorId','currentEditorId','failureClass','present',
          'chosen','value','innerText','textContent','structure','formTag',
          'childElementCount','paragraphCount','brCount','spaceCount',
          'tabCount','buttonPresent','buttonEnabled','originalNewlines',
          'currentNewlines','exactNewlinesToSpaces','evidenceType',
          'matchedNewTurn','newUserTurnCount','matchedMarker','matchedUserTurn',
          'draftCleared','copyProjectionPresent'])allowed.add(key);
        const clean=(value,depth=0)=>{
          if(value===null||typeof value==='boolean')return value;
          if(typeof value==='number')return Number.isFinite(value)?value:null;
          if(typeof value==='string')return value.slice(0,160);
          if(depth>=4)return undefined;
          if(Array.isArray(value))return value.slice(0,8).map((item)=>clean(item,depth+1))
            .filter((item)=>item!==undefined);
          if(typeof value!=='object')return undefined;
          const output={};
          for(const [key,item] of Object.entries(value))
            if(allowed.has(key)){const safe=clean(item,depth+1);if(safe!==undefined)output[key]=safe;}
          return output;
        };
        const safe=clean(diagnostic);
        const milestones=new Set(['submission_begin','page_settled','draft_insert_done',
          'composer_state_transition','composer_projection_snapshot','send_button_wait_end',
          'pre_click_composer_validation_rejected','pre_click_button_rejected','send_activation',
          'send_click_begin','send_click_returned','submission_confirmation_end',
          'submission_confirmation_evidence',
          'submission_failure_summary','parent_setup_submission_uncertain',
          'parent_setup_user_turn_reconciled',
          'parent_setup_linebreak_normalization_accepted','error']);
        console[milestones.has(diagnostic.step)?'info':'debug'](
          '[chat-orch:trace]',JSON.stringify({...safe,tabId:sender.tab.id}));
        sendResponse({ok:true});
        break;
      }
      case 'browser_page_settled': {
        extensionDiagnostic('debug','readiness.request_received',{tabId:sender.tab?.id,
          documentComplete:sender.tab?.status==='complete'});
        if (sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
            !Number.isSafeInteger(sender.tab?.id) ||
            !siteOfUrl(sender.tab?.url)) {
          sendResponse({ok:false,error:'Page-readiness request did not originate from a supported top-level chat tab'});
          break;
        }
        const timeout = Number.isSafeInteger(msg.timeoutMs)
          ? Math.min(45000,Math.max(1000,msg.timeoutMs)) : 12000;
        const startedAt=Date.now();
        try {
          const ready = await pageSettling.waitForReady(sender.tab.id,timeout);
          extensionDiagnostic('debug','readiness.request_completed',{tabId:sender.tab.id,
            success:true,durationMs:Date.now()-startedAt});
          sendResponse({ok:true,...ready});
        } catch (error) {
          extensionDiagnostic('warn','readiness.request_failed',{tabId:sender.tab.id,
            success:false,durationMs:Date.now()-startedAt,reason:'PAGE_NOT_SETTLED'});
          sendResponse({ok:false,ready:false,error:String(error?.message || error)});
        }
        break;
      }
      case 'task_done': {
        const task = tasks[msg.taskId];
        if (!task || sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
            sender.tab?.id !== task.tabId ||
            (msg.receiptNonce !== task.receiptNonce &&
              !task.previousReceiptNonces?.includes(msg.receiptNonce)) ||
            typeof msg.ok !== 'boolean') {
          sendResponse({ ok: false, error: 'Unverified worker completion source' });
          break;
        }
        if (msg.receiptNonce !== task.receiptNonce) {
          // Late completion from the clarification question, not this resumed
          // turn. ACK it without altering the original task lifecycle.
          sendResponse({ok:true,stale_context_receipt:true});
          break;
        }
        // An authenticated, nonce-matched completion is sufficient to resolve
        // an uncertain submission without submitting the prompt again.
        if (!['running', 'uncertain'].includes(task.status)) {
          if(task.status==='waiting_for_parent_context' ||
              (task.status==='queued' && task.contextRequestedAt)){
            // Clarification is not an answer. The response receipt for the
            // question itself must never become a terminal CHILD_RESULT.
            sendResponse({ok:true,pending_context:true});
            break;
          }
          if (task.status === 'waiting_for_children') {
            // The Child's own answer was already received and is held only
            // behind descendant review. An identical content-script retry
            // acknowledges that receipt without prematurely issuing a
            // terminal CHILD_RESULT or replaying any work.
            const deferred=task.deferredCompletion;
            const matching = (deferred?.status === 'done' && msg.ok === true) ||
              (deferred?.status === 'failed' && msg.ok === false);
            if (!matching) {
              sendResponse({ok:false,error:'Conflicting pending descendant receipt'});
              break;
            }
            sendResponse({ok:true,pending_descendants:true,duplicate:true});
            break;
          }
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
        console.info('[chat-orch:background]', {step:'worker_completion',taskId:msg.taskId,
          tabId:task.tabId,ok:msg.ok,uncertain:msg.uncertain === true,
          notSubmitted:msg.notSubmitted === true});
        if (msg.uncertain === true && msg.ok === false) {
          finishTask(msg.taskId, {status:'uncertain',error:msg.error});
          sendResponse({ok:true,uncertain:true});
          break;
        }
        if(msg.ok===true) {
          // A settled assistant chat turn is not a semantic task completion.
          // Retain only a short UI comparison signature; do not notify the
          // Parent until explicit MCP completion or validated fallback.
          task.uiCandidate={
            signature:String(msg.text||'').replace(/\s+/g,' ').trim().slice(0,140),
            observedAt:Date.now(),
            conversationRoute:safeConversationRoute(sender.tab?.url),
          };
          await saveState();
          sendResponse({ok:true,pending_explicit_completion:true});
          break;
        }
        if(msg.ok===false && msg.notSubmitted!==true) {
          finishTask(msg.taskId,{status:'uncertain',
            error:'Child response unavailable; monitor and reconcile before claiming completion'});
          sendResponse({ok:true,uncertain:true});
          break;
        }
        finishTask(
          msg.taskId,
          msg.ok ? { status: 'done', result: msg.text } : { status: 'failed', error: msg.error }
        );
        if (task.status==='waiting_for_children') {
          sendResponse({ok:true,pending_descendants:true});
          break;
        }
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
        const profile=await chrome.storage.local.get('profileToken');
        sendResponse({
          wsState,
          coordinationMode: privateQueueMode,
          settingsSynced: Boolean(proxySettings),
          settingsRevision: proxySettingsRevision,
          cfg: { serverUrl: cfg.serverUrl, orchestratorTabId: cfg.orchestratorTabId },
          profileTokenConfigured:/^[a-f0-9]{64}$/i.test(profile.profileToken||''),
          workers,
          running: Object.values(tasks).filter((t) => t.status === 'running').length,
        });
        break;
      }
      case 'create_pairing_offer': {
        if (ws?.readyState !== WebSocket.OPEN || wsState !== 'connected')
          throw new Error('Connect the local Proxy before pairing');
        // Fail before marking this tab approved or minting a one-time code.
        const connectorGuidance=requireConnectorRoutingReady();
        // The in-page Yes comes from its own tab; the extension popup has no
        // sender.tab and continues to use the currently selected browser tab.
        const [active] = sender.id===chrome.runtime.id &&
          sender.frameId===0 && Number.isSafeInteger(sender.tab?.id)
          ? [sender.tab] : await chrome.tabs.query({active:true,currentWindow:true});
        if (!active?.id || siteOfUrl(active.url) !== 'chatgpt')
          throw new Error('Select a ChatGPT tab first');
        extensionDiagnostic('info','parent_setup.approval_received',{
          tabId:active.id,site:'chatgpt',phase:'approval'});
        const live = await inspectChatTab(active.id);
        const route=normalizedClosedTabUrl(active.url);
        if(route)workerUrls[active.id]=route;
        if(typeof active.title==='string')tabTitles[active.id]=active.title.slice(0,140);
        if (!live.is_managed_worker) {
          if (msg.approve_parent !== true)
            throw new Error('User approval required before enabling this tab as Parent');
          const priorSetup=parentInitializations[active.id];
          if(priorSetup?.incarnationId===live.incarnation_id)
            throw new Error('Parent setup was already attempted ('+priorSetup.status+
              '). Inspect this conversation before another initialization');
          approvedParents[active.id] = live.incarnation_id;
          delete dismissedParentOffers[active.id];
          parentInitializations[active.id]={
            incarnationId:live.incarnation_id,status:'PENDING',createdAt:Date.now()};
          void pushManagedAgentStatus(active.id);
          void enableManagedAntiFreeze(active.id);
        }
        await saveState();
        const code = crypto.randomUUID();
        const requestId = crypto.randomUUID();
        const acknowledgment = new Promise((resolve,reject) => {
          const timer=setTimeout(() => {
            pairingWaiters.delete(requestId);
            reject(new Error('Pairing offer acknowledgment timed out'));
          },12000);
          pairingWaiters.set(requestId,{resolve,reject,timer});
        });
        ws.send(JSON.stringify({type:'pairing_offer',request_id:requestId,
          code,tab_id:live.tab_id,incarnation_id:live.incarnation_id,
          route_hash:live.route_hash}));
        await acknowledgment;
        extensionDiagnostic('info','parent_setup.pairing_offer_accepted',{
          tabId:active.id,phase:'offered'});
        if (live.is_managed_worker) {
          sendResponse({ok:true,code,tab_id:active.id,role:'child'});
          break;
        }
        const setup=parentInitializations[active.id];
        setup.status='DISPATCHING';
        await saveState();
        extensionDiagnostic('info','parent_setup.dispatch_begin',{
          tabId:active.id,phase:'dispatching'});
        const prompt='<chat_orchestrator_parent_setup>\n'
          +'This is the user-approved Parent Agent conversation. '
          +connectorGuidance+' '
          +'Call the pair_conversation MCP tool from connector "'+
          proxySettings.connectorName+'" once using pairing code '+code+
          ' and a new UUID idempotency_key. Keep the returned agent_credential '
          +'private and supply it in later Chat Orchestrator tool calls; use '
          +'a fresh UUID idempotency_key for each new operation. '
          +'After delegating child tasks, end your current response and stay idle instead of repeatedly polling get_result or task status. The orchestrator delivers completion notifications; review results when notified and yield again if other children are still running. '
          +'This message alone does not authenticate a Parent.\n'
          +'</chat_orchestrator_parent_setup>';
        let sent;
        try {
          const current=await inspectChatTab(active.id);
          if(current.incarnation_id!==live.incarnation_id ||
              current.route_hash!==live.route_hash)
            throw new Error('Parent tab changed after user approval');
          await confirmTabIdle(active.id);
          extensionDiagnostic('info','parent_setup.idle_verified',{
            tabId:active.id,phase:'idle_verified'});
          sent=await tabMessage(active.id,{
            cmd:'submit_parent_initialization',text:prompt,marker:code});
        } catch(error) {
          extensionDiagnostic('warn','parent_setup.dispatch_error',{
            tabId:active.id,phase:'dispatching',
            errorType:error?.name||'Error'});
          sent={ok:false,uncertain:true};
        }
        setup.status=sent?.ok===true && sent.submitted===true
          ? 'SENT':'UNCERTAIN';
        extensionDiagnostic(setup.status==='SENT'?'info':'warn','parent_setup.dispatch_result',{
          tabId:active.id,phase:'completed',status:setup.status,
          replyOk:sent?.ok===true,uncertain:sent?.uncertain===true});
        await saveState();
        sendResponse({ok:true,code,tab_id:active.id,role:'parent',
          initialization_status:setup.status,paired:false});
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