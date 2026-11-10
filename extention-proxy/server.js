// MCP server <-> browser extension bridge.
//
//   Orchestrator chat --(MCP over HTTPS, via tunnel)--> POST /mcp
//   this server       --(WebSocket, localhost)-------> extension service worker (/bridge)
//   extension         --(tabs + content scripts)-----> worker chat tabs

import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { disabledAgentSettings, normalizeAgentSettings, replaceObsoletePromptSettings, composeAgentPrompt } from './agent-settings.mjs';
import { createSessionTabRegistry } from './tab-registry.mjs';
import { normalizeOpenChatTabs, annotateTabPresence } from './tab-presence.mjs';
import { createDiagnostics, classifyDiagnosticError } from './diagnostics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const diagnostics = createDiagnostics({component:'proxy'});

// Profile settings are independent of any proxy or browser-extension secret.
const AGENT_SETTINGS_FILE = path.join(
  process.env.CHAT_ORCH_PROFILE_DIR || __dirname, 'settings.json'
);
let agentSettings = disabledAgentSettings();
let agentSettingsRevision = 0;
const trustedExtensionSockets = new WeakSet();
function reloadAgentSettings() {
  try {
    if (!fs.existsSync(AGENT_SETTINGS_FILE)) {
      agentSettings = normalizeAgentSettings({});
    } else {
      if (fs.statSync(AGENT_SETTINGS_FILE).size > 128000) throw new Error('settings file too large');
      const stored = JSON.parse(fs.readFileSync(AGENT_SETTINGS_FILE, 'utf8'));
      agentSettings = replaceObsoletePromptSettings(stored.agentSettings || {});
    }
  } catch (error) {
    console.error('[settings] invalid profile settings; automation remains disabled:', error.message);
    agentSettings = disabledAgentSettings();
  }
  agentSettingsRevision++;
}
function sendAgentSettings(ws) {
  if (ws?.readyState !== 1 || !trustedExtensionSockets.has(ws)) return;
  ws.send(JSON.stringify({type: 'settings_snapshot', schema: 1,
    revision: agentSettingsRevision, settings: agentSettings}));
}

async function attachProfile(req, _res, next) {
  // HTTP MCP has no trustworthy originating browser tab. Never select a
  // single global manager during discovery or before dispatching a tool.
  // Operations resolve their explicit caller_tab_id and inspect live tabs.
  req.bridgePrincipal = Object.freeze({ mode: 'legacy' });
  return next();
}

// ------------------------------------------- private P0 coordination (inert)
/**
 * Local profile manager context. No MCP token, agent identity or per-role authorization.
 * @typedef {Readonly<{
 *   principalId: string, credentialId: string, workspaceId: string,
 *   projectId: string, orchestratorId: string, parentTaskId: string,
 *   callerTabId: number, connectionGeneration: number,
 *   sessionIncarnationId: string
 * }>} PrincipalContext
 */
/**
 * Server-owned worker scope, never a caller-supplied owner_id or tab_id.
 * @typedef {Readonly<{
 *   ownerPrincipalId: string, workspaceId: string, projectId: string,
 *   orchestratorId: string, parentTaskId: string, ownerTabId: number,
 *   workerTabId: number, connectionGeneration: number,
 *   recipientTabId: number, recipientIncarnationId: string,
 *   recipientGeneration: number, workerIncarnationId: string,
 *   workerGeneration: number
 * }>} PrivateCoordinationScope
 */

// Every MCP caller uses the selected local profile. These contexts correlate
// worker results and ordered queue ACKs, never enforce per-agent credentials.
let privateCoordinationEnabled = false;
const privateCoordinationRequested = process.env.CHAT_ORCH_PRIVATE_COORDINATION === '1';
let privateJournal = null; // Only if the preprovisioned journal passes strict replay.
let stopServerPromise = null; // One serialized graceful stop, including lock release.
const verifiedPrincipalContexts = new WeakSet();
const verifiedCoordinationScopes = new WeakSet();
// Profile queue identity is derived locally. It never represents an individual agent
// or grants a BA/PM/TL role. The browser extension attests the selected manager tab.
const profileManagerIdentities = new Map(); // caller tab -> current connection incarnation
let tabRegistry = null;
let profileSocketGeneration = 0;
function profileCredentialId(tabId) {
  // Stable non-secret identity for the app's local profile data directory.
  const hex = crypto.createHash('sha256').update(path.dirname(AGENT_SETTINGS_FILE) + ':' + tabId).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
function sameProfileManager(a, b) {
  return a?.credentialId === b?.credentialId &&
    a?.callerTabId === b?.callerTabId &&
    a?.browserSessionId === b?.browserSessionId &&
    a?.sessionIncarnationId === b?.sessionIncarnationId &&
    a?.connectionGeneration === b?.connectionGeneration &&
    a?.socketGeneration === b?.socketGeneration;
}
function profilePrincipalFromExtension(a) {
  if (!a || !Number.isSafeInteger(a.tab_id) || a.tab_id <= 0 ||
      !PRIVATE_EVENT_ID.test(a.browser_session_id || '') ||
      !PRIVATE_EVENT_ID.test(a.incarnation_id || '') ||
      !Number.isSafeInteger(a.connection_generation) || a.connection_generation < 1)
    throw new Error('Extension could not attest the configured manager tab');
  const credentialId = profileCredentialId(a.tab_id);
  return Object.freeze({
    mode: 'profile', principalId: credentialId, credentialId,
    workspaceId: 'local-profile', projectId: 'local-profile',
    orchestratorId: 'local-profile', parentTaskId: 'local-profile',
    callerTabId: a.tab_id, browserSessionId: a.browser_session_id,
    sessionIncarnationId: a.incarnation_id,
    connectionGeneration: a.connection_generation,
    socketGeneration: profileSocketGeneration,
  });
}


/** @param {PrincipalContext} principal @param {PrivateCoordinationScope} scope */
// Recheck the browser session/incarnation before acting on an asynchronous
// worker event so stale tab IDs are not accidentally reused.
function currentPrivatePrincipal(principal) {
  return Boolean(principal?.mode === 'profile' && bridgeConnected() &&
    sameProfileManager(profileManagerIdentities.get(principal.callerTabId), principal) &&
    principal.credentialId === profileCredentialId(principal.callerTabId));
}

async function resolveCaller(args = {}, { createRoot = false } = {}) {
  if (!tabRegistry) throw new Error('Proxy tab registry unavailable');
  const tabId = args.caller_tab_id;
  if (!Number.isSafeInteger(tabId) || tabId <= 0) {
    throw new Error('caller_tab_id required: call list_tabs first to identify the calling chat tab');
  }
  const inspection = await callExtension('inspect_tab', { tab_id: tabId }, 10000);
  let record = tabRegistry.get(tabId);
  diagnostics.debug('identity.inspected',{tabId,site:inspection.site,
    registryPresent:Boolean(record)});
  if (!record) {
    if (!createRoot) throw new Error('Unregistered caller: use spawn_worker to establish the root relationship');
    record = await tabRegistry.registerRoot(inspection);
  }
  if (record.incarnationId !== inspection.incarnation_id ||
      record.browserSessionId !== inspection.browser_session_id ||
      record.site !== inspection.site ||
      (record.parentTabId !== null && inspection.is_managed_worker !== true)) {
    const mismatches = [
      record.incarnationId !== inspection.incarnation_id ? 'incarnationId' : null,
      record.browserSessionId !== inspection.browser_session_id ? 'browserSessionId' : null,
      record.site !== inspection.site ? 'site' : null,
      record.parentTabId !== null && inspection.is_managed_worker !== true
        ? 'isManagedWorker' : null,
    ].filter(Boolean);
    for (const mismatchField of mismatches) {
      diagnostics.error('identity.registry_mismatch',{tabId,mismatchField});
    }
    throw new Error('Caller tab session/incarnation changed; manual registry reconciliation required');
  }
  const observed = await callExtension('attest_profile_manager', {tab_id: tabId}, 10000);
  if (observed.tab_id !== inspection.tab_id ||
      observed.incarnation_id !== inspection.incarnation_id ||
      observed.browser_session_id !== inspection.browser_session_id) {
    diagnostics.warn('identity.attestation_mismatch',{tabId});
    throw new Error('Caller tab changed during attestation; retry only after reconciliation');
  }
  diagnostics.debug('identity.attestation_verified',{tabId,site:inspection.site});
  const principal = profilePrincipalFromExtension(observed);
  const old = profileManagerIdentities.get(tabId);
  if (old && !sameProfileManager(old, principal)) {
    activePrivateManagers.delete(old.credentialId);
    privateManagerObservations.delete(old.credentialId);
    armedPrivateDelivery.delete(old.credentialId);
  }
  profileManagerIdentities.set(tabId, principal);
  verifiedPrincipalContexts.add(principal);
  if (privateCoordinationEnabled && privateJournal) {
    // Re-enroll the verified tab after proxy/extension reconnect so its
    // existing durable queue can be inspected. Wake remains explicitly armed.
    activePrivateManagers.set(principal.credentialId,principal);
  }
  return principal;
}

// Local Desktop confirmation only. Do not rewrite or replay FIFO events.
const rootRepairOffers = new Map();
const rootRepairBusy = new Set();
async function inspectRootRepair(tabId, offer = false) {
  if (!Number.isSafeInteger(tabId) || tabId <= 0 || !tabRegistry || !bridgeConnected())
    throw new Error('Connected Proxy and valid tab required');
  const saved = tabRegistry.get(tabId);
  const live = await callExtension('inspect_tab', {tab_id:tabId}, 10000);
  const unresolved = privateJournal?.unresolvedForTab(tabId) ?? [];
  const reasons = [];
  if (!saved || saved.parentTabId !== null || saved.phase !== 'root')
    reasons.push('NOT_REGISTERED_ROOT');
  if (live.is_managed_worker) reasons.push('MANAGED_WORKER');
  if (saved && saved.browserSessionId !== live.browser_session_id)
    reasons.push('BROWSER_SESSION_CHANGED');
  if (saved && saved.site !== live.site) reasons.push('SITE_CHANGED');
  if (tabRegistry.hasChildren(tabId)) reasons.push('ROOT_HAS_DESCENDANTS');
  if (privateCoordinationEnabled && !privateJournal) reasons.push('JOURNAL_UNAVAILABLE');
  if (unresolved.length) reasons.push('UNRESOLVED_FIFO');
  const changed = Boolean(saved && saved.incarnationId !== live.incarnation_id);
  const eligible = reasons.length === 0 && changed;
  const response = {tab_id:tabId,site:live.site,can_reconcile:eligible,
    incarnation_changed:changed,reasons,has_descendants:tabRegistry.hasChildren(tabId),
    unresolved_by_phase:unresolved.reduce((counts,item)=>{
      counts[item.phase]=(counts[item.phase]||0)+1;return counts;
    },{})};
  rootRepairOffers.delete(tabId);
  if (!offer || !eligible) return response;
  const nonce = crypto.randomUUID();
  rootRepairOffers.set(tabId,{nonce,expires:Date.now()+60000,
    oldIncarnation:saved.incarnationId,newIncarnation:live.incarnation_id,
    browserSessionId:live.browser_session_id,site:live.site});
  return {...response,confirmation_nonce:nonce};
}
async function reconcileRootFromDesktop(tabId, nonce) {
  if (!PRIVATE_EVENT_ID.test(nonce || '') || rootRepairBusy.has(tabId))
    throw new Error('Invalid or concurrent root recovery');
  const offer=rootRepairOffers.get(tabId);
  rootRepairOffers.delete(tabId);
  if (!offer || offer.nonce !== nonce || Date.now()>offer.expires)
    throw new Error('Expired or invalid recovery confirmation');
  rootRepairBusy.add(tabId);
  try {
    const saved=tabRegistry.get(tabId);
    const live=await callExtension('inspect_tab',{tab_id:tabId},10000);
    const attested=await callExtension('attest_profile_manager',{tab_id:tabId},10000);
    if (!saved || saved.incarnationId !== offer.oldIncarnation ||
        saved.browserSessionId !== offer.browserSessionId || saved.site !== offer.site ||
        live.incarnation_id !== offer.newIncarnation ||
        attested.incarnation_id !== offer.newIncarnation ||
        live.browser_session_id !== offer.browserSessionId ||
        attested.browser_session_id !== offer.browserSessionId ||
        live.site !== offer.site || live.is_managed_worker ||
        live.tab_id !== tabId || attested.tab_id !== tabId ||
        tabRegistry.hasChildren(tabId) ||
        (privateCoordinationEnabled && !privateJournal) ||
        (privateJournal?.unresolvedForTab(tabId).length ?? 0)>0)
      throw new Error('Root changed or has unresolved events; recovery refused');
    await tabRegistry.reconcileRoot(live,offer.oldIncarnation);
    profileManagerIdentities.delete(tabId);
    const key=profileCredentialId(tabId);
    activePrivateManagers.delete(key);
    armedPrivateDelivery.delete(key);
    privateManagerObservations.delete(key);
    diagnostics.info('identity.root_reconciled',{tabId,site:live.site});
    return {tab_id:tabId,reconciled:true,no_replay:true,no_ack:true};
  } finally { rootRepairBusy.delete(tabId); }
}

function requireDirectChild(callerId, childId) {
  if (!tabRegistry?.directChild(callerId, childId)) {
    throw new Error('Target tab is not a direct child of the supplied caller tab');
  }
}

async function verifyDirectChild(callerId, childId) {
  requireDirectChild(callerId,childId);
  const record = tabRegistry.get(childId);
  const live = await callExtension('inspect_tab',{tab_id:childId},10000);
  if (live.incarnation_id !== record.incarnationId ||
      live.browser_session_id !== record.browserSessionId ||
      live.site !== record.site || live.is_managed_worker !== true) {
    throw new Error('Child tab was replaced, closed or changed incarnation');
  }
}

async function verifyLiveAncestry(tabId) {
  let node = tabRegistry.get(tabId);
  while (node && node.parentTabId !== null) {
    const parent = tabRegistry.get(node.parentTabId);
    if (!parent || parent.incarnationId !== node.parentIncarnationId)
      throw new Error('Orphaned parent tab; new delegation is held for reconciliation');
    const observed = await callExtension('inspect_tab',{tab_id:parent.tabId},10000);
    if (observed.incarnation_id !== parent.incarnationId ||
        observed.browser_session_id !== parent.browserSessionId ||
        observed.site !== parent.site)
      throw new Error('Ancestor tab changed or closed; new delegation is held');
    node = parent;
  }
}

const preparingWorkerTabs = new Set();
// Browser tabs may defer SPA initialization until foregrounded. Serialize
// each prepare -> focus -> confirmed-submit handoff, not the worker's reply.
// Worker models continue generating independently after submission.
const spawnStartupSerial = {tail: Promise.resolve()};
function serializeWorkerSpawn(operation) {
  const next = spawnStartupSerial.tail.then(operation);
  spawnStartupSerial.tail = next.catch(() => {});
  return next;
}
async function spawnAndBindWorker(args, principal) {
  return serializeWorkerSpawn(() => prepareAndStartWorker(args,principal));
}
async function prepareAndStartWorker(args, principal) {
  await verifyLiveAncestry(principal.callerTabId);
  const root = tabRegistry.get(tabRegistry.get(principal.callerTabId)?.rootTabId);
  if (!root || root.parentTabId !== null || root.browserSessionId !== principal.browserSessionId)
    throw new Error('Root browser identity is unavailable for worker grouping');
  const taskText = args.saga_task_id == null ? args.task :
    args.task + '\n\nExternal tracking reference (optional, not an execution identity): Saga task #' + args.saga_task_id;
  const params = {...args, task:taskText,__trustedPrincipal:principal,
    __rootTabId:root.tabId,__rootIncarnationId:root.incarnationId,__defer_start:true,
    prompt_text:composeAgentPrompt(agentSettings,{
      kind:'task',operation:args.operation || 'task',task:taskText})};
  const prepared = await callExtension('spawn_worker',params);
  if (prepared?.prepared !== true || !Number.isSafeInteger(prepared.tab_id) ||
      !PRIVATE_EVENT_ID.test(prepared.incarnation_id || '')) {
    throw new Error('Worker preparation returned no attested tab; reconcile before retrying');
  }
  if (preparingWorkerTabs.has(prepared.tab_id))
    throw new Error('Worker tab already has a pending prepared task; reconcile before retrying');
  preparingWorkerTabs.add(prepared.tab_id);
  try {
    const inspection = await callExtension('inspect_tab',{tab_id:prepared.tab_id});
    if (inspection.incarnation_id !== prepared.incarnation_id)
      throw new Error('Prepared worker incarnation changed');
    const existing = tabRegistry.get(prepared.tab_id);
    if (existing) {
      await verifyDirectChild(principal.callerTabId,prepared.tab_id);
      if (prepared.reused_tab !== true ||
          !['started','reattached'].includes(existing.phase))
        throw new Error('Existing worker phase does not permit automatic reuse');
      await tabRegistry.setPhase(prepared.tab_id,'prepared');
    } else {
      if (prepared.reused_tab === true)
        throw new Error('Unregistered reusable worker requires manual reconciliation');
      await tabRegistry.registerChild(principal.callerTabId,inspection);
    }
    const result = await callExtension('start_prepared_worker',{
      ...params,__defer_start:false,tab_id:prepared.tab_id,
      expected_incarnation_id:prepared.incarnation_id,reused_tab:prepared.reused_tab,
    });
    await tabRegistry.setPhase(prepared.tab_id,'started');
    return {...result,parent_tab_id:principal.callerTabId,
      root_tab_id:tabRegistry.get(prepared.tab_id).rootTabId};
  } catch (error) {
    if (tabRegistry.directChild(principal.callerTabId,prepared.tab_id) &&
        tabRegistry.get(prepared.tab_id)?.phase === 'prepared') {
      await tabRegistry.setPhase(prepared.tab_id,'uncertain').catch(()=>{});
    }
    // A prompt may already have been submitted even if the response vanished.
    // Keep the prepared tab open; no blind second spawn or task replay.
    throw new Error('Prepared worker tab ' + prepared.tab_id +
      ' outcome UNCERTAIN; inspect the tab and registry before retrying: ' + error.message);
  } finally {
    preparingWorkerTabs.delete(prepared.tab_id);
  }
}

function authorizePrivateCoordination(principal, scope) {
  if (!currentPrivatePrincipal(principal)) return false;
  if (!privateCoordinationEnabled ||
      !verifiedPrincipalContexts.has(principal) ||
      !verifiedCoordinationScopes.has(scope)) return false;
  return Object.isFrozen(principal) && Object.isFrozen(scope) &&
    Boolean(principal.principalId && principal.credentialId &&
      principal.workspaceId && principal.projectId &&
      principal.orchestratorId && principal.parentTaskId) &&
    Number.isSafeInteger(principal.callerTabId) && principal.callerTabId >= 0 &&
    Number.isSafeInteger(principal.connectionGeneration) &&
    principal.connectionGeneration > 0 &&
    typeof principal.sessionIncarnationId === 'string' &&
    PRIVATE_EVENT_ID.test(principal.sessionIncarnationId) &&
    Number.isSafeInteger(scope.workerTabId) && scope.workerTabId >= 0 &&
    typeof scope.workerIncarnationId === 'string' &&
    PRIVATE_EVENT_ID.test(scope.workerIncarnationId) &&
    Number.isSafeInteger(scope.workerGeneration) && scope.workerGeneration > 0 &&
    Number.isSafeInteger(scope.recipientTabId) && scope.recipientTabId >= 0 &&
    typeof scope.recipientIncarnationId === 'string' &&
    PRIVATE_EVENT_ID.test(scope.recipientIncarnationId) &&
    Number.isSafeInteger(scope.recipientGeneration) && scope.recipientGeneration > 0 &&
    scope.recipientTabId === scope.ownerTabId &&
    scope.recipientTabId === principal.callerTabId &&
    scope.recipientIncarnationId === principal.sessionIncarnationId &&
    scope.recipientGeneration === principal.connectionGeneration &&
    principal.principalId === scope.ownerPrincipalId &&
    principal.workspaceId === scope.workspaceId &&
    principal.projectId === scope.projectId &&
    principal.orchestratorId === scope.orchestratorId &&
    principal.parentTaskId === scope.parentTaskId &&
    principal.callerTabId === scope.ownerTabId &&
    principal.connectionGeneration === scope.connectionGeneration;
}

// Profile context is derived from the connected extension and its selected manager tab.
async function verifiedPrivateWorkerScope(principal, workerTabId) {
  if (!privateCoordinationEnabled || !verifiedPrincipalContexts.has(principal)) {
    throw new Error('Private queue requires a connected profile manager');
  }
  const tabs = await callExtension('list_tabs', { __trustedPrincipal: principal });
  const worker = tabs.find((tab) => tab.tab_id === workerTabId && tab.role === 'worker');
  await verifyDirectChild(principal.callerTabId,workerTabId);
  if (!worker || typeof worker.incarnation_id !== 'string' ||
      !PRIVATE_EVENT_ID.test(worker.incarnation_id)) {
    throw new Error('Worker tab has no verified creation incarnation');
  }
  const scope = Object.freeze({
    ownerPrincipalId: principal.principalId,
    workspaceId: principal.workspaceId, projectId: principal.projectId,
    orchestratorId: principal.orchestratorId, parentTaskId: principal.parentTaskId,
    ownerTabId: principal.callerTabId, workerTabId,
    connectionGeneration: principal.connectionGeneration,
    recipientTabId: principal.callerTabId,
    recipientIncarnationId: principal.sessionIncarnationId,
    recipientGeneration: principal.connectionGeneration,
    workerIncarnationId: worker.incarnation_id, workerGeneration: 1,
  });
  verifiedCoordinationScopes.add(scope);
  return scope;
}

// ---------------------------------------------------- private event journal
// Uncalled until a separately approved private coordination integration.
const PRIVATE_FRAME_LIMIT = 64 * 1024;
const PRIVATE_JOURNAL_LIMIT = 32 * 1024 * 1024;
const PRIVATE_EVENT_LIMIT = 4096; // Hard cap, including historical ACKs/retries; never evict.
const PRIVATE_DIGEST_BYTES = 32;
const PRIVATE_EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PRIVATE_SCOPE_FIELDS = [
  'principalId', 'workspaceId', 'projectId', 'orchestratorId', 'parentTaskId',
];
const PRIVATE_QUEUE_PHASES = new Set([
  'QUEUED', 'LEASED', 'DISPATCHING', 'DELIVERED',
  'PROCESSED', 'SAGA_CONFIRMED', 'UNCERTAIN',
]);
const PRIVATE_QUEUE_ENTRY_TYPES = new Set(['CHILD_RESULT', 'STATUS_REQUEST', 'CHILD_TAB_LOST']);

// This identity is derived only from a verified PrincipalContext, never owner_id
// in an MCP request. Length-prefixing prevents composite-key collisions.
function privateScopeKey(owner) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) {
    throw new Error('Private journal requires trusted owner scope');
  }
  return PRIVATE_SCOPE_FIELDS.map((field) => {
    const value = owner[field];
    if (typeof value !== 'string' || !value.trim() || value.length > 256) {
      throw new Error('Invalid private journal owner scope');
    }
    return value.length + ':' + value;
  }).join('|');
}

function privateProfileRetryKey(owner, idempotencyKey) {
  if (typeof idempotencyKey !== 'string' || !PRIVATE_EVENT_ID.test(idempotencyKey)) {
    throw new Error('Private journal requires a stable UUID retry key');
  }
  return privateScopeKey(owner) + '#' + idempotencyKey.toLowerCase();
}

// These identities are server-owned snapshots of verified enrollment scopes.
// A numeric tab ID by itself is never enough to authorize delivery or replay.
function privateRecipientKey(recipient) {
  if (!recipient || recipient.type !== 'manager_tab' ||
      !Number.isSafeInteger(recipient.tabId) || recipient.tabId < 0 ||
      typeof recipient.incarnationId !== 'string' ||
      !PRIVATE_EVENT_ID.test(recipient.incarnationId) ||
      !Number.isSafeInteger(recipient.connectionGeneration) ||
      recipient.connectionGeneration < 1) {
    throw new Error('Invalid private recipient session');
  }
  return 'manager_tab#' + recipient.tabId + '#' +
    recipient.incarnationId.toLowerCase() + '#' + recipient.connectionGeneration;
}

function privateSourceKey(source) {
  if (!source || !['worker_tab', 'manager_tab'].includes(source.type) ||
      !Number.isSafeInteger(source.tabId) || source.tabId < 0 ||
      typeof source.incarnationId !== 'string' ||
      !PRIVATE_EVENT_ID.test(source.incarnationId) ||
      !Number.isSafeInteger(source.connectionGeneration) ||
      source.connectionGeneration < 1) {
    throw new Error('Invalid private event source session');
  }
  return source.type + '#' + source.tabId + '#' +
    source.incarnationId.toLowerCase() + '#' + source.connectionGeneration;
}

// Deterministic view of unresolved predecessor generations. The audit
// boundary never moves, replays, acknowledges or mutates these events.
function privateRecipientPredecessors(reduced, recipient, ownerKey) {
  const currentKey = privateRecipientKey(recipient);
  const older = reduced.fifo.map((key) => reduced.byRef.get(key))
    .filter((item) => item.ownerKey === ownerKey &&
      item.recipientTabId === recipient.tabId &&
      item.recipientKey !== currentKey &&
      !['PROCESSED', 'SAGA_CONFIRMED'].includes(item.phase));
  const snapshot = older.map((item) => [
    item.recipientKey,item.ref,item.previousPhase ?? item.phase,item.lastSeq,
  ]);
  const snapshotSha256 = crypto.createHash('sha256')
    .update(JSON.stringify(snapshot)).digest('hex');
  return {currentKey, older, snapshotSha256};
}

function applyPrivateQueueStep(reduced, step) {
  if (step.quarantine) {
    reduced.quarantinedRecipients.set(step.quarantine.currentKey,
      new Set(step.quarantine.priorKeys));
    return;
  }
  reduced.byRef.set(step.key,step.next);
  if (step.queued) reduced.fifo.push(step.key);
}

function privateQueueStep(reduced, event) {
  const ownerKey = privateScopeKey(event.ownerScope);
  const recipientKey = privateRecipientKey(event.recipient);
  const sourceKey = privateSourceKey(event.source);
  const payload = event.payload;
  if (event.kind === 'recipient.reconcile') {
    // This is an explicit and durable incarnation boundary, not a
    // processing ACK or permission to replay any historical message.
    if (!payload || event.ref !== event.id || sourceKey !== recipientKey ||
        payload.phase !== 'QUARANTINE_PREDECESSORS' ||
        Object.keys(payload).sort().join(',') !==
          'confirmation,phase,priorKeys,reason,snapshotSha256' ||
        payload.confirmation !== 'QUARANTINE_UNPROCESSED_EVENTS' ||
        typeof payload.reason !== 'string' || payload.reason.trim().length < 10 ||
        payload.reason.length > 512 ||
        typeof payload.snapshotSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(payload.snapshotSha256) ||
        !Array.isArray(payload.priorKeys)) {
      throw new Error('Invalid explicit predecessor reconciliation record');
    }
    const predecessors = privateRecipientPredecessors(reduced, event.recipient, ownerKey);
    const priorKeys = [...new Set(predecessors.older.map((item) => item.recipientKey))].sort();
    if (!priorKeys.length ||
        reduced.quarantinedRecipients.has(ownerKey + '#' + recipientKey) ||
        payload.snapshotSha256 !== predecessors.snapshotSha256 ||
        JSON.stringify(payload.priorKeys) !== JSON.stringify(priorKeys)) {
      throw new Error('Historical recipient snapshot changed; inspect events before reconciling');
    }
    return {quarantine:{currentKey:ownerKey + '#' + recipientKey,priorKeys}};
  }
  if (event.kind !== 'queue.transition' || !PRIVATE_EVENT_ID.test(event.ref) ||
      typeof event.recordedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.recordedAt) ||
      !Number.isFinite(Date.parse(event.recordedAt)) ||
      !payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !PRIVATE_QUEUE_PHASES.has(payload.phase) ||
      !Number.isSafeInteger(payload.leaseGeneration) || payload.leaseGeneration < 0) {
    throw new Error('Invalid private queue event metadata');
  }
  const phase = payload.phase;
  const ref = event.ref;
  const key = ownerKey + '#' + ref.toLowerCase();
  const prior = reduced.byRef.get(key);
  const allowedFields = new Set([
    'phase', 'ref', 'entryType', 'leaseGeneration', 'leaseNonce', 'data', 'ack', 'saga',
  ]);
  if (Object.keys(payload).some((field) => !allowedFields.has(field)) ||
      (phase !== 'QUEUED' &&
        (payload.ref !== ref || Object.hasOwn(payload, 'data') ||
         Object.hasOwn(payload, 'entryType')))) {
    throw new Error('Invalid private queue transition fields');
  }
  // Processing is an explicit manager assertion, not a proof of LLM cognition.
  // Saga confirmation needs independent board readback and remains blocked.
  if (phase === 'SAGA_CONFIRMED') {
    const proof = payload.saga;
    if (!prior || prior.phase !== 'PROCESSED' ||
        event.source.type !== 'worker_tab' || !proof ||
        Object.keys(proof).sort().join(',') !==
          'eventRef,noteSha256,principalId,readbackAt,sagaNoteId,sagaSubtaskId,sagaTaskId,workerTabId' ||
        proof.eventRef !== ref ||
        proof.principalId !== event.ownerScope.principalId ||
        proof.workerTabId !== event.source.tabId ||
        !Number.isSafeInteger(proof.sagaTaskId) || proof.sagaTaskId <= 0 ||
        !(proof.sagaSubtaskId === null ||
          (Number.isSafeInteger(proof.sagaSubtaskId) && proof.sagaSubtaskId > 0)) ||
        !Number.isSafeInteger(proof.sagaNoteId) || proof.sagaNoteId <= 0 ||
        !/^[a-f0-9]{64}$/.test(proof.noteSha256) ||
        !Number.isFinite(Date.parse(proof.readbackAt))) {
      throw new Error('Saga confirmation requires independently verified board readback proof');
    }
  } else if (Object.hasOwn(payload, 'saga')) {
    throw new Error('Unexpected Saga proof on non-confirmation transition');
  }
  if (phase === 'PROCESSED') {
    const ack = payload.ack;
    if (!prior || prior.phase !== 'DELIVERED' || !ack ||
        Object.keys(ack).sort().join(',') !== 'acknowledgedAt,batchId,eventRef,kind,principalId' ||
        ack.kind !== 'explicit_manager_ack' || ack.eventRef !== ref ||
        ack.principalId !== event.ownerScope.principalId ||
        !PRIVATE_EVENT_ID.test(ack.batchId) ||
        typeof ack.acknowledgedAt !== 'string' ||
        !Number.isFinite(Date.parse(ack.acknowledgedAt))) {
      throw new Error('Explicit manager processing ACK is required after delivery');
    }
  } else if (Object.hasOwn(payload, 'ack')) {
    throw new Error('Unexpected manager ACK on non-processed transition');
  }
  if (phase === 'QUEUED') {
    if (prior || ref !== event.id || Object.hasOwn(payload, 'ref') ||
        !PRIVATE_QUEUE_ENTRY_TYPES.has(payload.entryType) ||
        (payload.entryType === 'STATUS_REQUEST'
          ? sourceKey !== recipientKey : event.source.type !== 'worker_tab') ||
        payload.leaseGeneration !== 0 || payload.leaseNonce !== null) {
      throw new Error('Invalid or duplicate private queue enrollment');
    }
    // Tab reuse or a new manager generation cannot silently supersede an
    // unresolved previous incarnation of that numeric recipient tab.
    const staleIncarnation = reduced.fifo.some((itemKey) => {
      const item = reduced.byRef.get(itemKey);
      return item.ownerKey === ownerKey &&
        item.recipientTabId === event.recipient.tabId &&
        item.recipientKey !== recipientKey &&
        !reduced.quarantinedRecipients.get(ownerKey + '#' + recipientKey)?.has(item.recipientKey) &&
        item.phase !== 'PROCESSED' && item.phase !== 'SAGA_CONFIRMED';
    });
    if (staleIncarnation) throw new Error('Private recipient incarnation requires reconciliation');
  } else {
    if (!prior || prior.recipientKey !== recipientKey || prior.sourceKey !== sourceKey) {
      throw new Error('Private queue transition references stale recipient/source incarnation');
    }
    if (prior.recovered) {
      throw new Error('Recovered private lease/dispatch requires explicit reconciliation');
    }
    if (phase === 'LEASED') {
      // Single-flight barrier for CHILD_RESULT and STATUS_REQUEST alike:
      // QUEUED, LEASED, DISPATCHING, DELIVERED and UNCERTAIN all block
      // later leases for this exact recipient incarnation.
      // A single wake batch leases a contiguous unresolved prefix. Every
      // preceding unprocessed item must already be leased with this exact
      // nonce; DELIVERED/UNCERTAIN from an earlier batch block overtaking.
      const earlier = reduced.fifo.slice(0, reduced.fifo.indexOf(key))
        .map((itemKey) => reduced.byRef.get(itemKey))
        .filter((item) => item.recipientKey === recipientKey &&
          item.phase !== 'PROCESSED' && item.phase !== 'SAGA_CONFIRMED');
      const sameBatch = earlier.every((item) =>
        item.phase === 'LEASED' && item.leaseNonce === payload.leaseNonce);
      if (!sameBatch || prior.phase !== 'QUEUED' ||
          payload.leaseGeneration !== prior.leaseGeneration + 1 ||
          typeof payload.leaseNonce !== 'string' ||
          !PRIVATE_EVENT_ID.test(payload.leaseNonce)) {
        throw new Error('Private queue lease violates recipient FIFO/generation/nonce');
      }
    } else if (!(
      (phase === 'DISPATCHING' && prior.phase === 'LEASED') ||
      (phase === 'DELIVERED' && prior.phase === 'DISPATCHING') ||
      (phase === 'PROCESSED' && prior.phase === 'DELIVERED') ||
      (phase === 'SAGA_CONFIRMED' && prior.phase === 'PROCESSED') ||
      (phase === 'UNCERTAIN' && (prior.phase === 'DISPATCHING' || prior.phase === 'DELIVERED'))
    ) || payload.leaseGeneration !== prior.leaseGeneration ||
        payload.leaseNonce !== prior.leaseNonce) {
      throw new Error('Private queue transition or lease identity mismatch');
    }
  }
  return {
    key, queued: phase === 'QUEUED',
    next: Object.freeze({
      ownerKey, ref, phase, entryType: prior?.entryType ?? payload.entryType,
      recipientKey, recipientTabId: event.recipient.tabId,
      recipientIncarnationId: event.recipient.incarnationId,
      recipientGeneration: event.recipient.connectionGeneration,
      sourceKey, firstSeq: prior?.firstSeq ?? event.seq,
      lastSeq: event.seq, leaseGeneration: payload.leaseGeneration,
      leaseNonce: payload.leaseNonce,
    }),
  };
}

// Pure replay-derived state: never sends chat messages, ACKs, Saga writes or closes tabs.
function reducePrivateQueueEvents(events, recovering = false) {
  if (!Array.isArray(events) || events.length > PRIVATE_EVENT_LIMIT) {
    throw new Error('Private queue exceeds the record-count limit');
  }
  const reduced = {byRef:new Map(),fifo:[],quarantinedRecipients:new Map()};
  let expectedSeq = 0;
  for (const event of events) {
    if (event.seq !== ++expectedSeq) throw new Error('Private queue sequence gap');
    const step = privateQueueStep(reduced, event);
    applyPrivateQueueStep(reduced, step);
    if (reduced.byRef.size > PRIVATE_EVENT_LIMIT ||
        reduced.fifo.length > PRIVATE_EVENT_LIMIT) {
      throw new Error('Private queue in-memory state exceeds the limit');
    }
  }
  if (recovering) {
    // Pure diagnostic classification: no lease release, replay or side effects.
    for (const [key, item] of reduced.byRef) {
      if (item.phase === 'LEASED') {
        reduced.byRef.set(key, Object.freeze({
          ...item, recovered: true, recoveryClass: 'STALE_LEASE_OWNER_UNVERIFIED',
        }));
      } else if (item.phase === 'DISPATCHING' || item.phase === 'DELIVERED') {
        reduced.byRef.set(key, Object.freeze({
          ...item, phase: 'UNCERTAIN', previousPhase: item.phase,
          recovered: true, recoveryClass: 'DISPATCH_CONSUMER_ACK_UNVERIFIED',
        }));
      } else if (item.phase === 'UNCERTAIN') {
        reduced.byRef.set(key, Object.freeze({
          ...item, recovered: true, recoveryClass: 'PREEXISTING_UNCERTAIN',
        }));
      }
    }
  }
  return reduced;
}

// Local desktop diagnostics across every durable scope, including managers not
// yet re-paired after restart. No event contents, credentials or owner identities.
function privateQueueDiagnosticCounts(reduced) {
  const phases = Object.fromEntries([...PRIVATE_QUEUE_PHASES].map((phase) => [phase, 0]));
  for (const item of reduced.byRef.values()) phases[item.phase] += 1;
  const pending = phases.QUEUED + phases.LEASED + phases.DISPATCHING +
    phases.DELIVERED + phases.UNCERTAIN;
  return Object.freeze({ phases: Object.freeze(phases), pending });
}

function privateJournalFrame(event) {
  const data = Buffer.from(JSON.stringify(event), 'utf8');
  if (!data.length || data.length > PRIVATE_FRAME_LIMIT) {
    throw new Error('Private journal record exceeds the size limit');
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const digest = crypto.createHash('sha256').update(header).update(data).digest();
  return Buffer.concat([header, data, digest]);
}

function replayPrivateJournal(bytes) {
  const events = [];
  const ids = new Set();
  const keys = new Set();
  let offset = 0;
  const unreconciled = (reason) => ({
    events, validPrefixBytes: offset,
    tail: Object.freeze({
      reason, offset, length: bytes.length - offset,
      sha256: crypto.createHash('sha256').update(bytes.subarray(offset)).digest('hex'),
    }),
  });

  while (offset < bytes.length) {
    if (events.length >= PRIVATE_EVENT_LIMIT) return unreconciled('EVENT_COUNT_LIMIT');
    if (bytes.length - offset < 4) return unreconciled('INCOMPLETE_HEADER');
    const length = bytes.readUInt32BE(offset);
    if (!length || length > PRIVATE_FRAME_LIMIT) return unreconciled('INVALID_LENGTH');
    const end = offset + 4 + length + PRIVATE_DIGEST_BYTES;
    if (end > bytes.length) return unreconciled('INCOMPLETE_FRAME');
    const digest = crypto.createHash('sha256')
      .update(bytes.subarray(offset, offset + 4 + length)).digest();
    if (!crypto.timingSafeEqual(digest, bytes.subarray(end - PRIVATE_DIGEST_BYTES, end))) {
      return unreconciled('CHECKSUM_MISMATCH');
    }
    let event;
    try {
      event = JSON.parse(bytes.toString('utf8', offset + 4, end - PRIVATE_DIGEST_BYTES));
    } catch {
      return unreconciled('INVALID_JSON');
    }
    if (!event || Array.isArray(event) || event.version !== 4 ||
        event.seq !== events.length + 1 || typeof event.id !== 'string' ||
        !PRIVATE_EVENT_ID.test(event.id) ||
        typeof event.idempotencyKey !== 'string' ||
        !PRIVATE_EVENT_ID.test(event.idempotencyKey) ||
        typeof event.kind !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(event.kind) ||
        !Object.hasOwn(event, 'payload')) return unreconciled('INVALID_EVENT');
    let retryKey;
    try {
      retryKey = privateProfileRetryKey(event.ownerScope, event.idempotencyKey);
      privateRecipientKey(event.recipient);
    } catch { return unreconciled('INVALID_OWNER_OR_RECIPIENT'); }
    if (ids.has(event.id)) return unreconciled('DUPLICATE_EVENT_ID');
    if (keys.has(retryKey)) return unreconciled('DUPLICATE_SCOPED_IDEMPOTENCY_KEY');
    ids.add(event.id);
    keys.add(retryKey);
    events.push(Object.freeze(event));
    offset = end;
  }
  return { events, validPrefixBytes: offset, tail: null };
}

async function openPrivateEventJournal() {
  if (!privateCoordinationEnabled) throw new Error('Private coordination is disabled');
  // The journal belongs to this app profile and never depends on a token file.
  const profileDir = process.env.CHAT_ORCH_PROFILE_DIR;
  if (!profileDir || !path.isAbsolute(profileDir))
    throw new Error('Private journal requires the desktop profile directory');
  const journalPath = path.join(profileDir, 'coordination.events.journal');
  const lockPath = journalPath + '.lock';
  let lock;
  let file;
  try {
    // No automatic stale-lock recovery: owner liveness needs independent proof.
    try {
      lock = await fs.promises.open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') {
        const blocked = new Error('Private journal owner lock exists; verify ownership before recovery');
        blocked.code = 'PRIVATE_JOURNAL_OWNER_UNKNOWN';
        throw blocked;
      }
      throw error;
    }
    // File must be durably provisioned separately. O_APPEND without O_CREAT
    // prevents an unverified new directory entry from receiving a durable ACK.
    file = await fs.promises.open(journalPath, fs.constants.O_RDWR | fs.constants.O_APPEND);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > PRIVATE_JOURNAL_LIMIT) {
      throw new Error('Private journal is not a bounded regular file');
    }
    const bytes = await file.readFile();
    if (bytes.length !== stat.size) throw new Error('Private journal size changed during replay');
    const scan = replayPrivateJournal(bytes);
    if (scan.tail) {
      const blocked = new Error('Private journal tail requires explicit reconciliation: ' + scan.tail.reason);
      blocked.code = 'PRIVATE_JOURNAL_RECONCILIATION_REQUIRED';
      blocked.recovery = Object.freeze({
        classification: scan.tail.reason === 'EVENT_COUNT_LIMIT'
          ? 'RESOURCE_LIMIT_RECONCILIATION'
          : 'CORRUPT_OR_INCOMPLETE_TAIL',
        validation: 'FRAME_AND_BASIC_SCHEMA_ONLY',
        requiresManualReconciliation: true,
        validatedPrefixEvents: scan.events.length,
        validPrefixBytes: scan.validPrefixBytes,
        ...scan.tail,
      });
      throw blocked; // Preserve every byte, including the untrusted tail.
    }
    const events = scan.events;
    let queueState;
    try { queueState = reducePrivateQueueEvents(events, true); }
    catch (cause) {
      const blocked = new Error('Private queue history requires explicit reconciliation');
      blocked.code = 'PRIVATE_JOURNAL_RECONCILIATION_REQUIRED';
      blocked.cause = cause;
      throw blocked;
    }
    const byKey = new Map(events.map((event) => [
      privateProfileRetryKey(event.ownerScope, event.idempotencyKey), event,
    ]));
    let size = bytes.length;
    let sequence = events.length;
    let serial = Promise.resolve();
    let poisoned = false;
    let closePromise;

    // The future trusted producer must retain this UUID key across retries.
    // The key correlates one logical event; it grants no caller authority.
    const append = (principal, scope, kind, payload, idempotencyKey) => {
      if (!authorizePrivateCoordination(principal, scope)) {
        return Promise.reject(new Error('Private journal needs the matching local-profile manager'));
      }
      if (closePromise) return Promise.reject(new Error('Private journal is closing'));
      const operation = serial.then(async () => {
        if (!authorizePrivateCoordination(principal, scope)) {
          throw new Error('Private journal owner authorization expired');
        }
        if (poisoned) throw new Error('Private journal write failure requires reconciliation');
        if (typeof kind !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(kind) ||
            payload === undefined || typeof payload === 'function' ||
            typeof payload === 'symbol' || typeof idempotencyKey !== 'string' ||
            !PRIVATE_EVENT_ID.test(idempotencyKey)) {
          throw new Error('Invalid private journal event input');
        }
        const ownerScope = Object.freeze(Object.fromEntries(
          PRIVATE_SCOPE_FIELDS.map((field) => [field, principal[field]])
        ));
        const retryKey = privateProfileRetryKey(ownerScope, idempotencyKey);
        const existing = byKey.get(retryKey);
        const recipient = Object.freeze({
          type: 'manager_tab', tabId: scope.recipientTabId,
          incarnationId: scope.recipientIncarnationId,
          connectionGeneration: scope.recipientGeneration,
        });
        if (existing) {
          if (privateRecipientKey(existing.recipient) !== privateRecipientKey(recipient)) {
            const stale = new Error('Private retry targets a different recipient incarnation');
            stale.code = 'PRIVATE_JOURNAL_STALE_RECIPIENT';
            throw stale;
          }
          const expectedSource = existing.source.type === 'manager_tab'
            ? recipient
            : {
              type: 'worker_tab', tabId: scope.workerTabId,
              incarnationId: scope.workerIncarnationId,
              connectionGeneration: scope.workerGeneration,
            };
          if (privateSourceKey(existing.source) !== privateSourceKey(expectedSource)) {
            const stale = new Error('Private retry targets a different source incarnation');
            stale.code = 'PRIVATE_JOURNAL_STALE_SOURCE';
            throw stale;
          }
          if (existing.kind !== kind ||
              JSON.stringify(existing.payload) !== JSON.stringify(payload)) {
            const conflict = new Error('Private journal idempotency key conflicts with existing event');
            conflict.code = 'PRIVATE_JOURNAL_IDEMPOTENCY_CONFLICT';
            throw conflict;
          }
          return structuredClone(existing);
        }
        // Retain the entire FIFO and retry history. Never silently evict events
        // to make room; a future authorized retention protocol is required.
        if (events.length >= PRIVATE_EVENT_LIMIT || byKey.size >= PRIVATE_EVENT_LIMIT ||
            queueState.fifo.length > PRIVATE_EVENT_LIMIT ||
            queueState.byRef.size > PRIVATE_EVENT_LIMIT) {
          const full = new Error('Private queue reached the event-count limit');
          full.code = 'PRIVATE_JOURNAL_RESOURCE_LIMIT';
          throw full;
        }
        const id = crypto.randomUUID();
        const ref = kind === 'recipient.reconcile' || payload?.phase === 'QUEUED'
          ? id : payload?.ref;
        const prior = queueState.byRef.get(
          privateScopeKey(ownerScope) + '#' + String(ref).toLowerCase()
        );
        const entryType = payload?.phase === 'QUEUED' ? payload?.entryType : prior?.entryType;
        // Status is modeled as a manager-originated ordered barrier, but no
        // status ingress or manager delivery path is registered.
        const source = kind === 'recipient.reconcile' || entryType === 'STATUS_REQUEST'
          ? Object.freeze({
            type: 'manager_tab', tabId: scope.recipientTabId,
            incarnationId: scope.recipientIncarnationId,
            connectionGeneration: scope.recipientGeneration,
          })
          : Object.freeze({
            type: 'worker_tab', tabId: scope.workerTabId,
            incarnationId: scope.workerIncarnationId,
            connectionGeneration: scope.workerGeneration,
          });
        const record = {
          version: 4, seq: sequence + 1, id, idempotencyKey,
          ownerScope, source, recipient, ref,
          recordedAt: new Date().toISOString(), kind, payload,
        };
        const step = privateQueueStep(queueState, record);
        const frame = privateJournalFrame(record);
        if (size + frame.length > PRIVATE_JOURNAL_LIMIT) {
          throw new Error('Private journal reached the size limit');
        }
        try {
          if ((await file.stat()).size !== size) throw new Error('Private journal changed externally');
          await file.writeFile(frame);
          await file.sync(); // Only a successful sync can acknowledge durable receipt.
        } catch (error) {
          poisoned = true;
          const uncertain = new Error('Private journal persistence UNCERTAIN; reconcile key before retry');
          uncertain.code = 'PRIVATE_JOURNAL_UNCERTAIN';
          uncertain.idempotencyKey = idempotencyKey;
          uncertain.cause = error;
          throw uncertain; // Never append another event over an uncertain tail.
        }
        size += frame.length;
        sequence = record.seq;
        const stored = Object.freeze(JSON.parse(
          frame.subarray(4, frame.length - PRIVATE_DIGEST_BYTES).toString('utf8')
        ));
        events.push(stored);
        byKey.set(retryKey, stored);
        applyPrivateQueueStep(queueState, step);
        return structuredClone(stored);
      });
      serial = operation.catch(() => {});
      return operation;
    };

    return Object.freeze({
      replay: (principal, scope) => {
        if (!authorizePrivateCoordination(principal, scope)) {
          throw new Error('Private journal replay requires the same local profile');
        }
        const ownerKey = privateScopeKey(principal);
        const recipientKey = privateRecipientKey({
          type: 'manager_tab', tabId: scope.recipientTabId,
          incarnationId: scope.recipientIncarnationId,
          connectionGeneration: scope.recipientGeneration,
        });
        return structuredClone(events.filter((event) =>
          privateScopeKey(event.ownerScope) === ownerKey &&
          privateRecipientKey(event.recipient) === recipientKey));
      },
      queueState: (principal, scope) => {
        if (!authorizePrivateCoordination(principal, scope)) {
          throw new Error('Private queue state requires the same local profile');
        }
        const ownerKey = privateScopeKey(principal);
        const recipientKey = privateRecipientKey({
          type: 'manager_tab', tabId: scope.recipientTabId,
          incarnationId: scope.recipientIncarnationId,
          connectionGeneration: scope.recipientGeneration,
        });
        return structuredClone(queueState.fifo
          .map((key) => queueState.byRef.get(key))
          .filter((item) => item.ownerKey === ownerKey &&
            item.recipientKey === recipientKey));
      },
      recoveryDiagnostics: (principal, scope) => {
        if (!authorizePrivateCoordination(principal, scope)) {
          throw new Error('Private recovery diagnostics require the same local profile');
        }
        const ownerKey = privateScopeKey(principal);
        const recipientKey = privateRecipientKey({
          type: 'manager_tab', tabId: scope.recipientTabId,
          incarnationId: scope.recipientIncarnationId,
          connectionGeneration: scope.recipientGeneration,
        });
        const items = queueState.fifo
          .map((key) => queueState.byRef.get(key))
          .filter((item) => item.ownerKey === ownerKey &&
            item.recipientKey === recipientKey && item.recovered)
          .map((item) => ({
            ref: item.ref, entryType: item.entryType,
            phase: item.phase, priorPhase: item.previousPhase ?? null,
            recoveryClass: item.recoveryClass,
            leaseGeneration: item.leaseGeneration,
            recipientGeneration: item.recipientGeneration,
          }));
        return structuredClone({
          classification: 'READ_ONLY_RECONCILIATION_REQUIRED',
          noAutomaticReplay: true, journalTail: null,
          items,
        });
      },
      incarnationConflicts: (principal, scope) => {
        if (!authorizePrivateCoordination(principal, scope)) {
          throw new Error('Private incarnation diagnostics require the same local profile');
        }
        const ownerKey = privateScopeKey(principal);
        const recipient = {
          type:'manager_tab',tabId:scope.recipientTabId,
          incarnationId:scope.recipientIncarnationId,
          connectionGeneration:scope.recipientGeneration,
        };
        const {currentKey,older,snapshotSha256} =
          privateRecipientPredecessors(queueState,recipient,ownerKey);
        const quarantinedKeys = queueState.quarantinedRecipients.get(ownerKey + '#' + currentKey);
        return structuredClone({
          classification: older.length
            ? quarantinedKeys ? 'HISTORICAL_EVENTS_QUARANTINED' : 'RECONCILIATION_REQUIRED'
            : 'CLEAR',
          recipient_tab_id:scope.recipientTabId,
          unresolved_event_count:older.length,
          conflicting_generations:new Set(older.map((item)=>item.recipientKey)).size,
          snapshot_sha256:snapshotSha256,
          historical_events_quarantined:Boolean(quarantinedKeys),
          automatic_replay_allowed:false,
          events:older.map((item)=>({
            event_id:item.ref,phase:item.phase,entry_type:item.entryType,
            recipient_incarnation_id:item.recipientIncarnationId,
            recipient_generation:item.recipientGeneration,
            lease_generation:item.leaseGeneration,
            quarantined:Boolean(quarantinedKeys?.has(item.recipientKey)),
          })),
        });
      },
      predecessorEvent: (principal,scope,eventId) => {
        if (!authorizePrivateCoordination(principal,scope) ||
            !PRIVATE_EVENT_ID.test(eventId)) {
          throw new Error('Historical event inspection requires an authorized manager and event ID');
        }
        const ownerKey = privateScopeKey(principal);
        const currentKey = privateRecipientKey({
          type:'manager_tab',tabId:scope.recipientTabId,
          incarnationId:scope.recipientIncarnationId,
          connectionGeneration:scope.recipientGeneration,
        });
        const event = events.find((record)=>
          record.id===eventId && record.kind==='queue.transition' &&
          record.payload.phase==='QUEUED' &&
          privateScopeKey(record.ownerScope)===ownerKey &&
          record.recipient.tabId===scope.recipientTabId &&
          privateRecipientKey(record.recipient)!==currentKey);
        if (!event) throw new Error('No historical event in this recipient scope');
        const data=event.payload.data;
        if (event.payload.entryType==='CHILD_RESULT') {
          const hash=crypto.createHash('sha256')
            .update(JSON.stringify({result:data.result??null,error:data.error??null})).digest('hex');
          if (hash!==data.resultSha256) throw new Error('Historical report checksum mismatch');
        }
        return structuredClone({event_id:event.id,entry_type:event.payload.entryType,
          recorded_at:event.recordedAt,original_recipient_incarnation_id:event.recipient.incarnationId,
          historical_unprocessed:true,data});
      },
      reconcilePredecessors: async (principal,scope,expectedSnapshotSha256,
          confirmation,reason,idempotencyKey) => {
        if (!authorizePrivateCoordination(principal,scope)) {
          throw new Error('Predecessor reconciliation requires the same local-profile manager');
        }
        if (confirmation!=='QUARANTINE_UNPROCESSED_EVENTS' ||
            typeof reason!=='string' || reason.trim().length<10 || reason.length>512 ||
            !/^[a-f0-9]{64}$/.test(expectedSnapshotSha256)) {
          throw new Error('Explicit quarantine confirmation, reason and snapshot digest required');
        }
        const ownerKey=privateScopeKey(principal);
        const recipient={
          type:'manager_tab',tabId:scope.recipientTabId,
          incarnationId:scope.recipientIncarnationId,
          connectionGeneration:scope.recipientGeneration,
        };
        const predecessor=privateRecipientPredecessors(queueState,recipient,ownerKey);
        if (!predecessor.older.length ||
            predecessor.snapshotSha256!==expectedSnapshotSha256) {
          throw new Error('Historical snapshot mismatch; inspect unresolved events again');
        }
        const priorKeys=[...new Set(predecessor.older.map((item)=>item.recipientKey))].sort();
        const record=await append(principal,scope,'recipient.reconcile',{
          phase:'QUARANTINE_PREDECESSORS',snapshotSha256:expectedSnapshotSha256,
          priorKeys,confirmation,reason,
        },idempotencyKey);
        return {reconciliation_event_id:record.id,sequence:record.seq,
          historical_events_preserved:true,historical_events_processed:false,
          automatic_replay:false,quarantined_recipient_generations:priorKeys.length};
      },
      append,
      diagnosticCounts: () => privateQueueDiagnosticCounts(queueState),
      unresolvedForTab: (tabId) => queueState.fifo
        .map((key) => queueState.byRef.get(key))
        .filter((item) => item.recipientTabId === tabId &&
          !['PROCESSED','SAGA_CONFIRMED'].includes(item.phase))
        .map((item) => ({phase:item.phase,entryType:item.entryType})),
      close: () => {
        if (!closePromise) {
          closePromise = (async () => {
            await serial;
            await file.close();
            await lock.close();
            await fs.promises.unlink(lockPath);
          })();
        }
        return closePromise;
      },
    });
  } catch (error) {
    await file?.close().catch(() => {});
    if (lock) {
      await lock.close().catch(() => {});
      await fs.promises.unlink(lockPath).catch(() => {});
    }
    throw error; // No journal deletion, truncation, or automatic tail replay.
  }
}

// ------------------------------------------------------- extension WS bridge
let bridge = null;
const pending = new Map(); // id -> { resolve, reject, timer }

const bridgeConnected = () => bridge && bridge.readyState === 1;

function callExtension(method, params = {}, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    if (!bridgeConnected()) {
      return reject(
        new Error(
          'The browser extension is not connected. Open the extension popup, check the server URL/token, and make sure the browser is running.'
        )
      );
    }
    const id = crypto.randomUUID();
    const startedAt = Date.now();
    diagnostics.debug('bridge.request',{method,requestId:id,tabId:params.tab_id});
    const timer = setTimeout(() => {
      pending.delete(id);
      diagnostics.warn('bridge.timeout',{method,requestId:id,durationMs:Date.now()-startedAt});
      reject(new Error(`Extension call "${method}" timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    pending.set(id, {
      resolve:(result)=>{
        diagnostics.debug('bridge.response',{method,requestId:id,
          durationMs:Date.now()-startedAt,success:true});
        resolve(result);
      },
      reject:(error)=>{
        diagnostics.warn('bridge.response',{method,requestId:id,
          durationMs:Date.now()-startedAt,success:false,
          errorClass:classifyDiagnosticError(error)});
        reject(error);
      },timer,
    });
    bridge.send(JSON.stringify({ type: 'call', id, method, params }));
  });
}

function failAllPending(reason) {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
}

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  if (bridge && bridge !== ws) {
    // Do not carry pending side-effect calls across extension incarnations.
    failAllPending('Extension connection replaced; prior call outcome UNCERTAIN');
    try {
      bridge.close(4000, 'replaced by a newer connection');
    } catch {}
  }
  bridge = ws;
  profileSocketGeneration++;
  diagnostics.info('bridge.connected',{socketGeneration:profileSocketGeneration});
  profileManagerIdentities.clear();
  activePrivateManagers.clear();
  privateManagerObservations.clear();
  armedPrivateDelivery.clear();
  console.log('[bridge] extension connected');
  ws.send(JSON.stringify({ type: 'coordination_capabilities',
    queue_enabled: privateCoordinationEnabled && Boolean(privateJournal) }));
  sendAgentSettings(ws);

  ws.on('message', (raw) => {
    if (ws !== bridge) return; // Stale transport may never ACK a new generation.
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'settings_applied') {
      if (trustedExtensionSockets.has(ws) && msg.revision === agentSettingsRevision) {
        process.parentPort?.postMessage({type: 'agent_settings_synced', revision: msg.revision});
      }
      return;
    }
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (msg.type === 'diagnostic_event') {
      if (typeof msg.event === 'string' && /^[a-z][a-z0-9_.-]{0,79}$/.test(msg.event) &&
          ['debug','info','warn','error'].includes(msg.level)) {
        diagnostics.event(msg.level,'extension.'+msg.event,msg.data);
      }
      return;
    }
    if (msg.type === 'worker_lost') {
      if (!PRIVATE_EVENT_ID.test(msg.request_id || '')) return;
      void acceptPrivateWorkerLoss(msg).then((receipt) => {
        if (ws.readyState === 1 && ws === bridge) ws.send(JSON.stringify({
          type:'worker_event_receipt',request_id:msg.request_id,ok:true,receipt,
        }));
      }).catch(() => {
        if (ws.readyState === 1 && ws === bridge) ws.send(JSON.stringify({
          type:'worker_event_receipt',request_id:msg.request_id,ok:false,
          error:'Durable lost-child event unavailable; reconcile without blind replay',
        }));
      });
      return;
    }
    if (msg.type === 'worker_done') {
      if (!PRIVATE_EVENT_ID.test(msg.request_id || '')) return;
      void acceptPrivateWorkerCompletion(msg).then((receipt) => {
        if (ws.readyState === 1 && ws === bridge) {
          ws.send(JSON.stringify({ type: 'worker_event_receipt', request_id: msg.request_id,
            ok: true, receipt }));
        }
      }).catch(() => {
        if (ws.readyState === 1 && ws === bridge) {
          ws.send(JSON.stringify({ type: 'worker_event_receipt', request_id: msg.request_id,
            ok: false, error: 'Durable worker receipt unavailable; reconcile without replay' }));
        }
      });
      return;
    }
    if (msg.type === 'result') {
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || 'extension error'));
    }
  });

  ws.on('close', () => {
    if (bridge === ws) {
      bridge = null;
      diagnostics.warn('bridge.disconnected',{socketGeneration:profileSocketGeneration});
      console.log('[bridge] extension disconnected');
      profileManagerIdentities.clear();
      activePrivateManagers.clear();
      armedPrivateDelivery.clear();
      failAllPending('Extension disconnected while a call was in flight');
    }
  });
});

// ------------------------------------------------- private producer/manager API
// Manager registration is volatile and reset on extension restart or proxy restart.
const activePrivateManagers = new Map(); // profileId -> frozen browser-session manager context
const privateManagerObservations = new Map(); // transient readiness observation

function privateManagerScope(principal) {
  if (!privateCoordinationEnabled || !privateJournal ||
      !verifiedPrincipalContexts.has(principal) || principal.mode !== 'profile') {
    throw new Error('Private coordination requires a configured profile manager');
  }
  const scope = Object.freeze({
    ownerPrincipalId: principal.principalId,
    workspaceId: principal.workspaceId, projectId: principal.projectId,
    orchestratorId: principal.orchestratorId, parentTaskId: principal.parentTaskId,
    ownerTabId: principal.callerTabId, workerTabId: principal.callerTabId,
    connectionGeneration: principal.connectionGeneration,
    recipientTabId: principal.callerTabId,
    recipientIncarnationId: principal.sessionIncarnationId,
    recipientGeneration: principal.connectionGeneration,
    workerIncarnationId: principal.sessionIncarnationId,
    workerGeneration: principal.connectionGeneration,
  });
  verifiedCoordinationScopes.add(scope);
  return scope;
}

function registeredPrivateManager(principal) {
  const active = activePrivateManagers.get(principal?.credentialId);
  if (!active || !sameProfileManager(active, principal) ||
      !currentPrivatePrincipal(principal)) {
    throw new Error('Selected manager tab is not registered in this proxy session');
  }
  return active;
}

function rememberPrivateManagerReadiness(principal, observation) {
function rememberPrivateManagerReadiness(principal, observation) {
  if (!observation) throw new Error('Paired manager tab could not be attested: no browser observation');
  const mismatches = [];
  if (observation.tab_id !== principal.callerTabId) mismatches.push('tab_id');
  if (observation.browser_session_id !== principal.browserSessionId) mismatches.push('browser_session_id');
  if (observation.incarnation_id !== principal.sessionIncarnationId) mismatches.push('incarnation_id');
  const validStates = ['idle', 'busy', 'draft', 'loading', 'uncertain', 'unknown'];
  if (!validStates.includes(observation.state)) mismatches.push('readiness_state');
  if (mismatches.length) {
    throw new Error('Paired manager tab could not be attested: mismatch in ' + mismatches.join(', '));
  }
  // Loading is a valid authenticated observation, but it cannot dispatch.
  privateManagerObservations.set(principal.credentialId, {
    state: observation.state, observedAt: Date.now(),
  });
}
}

function privateReadinessState({ revoked, registered, connected, observation, now = Date.now() }) {
  if (revoked) return 'revoked';
  if (!registered) return 'not_registered';
  if (!connected) return 'disconnected';
  if (!observation || !Number.isSafeInteger(observation.observedAt) ||
      observation.observedAt > now || now - observation.observedAt > 10000) return 'unknown';
  return ['idle', 'busy', 'draft', 'loading', 'uncertain', 'unknown'].includes(observation.state)
    ? observation.state : 'unknown';
}

async function registerPrivateManager(principal) {
  privateManagerScope(principal);
  const observation = await callExtension('manager_state', { __trustedPrincipal: principal });
  if (!currentPrivatePrincipal(principal)) throw new Error('Configured manager tab changed during registration');
  rememberPrivateManagerReadiness(principal, observation);
  activePrivateManagers.set(principal.credentialId, principal);
  return { registered: true, manager_tab_id: principal.callerTabId,
    observation: observation.state, storage_ready: true };
}

// Closure is an internal worker lifecycle decision, not a Saga board operation.
// Optional Saga references remain external reporting metadata only.
// Closure is controlled by the parent and internal worker task UUIDs. Saga
// references are optional external metadata, never a gate or ownership key.
async function closeReviewedWorker(principal, args) {
  const worker = tabRegistry.get(args.tab_id);
  if (!worker || worker.parentTabId !== principal.callerTabId ||
      !['started','reattached'].includes(worker.phase)) {
    throw new Error('Worker is not in a closable state; reconcile it first');
  }
  if (tabRegistry.hasChildren(args.tab_id))
    throw new Error('Worker has descendants; close or reconcile them first');
  const inspected = await callExtension('inspect_worker_tasks', {
    __trustedPrincipal:principal,tab_id:args.tab_id,
    worker_incarnation_id:worker.incarnationId,
  });
  if (inspected?.tab_id !== args.tab_id ||
      inspected.worker_incarnation_id !== worker.incarnationId ||
      !Array.isArray(inspected.tasks) || inspected.tasks.length === 0 ||
      inspected.tasks.some((task)=>!PRIVATE_EVENT_ID.test(task.task_id || '') ||
        !['done','failed'].includes(task.status))) {
    throw new Error('Worker tasks are missing, running or unresolved');
  }
  if (privateCoordinationEnabled && privateJournal) {
    const active = registeredPrivateManager(principal);
    const scope = privateManagerScope(active);
    const reports = privateJournal.replay(active,scope).filter((event)=>
      event.payload.phase === 'QUEUED' &&
      event.payload.entryType === 'CHILD_RESULT' &&
      event.source.tabId === args.tab_id &&
      event.source.incarnationId === worker.incarnationId);
    const acknowledgements = new Set(privateJournal.queueState(active,scope)
      .filter((item)=>['PROCESSED','SAGA_CONFIRMED'].includes(item.phase))
      .map((item)=>item.ref));
    for (const task of inspected.tasks) {
      if (!reports.some((event)=>event.payload.data.taskId === task.task_id &&
          event.payload.data.status === task.status && acknowledgements.has(event.id))) {
        throw new Error('Parent has not ACKed worker result ' + task.task_id +
          '; review it or send a fixing task to the same worker');
      }
    }
  }
  await verifyDirectChild(principal.callerTabId,args.tab_id);
  if (privateCoordinationEnabled && privateJournal) registeredPrivateManager(principal);
  else if (!currentPrivatePrincipal(principal))
    throw new Error('Parent tab changed during close review');
  return callExtension('close_reviewed_worker',{
    __trustedPrincipal:principal,tab_id:args.tab_id,
    worker_incarnation_id:worker.incarnationId,parent_reviewed:true,
  });
}

function getPrivateFullReport(principal, eventId) {
  const active = registeredPrivateManager(principal);
  const scope = privateManagerScope(active);
  const report = privateJournal.replay(active, scope).find((event) =>
    event.id === eventId && event.payload.phase === 'QUEUED' &&
    event.payload.entryType === 'CHILD_RESULT');
  if (!report) throw new Error('Unknown immutable report in this caller scope');
  const data = report.payload.data;
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify({ result: data.result ?? null, error: data.error ?? null }))
    .digest('hex');
  if (digest !== data.resultSha256) throw new Error('Immutable report content digest mismatch');
  return { event_id: eventId, recorded_at: report.recordedAt,
    full_report_ref: eventId, result_sha256: digest, report: structuredClone(data) };
}

async function enqueuePrivateStatus(principal, idempotencyKey, summary) {
  const active = registeredPrivateManager(principal);
  const scope = privateManagerScope(active);
  if (typeof summary !== 'string' || summary.length > 4000) {
    throw new Error('Invalid status request summary');
  }
  const record = await privateJournal.append(active, scope, 'queue.transition', {
    phase: 'QUEUED', entryType: 'STATUS_REQUEST', leaseGeneration: 0,
    leaseNonce: null, data: { summary },
  }, idempotencyKey);
  return { event_id: record.id, seq: record.seq, state: 'QUEUED' };
}

async function acceptPrivateWorkerCompletion(packet) {
  if (!privateCoordinationEnabled || !privateJournal) {
    throw new Error('Private coordination storage is not active');
  }
  if (!packet || !PRIVATE_EVENT_ID.test(packet.task_id || '') ||
      !PRIVATE_EVENT_ID.test(packet.worker_incarnation_id || '') ||
      !Number.isSafeInteger(packet.tab_id) || packet.tab_id <= 0 ||
      !PRIVATE_EVENT_ID.test(packet.credential_id || '')) {
    throw new Error('Invalid worker completion receipt');
  }
  const active = activePrivateManagers.get(packet.credential_id);
  if (!active) throw new Error('Parent manager must register before child completion');
  registeredPrivateManager(active);
  const task = await callExtension('get_result', {
    task_id: packet.task_id, __trustedPrincipal: active,
  });
  if (!['done', 'failed'].includes(task.status) || task.tab_id !== packet.tab_id ||
      task.source_incarnation_id !== packet.worker_incarnation_id) {
    throw new Error('Worker completion provenance does not match the active task');
  }
  const scope = await verifiedPrivateWorkerScope(active, packet.tab_id);
  if (scope.workerIncarnationId !== packet.worker_incarnation_id) {
    throw new Error('Worker tab was replaced or incarnation changed');
  }
  const result = task.result ?? null;
  const error = task.error ?? null;
  const data = { taskId: packet.task_id, workerTabId: packet.tab_id,
    site: task.site, status: task.status, result, error,
    resultSha256: crypto.createHash('sha256')
      .update(JSON.stringify({ result, error })).digest('hex'),
    elapsedSeconds: task.elapsed_seconds };
  if (Buffer.byteLength(JSON.stringify(data)) > 48000) {
    throw new Error('Full worker report exceeds journal frame; no truncated receipt is accepted');
  }
  const record = await privateJournal.append(active, scope, 'queue.transition', {
    phase: 'QUEUED', entryType: 'CHILD_RESULT', leaseGeneration: 0,
    leaseNonce: null, data,
  }, packet.task_id);
  return { event_id: record.id, full_report_ref: record.id,
    result_sha256: data.resultSha256, seq: record.seq, durably_recorded: true };
}

// A worker-loss report must match the existing local-profile task and incarnation.
async function acceptPrivateWorkerLoss(packet) {
  if (!privateCoordinationEnabled || !privateJournal) throw new Error('Private child-loss queue unavailable');
  if (!packet || !PRIVATE_EVENT_ID.test(packet.task_id || '') ||
      !PRIVATE_EVENT_ID.test(packet.worker_incarnation_id || '') ||
      !PRIVATE_EVENT_ID.test(packet.credential_id || '') ||
      !PRIVATE_EVENT_ID.test(packet.event_key || '') ||
      !Number.isSafeInteger(packet.tab_id) || packet.tab_id <= 0 ||
      typeof packet.saved_url !== 'string' || packet.saved_url.length > 2048) {
    throw new Error('Invalid child-loss receipt');
  }
  const url = new URL(packet.saved_url);
  if (url.protocol !== 'https:' ||
      !['chatgpt.com','chat.openai.com','claude.ai','gemini.google.com'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Unsafe child conversation URL');
  }
  const principal = activePrivateManagers.get(packet.credential_id);
  if (!principal) throw new Error('Parent manager not registered');
  const active = registeredPrivateManager(principal);
  const task = await callExtension('get_result', {__trustedPrincipal:active,task_id:packet.task_id});
  if (task.tab_id !== packet.tab_id ||
      task.source_incarnation_id !== packet.worker_incarnation_id ||
      !['done','failed'].includes(task.status)) {
    throw new Error('Child-loss receipt does not match owned task history');
  }
  const scope = Object.freeze({
    ownerPrincipalId:active.principalId,
    workspaceId:active.workspaceId,projectId:active.projectId,
    orchestratorId:active.orchestratorId,parentTaskId:active.parentTaskId,
    ownerTabId:active.callerTabId,workerTabId:packet.tab_id,
    connectionGeneration:active.connectionGeneration,
    recipientTabId:active.callerTabId,
    recipientIncarnationId:active.sessionIncarnationId,
    recipientGeneration:active.connectionGeneration,
    workerIncarnationId:packet.worker_incarnation_id,workerGeneration:1,
  });
  verifiedCoordinationScopes.add(scope);
  registeredPrivateManager(active);
  const record = await privateJournal.append(active,scope,'queue.transition',{
    phase:'QUEUED',entryType:'CHILD_TAB_LOST',leaseGeneration:0,leaseNonce:null,
    data:{taskId:packet.task_id,workerTabId:packet.tab_id,
      workerIncarnationId:packet.worker_incarnation_id,
      savedUrl:packet.saved_url,status:'UNKNOWN',
      originalTaskStatus:task.status,
      reason:'Tab removed or unavailable; browser cause not proven'},
  },packet.event_key);
  return {event_id:record.id,seq:record.seq,state:'QUEUED',durably_recorded:true};
}

// A manager opts into automatic wake only after its token-verified registration.
// This volatile arm state deliberately vanishes on restart; no blind replay.
const armedPrivateDelivery = new Set();
const privateDispatching = new Set();
let privateDispatchTimer = null;

function privateRecordedScope(principal, event) {
  const source = event.source;
  const worker = source.type === 'worker_tab'
    ? { workerTabId: source.tabId, workerIncarnationId: source.incarnationId,
        workerGeneration: source.connectionGeneration }
    : { workerTabId: principal.callerTabId,
        workerIncarnationId: principal.sessionIncarnationId,
        workerGeneration: principal.connectionGeneration };
  const scope = Object.freeze({
    ownerPrincipalId: principal.principalId, workspaceId: principal.workspaceId,
    projectId: principal.projectId, orchestratorId: principal.orchestratorId,
    parentTaskId: principal.parentTaskId, ownerTabId: principal.callerTabId,
    connectionGeneration: principal.connectionGeneration,
    recipientTabId: principal.callerTabId,
    recipientIncarnationId: principal.sessionIncarnationId,
    recipientGeneration: principal.connectionGeneration,
    ...worker,
  });
  verifiedCoordinationScopes.add(scope);
  return scope;
}

// Queue notifications are bounded previews. The complete, checksummed report
// remains immutable in the journal and retrievable through coordination_get_report.
function privateQueueSummary(original) {
  const data = original.payload.data;
  if (original.payload.entryType === 'STATUS_REQUEST') return data.summary;
  if (original.payload.entryType === 'CHILD_TAB_LOST') {
    return JSON.stringify({task_id:data.taskId,child_tab_id:data.workerTabId,
      saved_url:data.savedUrl,status:data.status,reason:data.reason,
      original_task_status:data.originalTaskStatus});
  }
  const body = data.result ?? data.error ?? null;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return JSON.stringify({
    task_id:data.taskId,worker_tab_id:data.workerTabId,status:data.status,
    full_report_ref:original.id,result_sha256:data.resultSha256,
    result_preview:text.slice(0,3000),preview_truncated:text.length>3000,
  });
}

async function pumpOnePrivateManager(principal) {
  if (!privateCoordinationEnabled || !privateJournal ||
      !armedPrivateDelivery.has(principal.credentialId) ||
      privateDispatching.has(principal.credentialId)) return;
  privateDispatching.add(principal.credentialId);
  diagnostics.debug('fifo.pump_started',{callerTabId:principal.callerTabId});
  try {
    registeredPrivateManager(principal); // Rechecks revocation on every wake.
    const managerScope = privateManagerScope(principal);
    let pendingQueue = privateJournal.queueState(principal, managerScope)
      .filter((item) => item.phase !== 'PROCESSED' && item.phase !== 'SAGA_CONFIRMED');
    if (!pendingQueue.length || pendingQueue[0].phase !== 'QUEUED') {
      diagnostics.debug('fifo.pump_held',{callerTabId:principal.callerTabId,
        queueDepth:pendingQueue.length,phase:pendingQueue[0]?.phase || 'empty'});
      return;
    }
    // Stop at the first unresolved earlier batch; never skip a status barrier.
    const batchItems = [];
    for (const item of pendingQueue) {
      if (item.phase !== 'QUEUED' || batchItems.length >= 16) break;
      batchItems.push(item);
    }
    const recorded = privateJournal.replay(principal, managerScope);
    const firstEvents = new Map(recorded.filter((event) =>
      event.payload.phase === 'QUEUED').map((event) => [event.id, event]));
    const events = [];
    const batchId = crypto.randomUUID();
    let size = 0;
    for (const item of batchItems) {
      const original = firstEvents.get(item.ref);
      if (!original) throw new Error('Queued event source missing from durable journal');
      const summary = privateQueueSummary(original);
      if (typeof summary !== 'string') throw new Error('Invalid durable event summary');
      const candidate = { event_id: original.id, type: item.entryType,
        summary, recorded_at: original.recordedAt };
      if (summary.length > 20000 || size + summary.length > 52000) break;
      // A rich prompt may expand JSON escapes; check its actual size BEFORE
      // reserving durable leases, so the oldest FIFO event cannot deadlock.
      try {
        composeAgentPrompt(agentSettings,{kind:'queue',batchId,events:[...events,candidate]});
      } catch (error) {
        if (!events.length) throw error;
        break;
      }
      size += summary.length;
      events.push(candidate);
    }
    if (!events.length) {
      diagnostics.warn('fifo.empty_batch',{callerTabId:principal.callerTabId});
      return; // Oversized immutable event requires manual handling.
    }
    diagnostics.info('fifo.batch_prepared',{callerTabId:principal.callerTabId,batchId,
      batchSize:events.length,queueDepth:pendingQueue.length});
    const ready = await callExtension('manager_state', { __trustedPrincipal: principal });
    rememberPrivateManagerReadiness(principal, ready);
    if (ready.ready !== true || ready.state !== 'idle') {
      diagnostics.debug('fifo.parent_not_ready',{callerTabId:principal.callerTabId,batchId,
        status:ready.state});
      return;
    }
    // An await above may have admitted another producer: revalidate this
    // exact oldest prefix before writing even the first lease.
    pendingQueue = privateJournal.queueState(principal, managerScope)
      .filter((item) => item.phase !== 'PROCESSED' && item.phase !== 'SAGA_CONFIRMED');
    if (events.some((event, i) =>
      pendingQueue[i]?.ref !== event.event_id || pendingQueue[i].phase !== 'QUEUED')) return;

    const scopes = [];
    for (const event of events) {
      const original = firstEvents.get(event.event_id);
      if (original.source.type === 'worker_tab' && original.payload.entryType !== 'CHILD_TAB_LOST') {
        const verified = await verifiedPrivateWorkerScope(principal, original.source.tabId);
        if (verified.workerIncarnationId !== original.source.incarnationId) {
          throw new Error('Queued child source incarnation no longer matches');
        }
        scopes.push(verified);
      } else scopes.push(privateRecordedScope(principal, original));
    }
    for (let i = 0; i < events.length; i++) {
      await privateJournal.append(principal, scopes[i], 'queue.transition', {
        phase: 'LEASED', ref: events[i].event_id, leaseGeneration: 1,
        leaseNonce: batchId,
      }, crypto.randomUUID());
    }
    for (let i = 0; i < events.length; i++) {
      await privateJournal.append(principal, scopes[i], 'queue.transition', {
        phase: 'DISPATCHING', ref: events[i].event_id, leaseGeneration: 1,
        leaseNonce: batchId,
      }, crypto.randomUUID());
    }
    diagnostics.info('fifo.dispatching',{callerTabId:principal.callerTabId,batchId,
      batchSize:events.length});
    let submitted = false;
    try {
      registeredPrivateManager(principal); // No stale credential may submit a browser prompt.
      const outcome = await callExtension('wake_manager', {
        __trustedPrincipal: principal, batch_id: batchId, events,
        prompt_text: composeAgentPrompt(agentSettings,{kind:'queue',batchId,events}),
      });
      submitted = outcome?.submitted === true && outcome.uncertain !== true;
    } catch { /* Submitted status may be ambiguous; never retry. */ }
    for (let i = 0; i < events.length; i++) {
      await privateJournal.append(principal, scopes[i], 'queue.transition', {
        phase: submitted ? 'DELIVERED' : 'UNCERTAIN',
        ref: events[i].event_id, leaseGeneration: 1, leaseNonce: batchId,
      }, crypto.randomUUID());
    }
    diagnostics.event(submitted?'info':'warn','fifo.dispatch_result',{
      callerTabId:principal.callerTabId,batchId,batchSize:events.length,
      phase:submitted?'DELIVERED':'UNCERTAIN',success:submitted});
  } catch (error) {
    diagnostics.error('fifo.pump_failed',{callerTabId:principal.callerTabId,
      errorClass:classifyDiagnosticError(error)});
    console.error('[coordination] dispatch held:', error?.message);
  } finally {
    privateDispatching.delete(principal.credentialId);
  }
}

function pumpPrivateQueue() {
  if (!privateCoordinationEnabled || !privateJournal) return;
  for (const credentialId of armedPrivateDelivery) {
    const principal = activePrivateManagers.get(credentialId);
    if (principal) void pumpOnePrivateManager(principal);
  }
}

async function acknowledgePrivateBatch(principal, batchId, eventIds) {
  const active = registeredPrivateManager(principal);
  const managerScope = privateManagerScope(active);
  const items = privateJournal.queueState(active, managerScope)
    .filter((item) => item.leaseNonce === batchId && item.phase === 'DELIVERED');
  if (!PRIVATE_EVENT_ID.test(batchId) || !Array.isArray(eventIds) ||
      eventIds.length < 1 || eventIds.length > 16 ||
      items.length !== eventIds.length ||
      items.some((item, i) => item.ref !== eventIds[i])) {
    diagnostics.warn('fifo.ack_rejected',{callerTabId:principal.callerTabId,
      batchId, batchSize:Array.isArray(eventIds)?eventIds.length:0,
      deliveredCount:items.length});
    throw new Error('Batch processing ACK does not match delivered FIFO records');
  }
  diagnostics.info('fifo.ack_started',{callerTabId:principal.callerTabId,
    batchId,batchSize:items.length});
  const recorded = privateJournal.replay(active, managerScope);
  const originals = new Map(recorded.filter((event) => event.payload.phase === 'QUEUED')
    .map((event) => [event.id, event]));
  for (const item of items) {
    const original = originals.get(item.ref);
    if (!original) throw new Error('Missing immutable batch source');
    const scope = privateRecordedScope(active, original);
    await privateJournal.append(active, scope, 'queue.transition', {
      phase: 'PROCESSED', ref: item.ref,
      leaseGeneration: item.leaseGeneration, leaseNonce: batchId,
      ack: { kind: 'explicit_manager_ack', eventRef: item.ref,
        principalId: active.principalId, acknowledgedAt: new Date().toISOString(),
        batchId },
    }, crypto.randomUUID());
  }
  await callExtension('manager_processed', {
    __trustedPrincipal: active, batch_id: batchId,
  }).catch(() => {}); // Journal ACK remains primary; extension state may need manual reconciliation.
  diagnostics.info('fifo.ack_processed',{callerTabId:principal.callerTabId,
    batchId,processedCount:items.length});
  return { processed: items.map((item) => item.ref), saga_confirmed: false };
}

// --------------------------------------------------------------- MCP server
const textResult = (value) => ({
  content: [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
});

const errorResult = (err) => ({
  isError: true,
  content: [{ type: 'text', text: String(err?.message || err) }],
});

function forward(method, principal) {
  return async (args) => {
    const startedAt = Date.now();
    const traceId=crypto.randomUUID();
    diagnostics.debug('mcp.call_started',{traceId,method,callerTabId:args?.caller_tab_id,
      tabId:args?.tab_id});
    try {
      if (method === 'list_tabs' && args?.caller_tab_id == null) {
        const candidates = await callExtension('list_tabs',{__discoveryOnly:true});
        return textResult(candidates);
      }
      const selfRead = method === 'read_chat' &&
        (args?.tab_id == null || args.tab_id === args.caller_tab_id);
      const caller = await resolveCaller(args,{
        createRoot:method === 'spawn_worker' || selfRead,
      });
      let result;
      if (method === 'spawn_worker') {
        result = await spawnAndBindWorker(args,caller);
      } else if (method === 'reopen_child') {
        const root = tabRegistry.get(tabRegistry.get(caller.callerTabId)?.rootTabId);
        if (!root || root.parentTabId !== null ||
            root.browserSessionId !== caller.browserSessionId)
          throw new Error('Root browser identity unavailable for child recovery');
        result = await callExtension(method,{...args,__trustedPrincipal:caller,
          __rootTabId:root.tabId,__rootIncarnationId:root.incarnationId});
        if (Number.isSafeInteger(result?.tab_id)) {
          const inspected = await callExtension('inspect_tab',{tab_id:result.tab_id});
          await tabRegistry.registerChild(caller.callerTabId,inspected);
          await tabRegistry.setPhase(result.tab_id,'reattached');
          result = {...result,parent_tab_id:caller.callerTabId,
            root_tab_id:tabRegistry.get(result.tab_id).rootTabId};
        }
      } else {
        const target = args?.tab_id;
        if (method === 'send_to_tab' || (method === 'read_chat' && target != null)) {
          if (target !== caller.callerTabId) await verifyDirectChild(caller.callerTabId,target);
        }
        if (method === 'send_to_tab' &&
            !['started','reattached'].includes(tabRegistry.get(target)?.phase))
          throw new Error('Worker is prepared or UNCERTAIN; reconcile before another message');
        if (method === 'list_tabs') {
          const tabs = await callExtension('list_tabs',{__trustedPrincipal:caller});
          result = tabs.filter(t=>t.tab_id === caller.callerTabId ||
            tabRegistry.directChild(caller.callerTabId,t.tab_id))
            .map(t=>({...t,parent_tab_id:tabRegistry.get(t.tab_id)?.parentTabId ?? null,
              root_tab_id:tabRegistry.get(t.tab_id)?.rootTabId ?? null}));
        } else result = await callExtension(method,{...args,__trustedPrincipal:caller});
      }
      recordToolActivity(caller, method, true, startedAt);
      diagnostics.info('mcp.call_completed',{traceId,method,callerTabId:args?.caller_tab_id,
        tabId:args?.tab_id,durationMs:Date.now()-startedAt,success:true});
      return textResult(result);
    } catch (err) {
      recordToolActivity(principal, method, false, startedAt);
      diagnostics.warn('mcp.call_failed',{traceId,method,callerTabId:args?.caller_tab_id,
        tabId:args?.tab_id,durationMs:Date.now()-startedAt,success:false,
        errorClass:classifyDiagnosticError(err)});
      return errorResult(err);
    }
  };
}

const waitSeconds = z
  .number()
  .int()
  .min(0)
  .max(50)
  .optional()
  .describe(
    'Seconds to wait for the worker to finish before returning (max 50). If it is still running, you get a task_id; call get_result to keep waiting.'
  );

function buildServer(principal) {
  const callerTabInput = z.number().int().positive()
    .describe('Browser tab_id of the calling chat conversation. Use list_tabs to discover IDs.');
  const server = new McpServer({ name: 'chat-orchestrator', version: '0.1.0' });

  server.registerTool(
    'list_tabs',
    {
      title: 'List chat tabs',
      description:
        'List open Claude / ChatGPT tabs in the user\'s browser with their tab_id, site, title and role (orchestrator, worker, or other).',
      inputSchema: {caller_tab_id:callerTabInput.optional()},
    },
    forward('list_tabs', principal)
  );

  server.registerTool(
    'spawn_worker',
    {
      title: 'Start a worker chat',
      description:
        'Open or reuse a worker chat under caller_tab_id. Returns an internal task_id; use get_result for updates. The parent may inspect the result and send fixing tasks with send_to_tab until satisfied. Saga references are optional external task metadata, never worker identities or closure gates. Close only when parent-owned work is terminal and all required result receipts are processed.',
      inputSchema: {
        caller_tab_id:callerTabInput,
        saga_task_id:z.number().int().positive().optional()
          .describe('Optional external Saga tracking reference; not a worker identifier or closure prerequisite.'),
        site: z.enum(['chatgpt', 'claude', 'gemini']).describe('Which chat site the worker runs on.'),
        operation: z.enum(['task','workspace','delegation']).optional().describe('Operation-specific instructions to include.'),
        role: z.string().trim().min(1).max(128).optional()
          .describe('Optional reusable seat label; any project role is allowed. This is metadata, never authorization or an injected role prompt.'),
        role_scope: z.string().trim().min(1).max(128).optional()
          .describe('Reusable profile-local seat label from your skill/task context. Same label and scope reuse the same idle chat; the proxy imposes no role hierarchy.'),
        task: z
          .string()
          .min(1)
          .describe('Self-contained instructions for the worker. Include all the context it needs.'),
        share_context_from: z
          .string()
          .optional()
          .describe(
            'Optional. Copy the full transcript of another tab into the worker\'s first message. Use a tab_id, "orchestrator" (the tab marked as orchestrator) or "active" (the tab the user is looking at).'
          ),
        auto_close: z
          .boolean()
          .optional()
          .describe(
             'Automatic worker closure is disabled. The parent reviews results, acknowledges FIFO receipts when enabled, and explicitly calls close_worker.'
          ),
        wait_seconds: waitSeconds,
      },
    },
    forward('spawn_worker', principal)
  );

  server.registerTool(
    'reopen_child',
    {
      title:'Recover a lost child conversation',
      description:'Reopen a saved child conversation by its original task_id in this profile. Returns a newly attached child tab. Execution is not automatically resumed. Inspect read_chat and get_result first.',
      inputSchema:{caller_tab_id:callerTabInput,task_id:z.string().uuid().describe('Original task_id from CHILD_TAB_LOST notification.')},
    },
    forward('reopen_child',principal)
  );
  server.registerTool(
    'send_to_tab',
    {
      title: 'Send a follow-up to an existing worker tab',
      description:
        'Send another message to a worker tab that is already open (continues that chat). Returns a task_id; use get_result to collect the reply.',
      inputSchema: {
        caller_tab_id:callerTabInput,
        tab_id: z.number().int().describe('tab_id of the worker tab (from list_tabs or spawn_worker).'),
        text: z.string().min(1).describe('Message to send.'),
        wait_seconds: waitSeconds,
      },
    },
    forward('send_to_tab', principal)
  );

  server.registerTool(
    'get_result',
    {
      title: 'Get a worker result',
      description:
        'Get the status/result of a task started by spawn_worker or send_to_tab. If it is still running, waits up to wait_seconds (max 50). Call it again if status is still "running".',
      inputSchema: {
        caller_tab_id:callerTabInput,
        task_id: z.string().describe('The task_id returned earlier.'),
        wait_seconds: waitSeconds,
      },
    },
    forward('get_result', principal)
  );
  server.registerTool(
    'read_chat',
    {
      title: 'Read a chat transcript',
      description:
        'Read the conversation using the site conversation API where available, with DOM fallback. Supports ChatGPT, Claude and Gemini. Defaults to orchestrator/active tab. Reasoning is excluded by default; image and attachment names can be included.',
      inputSchema: {
        caller_tab_id:callerTabInput,
        tab_id: z
          .number()
          .int()
          .optional()
          .describe('Tab to read. Omit for the orchestrator/active tab.'),
        last_n: z.number().int().min(1).max(200).optional().describe('Only return the last N messages.'),
        include_reasoning: z.boolean().optional().describe('Include thinking/tool blocks in the transcript (default false).'),
        include_attachments: z.boolean().optional().describe('Include image and attachment labels (default true); never downloads file bytes.'),
      },
    },
    forward('read_chat', principal)
  );

  server.registerTool(
    'close_worker',
    {
      title: 'Close a worker tab',
      description:
        'Close your direct child after reviewing results and any fixing tasks. Requires terminal internal task history and processed FIFO receipts when coordination is enabled. No Saga task, note or event IDs required.',
      inputSchema: {
        caller_tab_id:callerTabInput,
        tab_id: z.number().int().describe('tab_id of the worker to close.'),
        // Saga IDs are external task metadata, never a closure prerequisite.
      },
    },
    async (args) => {
      try {
        const caller = await resolveCaller(args);
        await verifyDirectChild(caller.callerTabId,args.tab_id);
        if (tabRegistry.hasChildren(args.tab_id))
          throw new Error('Child has descendants; close or reconcile them before closing this tab');
        const result = await closeReviewedWorker(caller,args);
        if (result?.closed === args.tab_id) await tabRegistry.remove(args.tab_id);
        return textResult(result);
      } catch (error) { return errorResult(error); }
    }
  );

  // Conditional private API: never present in the standard six-tool endpoint.
  if (privateCoordinationEnabled && privateJournal) {
    server.registerTool('coordination_inspect_worker_tasks', {
      title: 'Recover task identifiers from an owned worker',
      description: 'Read-only task IDs and statuses for a verified direct child. Never retries work.',
      inputSchema: {caller_tab_id:callerTabInput,tab_id:z.number().int().positive()},
    }, async (args) => {
      try {
        const caller = await resolveCaller(args);
        await verifyDirectChild(caller.callerTabId,args.tab_id);
        const worker = tabRegistry.get(args.tab_id);
        return textResult(await callExtension('inspect_worker_tasks', {
          __trustedPrincipal:caller,tab_id:args.tab_id,
          worker_incarnation_id:worker.incarnationId,
        }));
      } catch (error) { return errorResult(error); }
    });
    server.registerTool('coordination_register_manager', {
      title: 'Register profile manager for private queue',
      description: 'Register the caller tab as a queue recipient without selecting a global manager. No replay on restart.',
      inputSchema: {caller_tab_id:callerTabInput},
    }, async (args) => {
      try { return textResult(await registerPrivateManager(
        await resolveCaller(args,{createRoot:true}))); }
      catch (error) { return errorResult(error); }
    });
    server.registerTool('coordination_status_request', {
      title: 'Queue an ordered manager status barrier',
      description: 'Durably enqueue STATUS_REQUEST after earlier child reports; does not send a chat prompt.',
      inputSchema: {
        caller_tab_id:callerTabInput,
        idempotency_key: z.string().uuid(),
        summary: z.string().max(4000),
      },
    }, async (args) => {
      try { return textResult(await enqueuePrivateStatus(await resolveCaller(args), args.idempotency_key, args.summary)); }
      catch (error) { return errorResult(error); }
    });
    server.registerTool('coordination_start_delivery', {
      title: 'Arm private automatic batched manager wake',
      description: 'After explicit registration, automatically wake the paired manager once on stable idle. No recovered UNCERTAIN replay.',
      inputSchema: {caller_tab_id:callerTabInput},
    }, async (args) => {
      try {
        const caller = await resolveCaller(args);
        registeredPrivateManager(caller);
        armedPrivateDelivery.add(caller.credentialId);
        setImmediate(pumpPrivateQueue);
        return textResult({ armed: true, no_replay: true });
      } catch (error) { return errorResult(error); }
    });
    server.registerTool('coordination_pause_delivery', {
      title: 'Pause private manager wake',
      description: 'Stop new batch dispatch for this credential; already submitted batch remains unresolved.',
      inputSchema: {caller_tab_id:callerTabInput},
    }, async (args) => {
      try {
        const caller = await resolveCaller(args);
        armedPrivateDelivery.delete(caller.credentialId);
        return textResult({ armed: false });
      } catch (error) { return errorResult(error); }
    });
    server.registerTool('coordination_ack_batch', {
      title: 'Explicitly acknowledge processed private batch',
      description: 'Call only after handling every ordered event. This records consumer ACK, NOT independently verified Saga completion.',
      inputSchema: {
        caller_tab_id:callerTabInput,
        batch_id: z.string().uuid(),
        event_ids: z.array(z.string().uuid()).min(1).max(16),
      },
    }, async (args) => {
      try {
        const result = await acknowledgePrivateBatch(await resolveCaller(args), args.batch_id, args.event_ids);
        setImmediate(pumpPrivateQueue);
        return textResult(result);
      } catch (error) { return errorResult(error); }
    });
    server.registerTool('coordination_get_report', {
      title: 'Read immutable profile-local child report',
      description: 'Read full report bytes from a validated journal event; no mutable worker tab dependence.',
      inputSchema: { caller_tab_id:callerTabInput,event_id: z.string().uuid() },
    }, async (args) => {
      try { return textResult(getPrivateFullReport(await resolveCaller(args), args.event_id)); }
      catch (error) { return errorResult(error); }
    });
    server.registerTool('coordination_pending', {
      title: 'Read own private queue state',
      description: 'Read-only queue phases for the current profile; does not release UNCERTAIN items or perform Saga updates.',
      inputSchema: {caller_tab_id:callerTabInput},
    }, async (args) => {
      try {
        const active = registeredPrivateManager(await resolveCaller(args));
        const scope = privateManagerScope(active);
        return textResult({ events: privateJournal.queueState(active, scope) });
      } catch (error) { return errorResult(error); }
    });
    server.registerTool('coordination_incarnation_conflicts', {
      title: 'Inspect unresolved historical recipient incarnations',
      description: 'Read-only inspection of unresolved prior manager generations. Never replays or acknowledges events.',
      inputSchema: {caller_tab_id:callerTabInput},
    }, async (args) => {
      try {
        const active = await resolveCaller(args,{createRoot:true});
        return textResult(privateJournal.incarnationConflicts(active, privateManagerScope(active)));
      } catch (error) { return errorResult(error); }
    });
    server.registerTool('coordination_get_predecessor_event', {
      title:'Inspect a historical recipient event',
      description:'Read-only verified data for an unresolved prior incarnation. Does not deliver, process or ACK it.',
      inputSchema:{caller_tab_id:callerTabInput,event_id:z.string().uuid()},
    },async(args)=>{
      try {
        const active=await resolveCaller(args,{createRoot:true});
        return textResult(privateJournal.predecessorEvent(active,privateManagerScope(active),args.event_id));
      } catch(error) {return errorResult(error);}
    });
    server.registerTool('coordination_reconcile_predecessors', {
      title:'Explicitly quarantine historical recipient generations',
      description:'Durably records an auditable boundary after operator review. Preserves every historical event as unprocessed; never replays or ACKs them. Requires a fresh snapshot digest, explicit confirmation and stable idempotency key.',
      inputSchema:{
        caller_tab_id:callerTabInput,
        snapshot_sha256:z.string().regex(/^[a-f0-9]{64}$/),
        confirmation:z.literal('QUARANTINE_UNPROCESSED_EVENTS'),
        reason:z.string().trim().min(10).max(512),
        idempotency_key:z.string().uuid(),
      },
    },async(args)=>{
      try {
        const active=registeredPrivateManager(await resolveCaller(args));
        return textResult(await privateJournal.reconcilePredecessors(
          active,privateManagerScope(active),args.snapshot_sha256,
          args.confirmation,args.reason,args.idempotency_key));
      } catch(error) {return errorResult(error);}
    });
  }

  return server;
}

// Desktop-only snapshot through Electron utilityProcess IPC, never public HTTP.
const privateToolHistory = [];
let dashboardTimer = null;
let dashboardRefreshInFlight = false;
let currentBrowserTabs = {status:'unavailable',tabs:[],observedAt:null};
function recordToolActivity(principal, method, ok, startedAt) {
  privateToolHistory.push({
    at: new Date().toISOString(), method, ok,
    durationMs: Date.now() - startedAt,
    caller: principal?.mode === 'profile' ? 'profile' : 'legacy',
  });
  if (privateToolHistory.length > 80) privateToolHistory.shift();
}
function privateDashboardSnapshot() {
  const registryError = false;
  const seats = [...activePrivateManagers.values()].map((profile) => ({
    seatName: 'Profile manager', role: 'manager',
    workspaceId: profile.workspaceId, callerTabId: profile.callerTabId,
    registered: true, deliveryArmed: armedPrivateDelivery.has(profile.credentialId),
    readiness: privateReadinessState({
      revoked: false, registered: true,
      connected: Boolean(bridgeConnected()),
      observation: privateManagerObservations.get(profile.credentialId),
    }),
  }));
  const aggregate = privateJournal?.diagnosticCounts();
  const phases = aggregate?.phases || Object.fromEntries(
    [...PRIVATE_QUEUE_PHASES].map((phase) => [phase, 0]));
  const queue = [];
  if (privateJournal && privateCoordinationEnabled) {
    for (const principal of activePrivateManagers.values()) {
      try {
        const scope = privateManagerScope(principal);
        for (const event of privateJournal.queueState(principal, scope)) {
          queue.push({
            eventId: event.ref, phase: event.phase, type: event.entryType,
            managerTabId: event.recipientTabId,
            principalId: principal.principalId,
            seq: event.firstSeq,
          });
        }
      } catch { /* Owner may be revoked or journal under reconciliation. */ }
    }
  }
  const visiblePending = queue.filter((item) =>
    !['PROCESSED', 'SAGA_CONFIRMED'].includes(item.phase)).length;
  const hiddenPending = Math.max(0, (aggregate?.pending || 0) - visiblePending);
  const savedHierarchy=tabRegistry?.list().map(({tabId,parentTabId,rootTabId,site,phase})=>({
    tabId,parentTabId,rootTabId,site,phase,
  })) || [];
  return {
    storageReady: privateCoordinationEnabled && Boolean(privateJournal),
    deliveryEnabledByDefault: false, registryError, hiddenPending,
    extensionConnected: Boolean(bridgeConnected()),
    browserTabs:currentBrowserTabs,
    tabHierarchy:annotateTabPresence(savedHierarchy,currentBrowserTabs),
    seats, phases, queue: queue.slice(-30),
    toolCalls: privateToolHistory.slice(-25),
    generatedAt: new Date().toISOString(),
  };
}
async function publishPrivateDashboard() {
  if (!process.parentPort || dashboardRefreshInFlight) return;
  dashboardRefreshInFlight=true;
  try {
    if (!bridgeConnected()) {
      currentBrowserTabs={status:'unavailable',tabs:[],observedAt:null};
    } else {
      // Read-only tab discovery. This must never attest/register identities,
      // change durable relationships, or acknowledge/replay queued work.
      const discovered=await callExtension('list_tabs',{__discoveryOnly:true},2500);
      currentBrowserTabs={
        status:'observed',
        tabs:normalizeOpenChatTabs(discovered),
        observedAt:new Date().toISOString(),
      };
    }
  } catch {
    // A failed browser observation is UNKNOWN, not proof that tabs closed.
    currentBrowserTabs={status:'unavailable',tabs:[],observedAt:null};
  } finally {dashboardRefreshInFlight=false;}
  if (!process.parentPort || !httpServer.listening) return;
  try {
    process.parentPort.postMessage({
      type:'coordination_snapshot',snapshot:privateDashboardSnapshot(),
    });
  } catch { /* No export of internal errors or credentials. */ }
}

// ---------------------------------------------------------------- HTTP app
const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true, extensionConnected: Boolean(bridgeConnected()),
    coordination: {
      enabled: false,
      storageReady: privateCoordinationEnabled && Boolean(privateJournal),
    },
  });
});
app.post('/mcp', attachProfile, async (req, res) => {
  const server = buildServer(req.bridgePrincipal);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] error', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

const methodNotAllowed = (_req, res) =>
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed (stateless server: use POST).' },
    id: null,
  });
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

const httpServer = http.createServer(app);

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/bridge') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    trustedExtensionSockets.add(ws);
    wss.emit('connection', ws, req);
  });
});

export async function startServer() {
  if (stopServerPromise) throw new Error('Cannot start while previous journal shutdown is in progress');
  if (httpServer.listening) return httpServer.address();
  reloadAgentSettings();
  // Ownership is scoped to the current Proxy session. Ignore older
  // tab-relations.json entries; never modify the separate durable FIFO journal.
  if (!tabRegistry) tabRegistry = createSessionTabRegistry();
  if (privateCoordinationRequested && !['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
    throw new Error('Private extension bridge requires loopback bind');
  }
  if (privateCoordinationRequested && !privateJournal) {
    privateCoordinationEnabled = true;
    try {
      privateJournal = await openPrivateEventJournal();
      privateDispatchTimer = setInterval(pumpPrivateQueue, 2000);
      privateDispatchTimer.unref?.();
    } catch (error) {
      privateCoordinationEnabled = false;
      throw error; // No HTTP listener or queue side effects after failed preflight.
    }
  }
  return new Promise((resolve, reject) => {
    const onError = async (error) => {
      httpServer.off('listening', onListening);
      // The journal lock was acquired before listen(). A failed bind must
      // release it, otherwise the *next* startup reports a misleading stale
      // owner even though no proxy is running.
      clearInterval(privateDispatchTimer);
      privateDispatchTimer = null;
      if (privateJournal) {
        const journal = privateJournal;
        try {
          await journal.close();
          privateJournal = null;
          privateCoordinationEnabled = false;
        } catch (closeError) {
          reject(new AggregateError([error,closeError],
            'Listener failed and journal lock release needs manual inspection'));
          return;
        }
      }
      reject(error);
    };
    const onListening = () => {
      httpServer.off('error', onError);
      const address = httpServer.address();
      console.log(`Chat Orchestrator MCP server listening on http://${HOST}:${address.port}`);
      console.log('  Extension bridge: ws://localhost:' + address.port + '/bridge');
      console.log('  MCP endpoint: /mcp');
      process.parentPort?.postMessage({ type: 'ready', port: address.port });
      dashboardTimer = setInterval(publishPrivateDashboard, 3000);
      dashboardTimer.unref?.();
      publishPrivateDashboard();
      resolve(address);
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(PORT, HOST);
  });
}

export function stopServer() {
  if (stopServerPromise) return stopServerPromise;
  stopServerPromise = stopServerOnce().finally(() => { stopServerPromise = null; });
  return stopServerPromise;
}

async function stopServerOnce() {
  failAllPending('The local MCP server is stopping');
  clearInterval(privateDispatchTimer);
  privateDispatchTimer = null;
  clearInterval(dashboardTimer);
  dashboardTimer = null;
  currentBrowserTabs = {status:'unavailable',tabs:[],observedAt:null};
  armedPrivateDelivery.clear();
  activePrivateManagers.clear();
  privateManagerObservations.clear();
  profileManagerIdentities.clear();
  rootRepairOffers.clear();
  for (const client of wss.clients) client.terminate();
  let listenerError;
  let journalCloseError;
  try {
    if (httpServer.listening) {
      // A still-open HTTP keep-alive or long-running MCP request must not
      // prevent journal.close() from ever releasing the single-writer lock.
      const closed = new Promise((resolve, reject) =>
        httpServer.close((error) => error ? reject(error) : resolve()));
      httpServer.closeIdleConnections?.();
      const forceConnections = setTimeout(() => {
        console.warn('[bridge] graceful shutdown: closing lingering HTTP connections');
        httpServer.closeAllConnections?.();
      }, 4000);
      forceConnections.unref?.();
      try { await closed; } finally { clearTimeout(forceConnections); }
    }
  } catch (error) {
    listenerError = error;
  } finally {
    if (privateJournal) {
      const journal = privateJournal;
      // Journal.close() drains all registered append operations before
      // closing handles and unlinking this process's own lock. It refuses
      // new appends once closing starts.
      try {
        await journal.close();
        privateJournal = null;
        privateCoordinationEnabled = false;
      } catch (error) {
        console.error('[bridge] private journal close failed; lock requires owner inspection:', error.message);
        journalCloseError = error;
      }
    }
  }
  // All root/worker relationships are session-only. Close the registry even
  // if the HTTP listener failed to close, without touching the FIFO journal.
  if (tabRegistry) {
    const oldRegistry = tabRegistry;
    await oldRegistry.closeSession();
    if (tabRegistry === oldRegistry) tabRegistry = null;
  }
  if (journalCloseError) throw journalCloseError;
  if (listenerError) throw listenerError;
}

if (process.parentPort) {
  process.parentPort.on('message', async (event) => {
    if (event?.data?.type === 'desktop_extension_action') {
      const id = event.data.request_id;
      if (!PRIVATE_EVENT_ID.test(id || '')) return;
      const action = event.data.action;
      const method = {set_orchestrator: 'desktop_set_orchestrator_tab',
        diagnose: 'desktop_diagnose_tab', close_legacy_workers: 'desktop_close_legacy_workers'}[action];
      if (!method && !['inspect_root_repair','confirm_root_repair'].includes(action)) return;
      try {
        const result = action === 'inspect_root_repair'
          ? await inspectRootRepair(event.data.tab_id,true)
          : action === 'confirm_root_repair'
            ? await reconcileRootFromDesktop(event.data.tab_id,event.data.confirmation_nonce)
            : await callExtension(method, {tab_id: event.data.tab_id}, 12000);
        process.parentPort.postMessage({type:'desktop_extension_action_result',request_id:id,ok:true,result});
      } catch (error) {
        process.parentPort.postMessage({type:'desktop_extension_action_result',request_id:id,ok:false,
          error:String(error?.message || 'Extension action failed')});
      }
      return;
    }
    if (event?.data?.type === 'reload_agent_settings') {
      reloadAgentSettings();
      sendAgentSettings(bridge);
      process.parentPort.postMessage({ type: 'agent_settings_reloaded', revision: agentSettingsRevision });
      return;
    }
    if (event?.data?.type !== 'stop') return;
    try {
      await stopServer();
      process.parentPort.postMessage({ type: 'stopped' });
    } catch (error) {
      process.parentPort.postMessage({ type: 'error', message: error.message });
    }
  });
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain || process.parentPort) {
  startServer().catch((error) => {
    console.error('[bridge] startup error:', error.message);
    process.parentPort?.postMessage({ type: 'error', message: error.message });
    process.exitCode = 1;
  });
}

// Pure read-only test hooks: no enrollment, journal open, side effects or MCP exposure.
export const privateJournalTestHooks = Object.freeze({
  privateJournalFrame, replayPrivateJournal, reducePrivateQueueEvents,
  privateQueueDiagnosticCounts, privateReadinessState,
  privateRecipientPredecessors, privateScopeKey,
});