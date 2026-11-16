// MCP server <-> browser extension bridge.
//
//   Orchestrator chat --(MCP over HTTPS, via tunnel)--> POST /mcp/agent/<key>
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
import { createCallerIdentity } from './caller-identity.mjs';
import { createAgentBindingStore } from './agent-binding-store.mjs';
import { createIdempotencyLedger } from './idempotency.mjs';
import { createDurableIdempotencyLedger } from './durable-idempotency.mjs';
import { normalizeOpenChatTabs, annotateTabPresence } from './tab-presence.mjs';
import { createDiagnostics, classifyDiagnosticError } from './diagnostics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const EXTENSION_PROFILE_TOKEN=process.env.CHAT_ORCH_EXTENSION_PROFILE_TOKEN || '';
if(EXTENSION_PROFILE_TOKEN && !/^[a-f0-9]{64}$/i.test(EXTENSION_PROFILE_TOKEN))
  throw new Error('Invalid local profile connection secret; refuse to start');
const PUBLIC_PORT=process.env.CHAT_ORCH_PUBLIC_PORT == null
  ? null:Number(process.env.CHAT_ORCH_PUBLIC_PORT);
const PUBLIC_MCP_TOKEN=process.env.CHAT_ORCH_PUBLIC_MCP_TOKEN || '';
if (PUBLIC_PORT!==null && !/^[a-f0-9]{64}$/i.test(PUBLIC_MCP_TOKEN))
  throw new Error('Public MCP listener requires an independent 256-bit transport credential');
if (PUBLIC_PORT!==null &&
    (!Number.isSafeInteger(PUBLIC_PORT) || PUBLIC_PORT<1024 || PUBLIC_PORT>65535 ||
     PUBLIC_PORT===PORT)) {
  throw new Error('Public HTTP-only MCP port must be distinct from the local WebSocket port');
}
const diagnostics = createDiagnostics({component:'proxy'});

// Profile settings are independent of any proxy or browser-extension secret.
const AGENT_SETTINGS_FILE = path.join(
  process.env.CHAT_ORCH_SETTINGS_DIR || process.env.CHAT_ORCH_PROFILE_DIR || __dirname, 'settings.json'
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
const proxySessionId = crypto.randomUUID();
const bindingStore=(process.env.CHAT_ORCH_SETTINGS_DIR || process.env.CHAT_ORCH_PROFILE_DIR)
  ? createAgentBindingStore(path.dirname(AGENT_SETTINGS_FILE)) : null;
const callerIdentity = createCallerIdentity({
  onChange:(bindings)=>bindingStore?.save(bindings),
});
if(bindingStore) callerIdentity.restore(bindingStore.load());
const mcpIdempotency = createIdempotencyLedger();
let durableIdempotency = null;
const callerMeta = (extra) => ({
  session: extra?._meta?.['openai/session'],
  subject: extra?._meta?.['openai/subject'] || '',
});
function profileCredentialId(browserSessionId, tabId) {
  // Stable non-secret identity scoped to this app profile and browser manager tab.
  const hex = crypto.createHash('sha256')
    .update(path.dirname(AGENT_SETTINGS_FILE) + ':' + browserSessionId + ':' + tabId).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
function sameProfileManager(a, b) {
  return a?.credentialId === b?.credentialId &&
    a?.callerTabId === b?.callerTabId &&
    a?.browserSessionId === b?.browserSessionId &&
    a?.sessionIncarnationId === b?.sessionIncarnationId &&
    a?.connectionGeneration === b?.connectionGeneration &&
    a?.socketGeneration === b?.socketGeneration &&
    a?.socket === b?.socket;
}
function profilePrincipalFromExtension(a) {
  if (!a || !Number.isSafeInteger(a.tab_id) || a.tab_id <= 0 ||
      !PRIVATE_EVENT_ID.test(a.browser_session_id || '') ||
      !PRIVATE_EVENT_ID.test(a.incarnation_id || '') ||
      !Number.isSafeInteger(a.connection_generation) || a.connection_generation < 1)
    throw new Error('Extension could not attest the configured manager tab');
  const credentialId = profileCredentialId(a.browser_session_id,a.tab_id);
  const socket = extensionSockets.get(a.browser_session_id);
  if (!socket || socket.readyState !== 1 ||
      socket.connectionGeneration !== a.connection_generation)
    throw new Error('Attesting browser session changed during request');
  return Object.freeze({
    mode: 'profile', principalId:credentialId,credentialId,
    workspaceId: 'local-profile', projectId: 'local-profile',
    orchestratorId: 'local-profile', parentTaskId: 'local-profile',
    callerTabId: a.tab_id, browserSessionId: a.browser_session_id,
    sessionIncarnationId: a.incarnation_id,
    connectionGeneration: a.connection_generation,
    socketGeneration: a.connection_generation,
    socket,
  });
}


/** @param {PrincipalContext} principal @param {PrivateCoordinationScope} scope */
// Recheck the browser session/incarnation before acting on an asynchronous
// worker event so stale tab IDs are not accidentally reused.
function currentPrivatePrincipal(principal) {
  return Boolean(principal?.mode === 'profile' &&
    principal.socket?.readyState === 1 &&
    principal.socket.connectionGeneration === principal.socketGeneration &&
    extensionSockets.get(principal.browserSessionId) === principal.socket &&
    sameProfileManager(profileManagerIdentities.get(principal.browserSessionId + ':' + principal.callerTabId), principal) &&
    principal.credentialId === profileCredentialId(principal.browserSessionId,principal.callerTabId));
}

async function resolveCaller(args = {}, { createRoot = false } = {}, extra) {
  if (!tabRegistry) throw new Error('Proxy tab registry unavailable');
  const binding = callerIdentity.getByCredential(args.agent_credential);
  if (!binding) throw new Error('Unpaired Agent credential; use pair_conversation in the corresponding ChatGPT tab first');
  const tabId = binding.tabId;
  const browserSessionId = binding.browserSessionId;
  if (args.caller_tab_id != null && args.caller_tab_id !== tabId)
    throw new Error('Provided tab ID conflicts with paired conversation');
  if (args.browser_session_id != null && args.browser_session_id !== browserSessionId)
    throw new Error('Provided browser session conflicts with paired conversation');
  args.__sessionBrowserId = browserSessionId;
  await waitForExtensionReconnect(browserSessionId,extra?.signal);
  // An authenticated Extension has to reconcile approved live roots before
  // a restored credential may perform any operation after Proxy restart.
  const recovery=sessionRecoveryPromises.get(browserSessionId);
  if(recovery)await recovery;
  let record=tabRegistry.get(tabId,browserSessionId);
  const inspection = await callExtension('inspect_tab', {tab_id:tabId,
    __sessionBrowserId:browserSessionId},10000);
  if (inspection.incarnation_id !== binding.incarnationId ||
      inspection.route_hash !== binding.routeHash) {
    callerIdentity.revokeCredential(binding.agentCredential);
    throw new Error('Paired tab or conversation changed; re-pair the currently opened chat');
  }
  if (inspection.browser_session_id !== browserSessionId)
    throw new Error('Paired browser profile changed');
  diagnostics.debug('identity.inspected',{tabId,site:inspection.site,
    registryPresent:Boolean(record)});
  if (!record) {
    // A public MCP invocation must never silently promote a discovered tab.
    // Root enrollment is an explicit, user-approved pairing transaction.
    throw new Error('Unregistered caller: explicitly approve and pair this Parent in the extension');
  }
  if (record.browserSessionId !== browserSessionId) {
    throw new Error('Caller tab belongs to another browser session; pass the browser_session_id reported by list_tabs');
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
  const observed = await callExtension('attest_profile_manager', {
    tab_id:tabId,__sessionBrowserId:inspection.browser_session_id}, 10000);
  if (observed.tab_id !== inspection.tab_id ||
      observed.incarnation_id !== inspection.incarnation_id ||
      observed.browser_session_id !== inspection.browser_session_id) {
    diagnostics.warn('identity.attestation_mismatch',{tabId});
    throw new Error('Caller tab changed during attestation; retry only after reconciliation');
  }
  diagnostics.debug('identity.attestation_verified',{tabId,site:inspection.site});
  const principal = profilePrincipalFromExtension(observed);
  const managerKey=principal.browserSessionId + ':' + tabId;
  const old = profileManagerIdentities.get(managerKey);
  if (old && !sameProfileManager(old, principal)) {
    activePrivateManagers.delete(old.credentialId);
    privateManagerObservations.delete(old.credentialId);
    armedPrivateDelivery.delete(old.credentialId);
  }
  profileManagerIdentities.set(managerKey, principal);
  verifiedPrincipalContexts.add(principal);
  if (privateCoordinationEnabled && privateJournal) {
    // Re-enroll the verified tab after proxy/extension reconnect so its
    // existing durable queue can be inspected. Automatic delivery is the
    // default; an explicit user/Agent Pause still takes precedence.
    activePrivateManagers.set(principal.credentialId,principal);
    if(!pausedPrivateDelivery.has(principal.credentialId)){
      armedPrivateDelivery.add(principal.credentialId);
      setImmediate(pumpPrivateQueue);
    }
  }
  return principal;
}

// Local Desktop confirmation only. Do not rewrite or replay FIFO events.
const rootRepairOffers = new Map();
const rootRepairBusy = new Set();
async function inspectRootRepair(tabId, offer = false, requestedSessionId = null) {
  if (!Number.isSafeInteger(tabId) || tabId <= 0 || !tabRegistry || !bridgeConnected())
    throw new Error('Connected Proxy and valid tab required');
  const sessions=[...extensionSockets.keys()].filter((sessionId)=>
    (!requestedSessionId || requestedSessionId === sessionId) &&
    tabRegistry.get(tabId,sessionId)?.phase === 'root');
  if (sessions.length!==1) throw new Error('Root tab ID is missing or ambiguous across browser sessions');
  const browserSessionId=sessions[0];
  const saved = tabRegistry.get(tabId,browserSessionId);
  const live = await callExtension('inspect_tab', {tab_id:tabId,__sessionBrowserId:browserSessionId});
  const unresolved = privateJournal?.unresolvedForTab(tabId,browserSessionId) ?? [];
  const reasons = [];
  if (!saved || saved.parentTabId !== null || saved.phase !== 'root')
    reasons.push('NOT_REGISTERED_ROOT');
  if (live.is_managed_worker) reasons.push('MANAGED_WORKER');
  if (saved && saved.browserSessionId !== live.browser_session_id)
    reasons.push('BROWSER_SESSION_CHANGED');
  if (saved && saved.site !== live.site) reasons.push('SITE_CHANGED');
  if (tabRegistry.hasChildren(tabId,browserSessionId)) reasons.push('ROOT_HAS_DESCENDANTS');
  if (privateCoordinationEnabled && !privateJournal) reasons.push('JOURNAL_UNAVAILABLE');
  if (unresolved.length) reasons.push('UNRESOLVED_FIFO');
  const changed = Boolean(saved && saved.incarnationId !== live.incarnation_id);
  const eligible = reasons.length === 0 && changed;
  const repairKey=browserSessionId+':'+tabId;
  const response = {tab_id:tabId,browser_session_id:browserSessionId,site:live.site,can_reconcile:eligible,
    incarnation_changed:changed,reasons,has_descendants:tabRegistry.hasChildren(tabId,browserSessionId),
    unresolved_by_phase:unresolved.reduce((counts,item)=>{
      counts[item.phase]=(counts[item.phase]||0)+1;return counts;
    },{})};
  rootRepairOffers.delete(repairKey);
  if (!offer || !eligible) return response;
  const nonce = crypto.randomUUID();
  rootRepairOffers.set(repairKey,{nonce,expires:Date.now()+60000,
    oldIncarnation:saved.incarnationId,newIncarnation:live.incarnation_id,
    browserSessionId:live.browser_session_id,site:live.site});
  return {...response,confirmation_nonce:nonce};
}
async function reconcileRootFromDesktop(tabId, nonce, browserSessionId) {
  const repairKey=browserSessionId+':'+tabId;
  if (!PRIVATE_EVENT_ID.test(nonce || '') || rootRepairBusy.has(repairKey))
    throw new Error('Invalid or concurrent root recovery');
  const offer=rootRepairOffers.get(repairKey);
  rootRepairOffers.delete(repairKey);
  if (!offer || offer.nonce !== nonce || Date.now()>offer.expires)
    throw new Error('Expired or invalid recovery confirmation');
  rootRepairBusy.add(repairKey);
  try {
    const saved=tabRegistry.get(tabId,browserSessionId);
    const live=await callExtension('inspect_tab',{tab_id:tabId,
      __sessionBrowserId:saved?.browserSessionId},10000);
    const attested=await callExtension('attest_profile_manager',{tab_id:tabId,
      __sessionBrowserId:saved?.browserSessionId},10000);
    if (!saved || offer.browserSessionId !== browserSessionId ||
        saved.incarnationId !== offer.oldIncarnation ||
        saved.browserSessionId !== offer.browserSessionId || saved.site !== offer.site ||
        live.incarnation_id !== offer.newIncarnation ||
        attested.incarnation_id !== offer.newIncarnation ||
        live.browser_session_id !== offer.browserSessionId ||
        attested.browser_session_id !== offer.browserSessionId ||
        live.site !== offer.site || live.is_managed_worker ||
        live.tab_id !== tabId || attested.tab_id !== tabId ||
        tabRegistry.hasChildren(tabId,browserSessionId) ||
        (privateCoordinationEnabled && !privateJournal) ||
        (privateJournal?.unresolvedForTab(tabId,browserSessionId).length ?? 0)>0)
      throw new Error('Root changed or has unresolved events; recovery refused');
    await tabRegistry.reconcileRoot(live,offer.oldIncarnation,browserSessionId);
    profileManagerIdentities.delete(saved.browserSessionId + ':' + tabId);
    const key=profileCredentialId(saved.browserSessionId,tabId);
    activePrivateManagers.delete(key);
    armedPrivateDelivery.delete(key);
    privateManagerObservations.delete(key);
    diagnostics.info('identity.root_reconciled',{tabId,site:live.site});
    return {tab_id:tabId,reconciled:true,no_replay:true,no_ack:true};
  } finally { rootRepairBusy.delete(repairKey); }
}

function requireDirectChild(callerId, childId, sessionId) {
  if (!tabRegistry?.directChild(callerId, childId, sessionId)) {
    throw new Error('Target tab is not a direct child of the supplied caller tab');
  }
}

async function verifyDirectChild(callerId, childId, sessionId) {
  requireDirectChild(callerId,childId,sessionId);
  const record = tabRegistry.get(childId,sessionId);
  const live = await callExtension('inspect_tab',{tab_id:childId,
    __sessionBrowserId:record.browserSessionId},10000);
  if (live.incarnation_id !== record.incarnationId ||
      live.browser_session_id !== record.browserSessionId ||
      live.site !== record.site || live.is_managed_worker !== true) {
    throw new Error('Child tab was replaced, closed or changed incarnation');
  }
}

async function verifyLiveAncestry(tabId, sessionId) {
  let node = tabRegistry.get(tabId,sessionId);
  if (!node) throw new Error('Target Agent is not registered in the caller browser session');
  const pending=await callExtension('desktop_list_agent_closures',{
    __trustedDesktopConsent:true,__sessionBrowserId:sessionId,
  },10000).catch(()=>[]);
  const isPending=(record)=>pending.some((entry)=>
    entry.browserSessionId===sessionId &&
    entry.oldTabId===record.tabId &&
    entry.incarnationId===record.incarnationId &&
    entry.status==='pending');
  while (node && node.parentTabId !== null) {
    let current=null;
    try {current=await callExtension('inspect_tab',{
      tab_id:node.tabId,__sessionBrowserId:sessionId},10000);}
    catch(error) {if(!isPending(node))throw error;}
    if (current && (current.incarnation_id !== node.incarnationId ||
        current.browser_session_id !== sessionId || current.site !== node.site ||
        current.is_managed_worker !== true))
      throw new Error('Descendant tab incarnation or site changed; read/delegation denied');
    const parent = tabRegistry.get(node.parentTabId,sessionId);
    if (!parent || parent.incarnationId !== node.parentIncarnationId)
      throw new Error('Orphaned parent tab; new delegation is held for reconciliation');
    let observed=null;
    try {observed=await callExtension('inspect_tab',{tab_id:parent.tabId,
      __sessionBrowserId:parent.browserSessionId},10000);}
    catch(error) {if(!isPending(parent)) throw error;}
    if (observed && (observed.incarnation_id !== parent.incarnationId ||
        observed.browser_session_id !== parent.browserSessionId ||
        observed.site !== parent.site))
      throw new Error('Ancestor tab changed or closed; new delegation is held');
    node = parent;
  }
}

// Reattach only existing, still-live Child identities after a Proxy process
// restart. Never automatically replay a browser prompt or ACK a queue event.
async function reconstructLiveDescendants(parentTabId,browserSessionId,visited=new Set()) {
  if (visited.has(parentTabId) || visited.size>=200)
    throw new Error('Cannot reconcile cyclic or oversized Agent ancestry');
  visited.add(parentTabId);
  const ownerCredential=profileCredentialId(browserSessionId,parentTabId);
  const children=await callExtension('recover_owned_children',{
    __trustedRecovery:true,__sessionBrowserId:browserSessionId,
    owner_credential:ownerCredential,
  },12000);
  if (!Array.isArray(children)) throw new Error('Untrusted descendant recovery response');
  let attached=0,held=0;
  for (const live of children) {
    try {
      if (visited.has(live.tab_id) || live.browser_session_id!==browserSessionId ||
          live.is_managed_worker!==true) throw new Error('Changed Child ancestry');
      const prior=tabRegistry.get(live.tab_id,browserSessionId);
      if (prior && prior.parentTabId!==parentTabId)
        throw new Error('Child belongs to a different registered Parent');
      if (!prior) {
        await tabRegistry.registerChild(parentTabId,live);
        await tabRegistry.setPhase(live.tab_id,'reattached',browserSessionId);
        attached++;
      }
      const nested=await reconstructLiveDescendants(live.tab_id,browserSessionId,visited);
      attached+=nested.attached;
      held+=nested.held;
    } catch {
      held++;
      // Retain the browser tab for manual reconciliation; never invent a root.
    }
  }
  return {attached,held};
}

// Reattach only verified, still-open Parents/Children on authenticated
// extension reconnection. This creates no tabs, sends no prompts and ACKs
// no queued events.
const sessionRecoveryPromises=new Map();
async function reattachApprovedAgents(browserSessionId,socket) {
  if(!socket.profileAuthenticated || extensionSockets.get(browserSessionId)!==socket)
    return {attached:0,held:0,skipped:true};
  const inventory=await callExtension('inspect_all_tabs',{
    __sessionBrowserId:browserSessionId},12000);
  if(!Array.isArray(inventory)||inventory.length>200)
    throw new Error('Verified browser inventory unavailable');
  let attached=0,held=0;
  for(const item of inventory){
    if(item?.site!=='chatgpt'||item.parent_approved!==true||
        item.is_managed_worker!==false)continue;
    try {
      const live=await callExtension('inspect_tab',{
        tab_id:item.tab_id,__sessionBrowserId:browserSessionId},10000);
      if(extensionSockets.get(browserSessionId)!==socket ||
          live.browser_session_id!==browserSessionId ||
          live.incarnation_id!==item.incarnation_id ||
          live.site!=='chatgpt'||live.is_managed_worker||!live.parent_approved)
        throw new Error('Parent approval or tab incarnation changed');
      const prior=tabRegistry.get(item.tab_id,browserSessionId);
      if(prior&&(prior.incarnationId!==live.incarnation_id||prior.parentTabId!==null))
        throw new Error('Existing Parent ancestry differs');
      if(!prior){await tabRegistry.registerRoot(live);attached++;}
      const children=await reconstructLiveDescendants(item.tab_id,browserSessionId);
      attached+=children.attached;held+=children.held;
    }catch {held++;}
  }
  return {attached,held};
}

const preparingWorkerTabs = new Set(); // browser session + tab ID
// Browser tabs may defer SPA initialization until foregrounded. Serialize
// each prepare -> focus -> confirmed-submit handoff, not the worker's reply.
// Worker models continue generating independently after submission.
const spawnStartupSerial = {tail: Promise.resolve()};
// An ambiguous send must not let a later spawn steal focus from the tab that
// may still be submitting. The hold is session-scoped and never auto-retries
// the chat side effect. Manual reconciliation is required before restarting
// this Proxy session.
const spawnSubmissionHolds = new Map();
async function reconcileWorkerSubmission(principal,tabId,incarnationId,taskId=null) {
  // Only a read-only check of the ORIGINAL owned tab may release a held
  // startup. No focus changes, tab creation, or prompt replay.
  const inspected=await callExtension('inspect_tab',{tab_id:tabId,
    __sessionBrowserId:principal.browserSessionId},10000);
  if(inspected?.incarnation_id!==incarnationId ||
      inspected?.browser_session_id!==principal.browserSessionId ||
      inspected?.is_managed_worker!==true)
    return null;
  if(!taskId) {
    const inventory=await callExtension('inspect_worker_tasks',{
      tab_id:tabId,worker_incarnation_id:incarnationId,
      __trustedPrincipal:principal,__sessionBrowserId:principal.browserSessionId},10000);
    // A Child can pair and finish its task while the original spawn_worker
    // request is still waiting for a content ACK. If that transport reply
    // was lost, held.taskId is null and the only task may now be DONE.
    // Include terminal explicit completions as candidates; never guess if
    // the unchanged tab has more than one possible task.
    const candidates=(inventory?.tasks||[]).filter((item)=>
      ['running','uncertain','failed','done','waiting_for_children'].includes(item.status));
    if(candidates.length!==1)return null;
    taskId=candidates[0].task_id;
  }
  const proof=await callExtension('verify_worker_submission',{
    tab_id:tabId,task_id:taskId,worker_incarnation_id:incarnationId,
    __trustedPrincipal:principal,__sessionBrowserId:principal.browserSessionId},10000);
  return proof?.verified===true && proof?.submission_confirmed===true ? proof : null;
}
function serializeWorkerSpawn(operation) {
  const next = spawnStartupSerial.tail.then(operation);
  spawnStartupSerial.tail = next.catch(() => {});
  return next;
}
async function spawnAndBindWorker(args, principal) {
  return serializeWorkerSpawn(async () => {
    const held=spawnSubmissionHolds.get(principal.browserSessionId);
    if(held) {
      // The NEXT spawn may be invoked by the held Child (e.g. PM -> TL),
      // but the held task still belongs to its ORIGINAL spawning Parent.
      // Reconciliation must use that owner's live, attested credential scope,
      // never the unrelated caller's scope or a session-wide privilege.
      const owner=profileManagerIdentities.get(
        principal.browserSessionId+':'+held.ownerTabId);
      const originalOwnerValid=Boolean(owner &&
        owner.credentialId===held.ownerCredentialId &&
        owner.sessionIncarnationId===held.ownerIncarnationId &&
        currentPrivatePrincipal(owner) &&
        tabRegistry.get(held.ownerTabId,principal.browserSessionId)?.incarnationId===
          held.ownerIncarnationId);
      const proof=originalOwnerValid
        ? await reconcileWorkerSubmission(owner,
          held.tabId,held.incarnationId,held.taskId).catch(()=>null)
        : null;
      if(!proof) throw new Error('Spawn FIFO is HELD: worker tab '+held.tabId+
        ' has an unverified prompt submission. Inspect that tab and reconcile its task; '+
        'do not retry the prompt or launch another worker before resolving this session.');
      if(tabRegistry.get(held.tabId,principal.browserSessionId)?.phase==='uncertain')
        await tabRegistry.confirmSubmitted(held.tabId,held.incarnationId,principal.browserSessionId);
      else
        await tabRegistry.setPhase(held.tabId,'started',principal.browserSessionId);
      spawnSubmissionHolds.delete(principal.browserSessionId);
      diagnostics.info('worker.spawn_fifo_reconciled',{tabId:held.tabId,success:true});
    }
    return prepareAndStartWorker(args,principal);
  });
}
async function prepareAndStartWorker(args, principal) {
  // D-057: retain the adapter boundary, but never create an unsupported
  // provider tab in the ChatGPT-only first release.
  if (args.site !== 'chatgpt') {
    return {spawned:false,status:'PROVIDER_NOT_SUPPORTED',
      supported_providers:['chatgpt'],
      message:'This release supports ChatGPT workers only. Choose site "chatgpt".'};
  }
  await verifyLiveAncestry(principal.callerTabId,principal.browserSessionId);
  const callerRecord=tabRegistry.get(principal.callerTabId,principal.browserSessionId);
  const root = tabRegistry.get(callerRecord?.rootTabId,principal.browserSessionId);
  if (!root || root.parentTabId !== null || root.browserSessionId !== principal.browserSessionId)
    throw new Error('Root browser identity is unavailable for worker grouping');
  const taskText = args.saga_task_id == null ? args.task :
    args.task + '\n\nExternal tracking reference (optional, not an execution identity): Saga task #' + args.saga_task_id;
  const params = {...args,task:taskText,__trustedPrincipal:principal,
    __sessionBrowserId:principal.browserSessionId,
    __rootTabId:root.tabId,__rootIncarnationId:root.incarnationId,__defer_start:true,
    prompt_text:composeAgentPrompt(agentSettings,{
      kind:'task',operation:args.operation || 'task',task:taskText})};
  const prepared = await callExtension('spawn_worker',params);
  if (prepared?.prepared !== true || !Number.isSafeInteger(prepared.tab_id) ||
      !PRIVATE_EVENT_ID.test(prepared.incarnation_id || '')) {
    throw new Error('Worker preparation returned no attested tab; reconcile before retrying');
  }
  const preparationKey=principal.browserSessionId+':'+prepared.tab_id;
  if (preparingWorkerTabs.has(preparationKey))
    throw new Error('Worker tab already has a pending prepared task; reconcile before retrying');
  preparingWorkerTabs.add(preparationKey);
  let submissionDispatchIssued=false;
  let startupTaskId=null;
  try {
    const inspection = await callExtension('inspect_tab',{tab_id:prepared.tab_id,
      __trustedPrincipal:principal,__sessionBrowserId:principal.browserSessionId});
    if (inspection.incarnation_id !== prepared.incarnation_id)
      throw new Error('Prepared worker incarnation changed');
    const existing = tabRegistry.get(prepared.tab_id,principal.browserSessionId);
    if (existing) {
      await verifyDirectChild(principal.callerTabId,prepared.tab_id,principal.browserSessionId);
      if (prepared.reused_tab !== true ||
          !['started','reattached'].includes(existing.phase))
        throw new Error('Existing worker phase does not permit automatic reuse');
      await tabRegistry.setPhase(prepared.tab_id,'prepared',principal.browserSessionId);
    } else {
      if (prepared.reused_tab === true)
        throw new Error('Unregistered reusable worker requires manual reconciliation');
      await tabRegistry.registerChild(principal.callerTabId,inspection);
    }
    submissionDispatchIssued=true;
    let result = await callExtension('start_prepared_worker',{
      ...params,__defer_start:false,tab_id:prepared.tab_id,
      expected_incarnation_id:prepared.incarnation_id,reused_tab:prepared.reused_tab,
    });
    startupTaskId=result?.task_id || null;
    // An extension reply is not proof that ChatGPT accepted the message.
    // New children must provide an explicit, content-script-confirmed ACK.
    // Previously established role seats can be *queued* pending parent review;
    // that status is truthful, not a successful submission.
    const queuedReuse=prepared.reused_tab===true && result?.status==='queued';
    if(!queuedReuse && result?.submission_confirmed!==true &&
        result?.status==='uncertain' && startupTaskId) {
      // The page may reformat user text after the click and cause a false
      // confirmation timeout. Recheck the exact task UUID inside its user
      // turn before treating the startup as failed.
      const reconciled=await reconcileWorkerSubmission(principal,
        prepared.tab_id,prepared.incarnation_id,startupTaskId).catch(()=>null);
      if(reconciled)result={...result,...reconciled};
    }
    if(!queuedReuse && (result?.submission_confirmed!==true ||
        !['running','done','waiting_for_children','uncertain'].includes(result?.status))) {
      const definitelyNotSubmitted=result?.status==='failed' &&
        result?.submission_confirmed===false;
      const error=new Error(definitelyNotSubmitted
        ? 'Child prompt was NOT submitted; inspect the existing draft'
        : 'Child prompt submission was NOT verified; inspect the existing worker tab');
      error.code=definitelyNotSubmitted?'SUBMISSION_NOT_ATTEMPTED':'SUBMISSION_UNCERTAIN';
      throw error;
    }
    await tabRegistry.setPhase(prepared.tab_id,'started',principal.browserSessionId);
    return {...result,parent_tab_id:principal.callerTabId,
      root_tab_id:tabRegistry.get(prepared.tab_id,principal.browserSessionId).rootTabId};
  } catch (error) {
    const definitelyNotSubmitted = ['COMPOSER_DRAFT_MISMATCH','SUBMISSION_NOT_ATTEMPTED'].includes(error.code);
    if(submissionDispatchIssued && !definitelyNotSubmitted) {
      spawnSubmissionHolds.set(principal.browserSessionId,{
        tabId:prepared.tab_id,incarnationId:prepared.incarnation_id,taskId:startupTaskId,
        ownerTabId:principal.callerTabId,
        ownerCredentialId:principal.credentialId,
        ownerIncarnationId:principal.sessionIncarnationId});
      diagnostics.warn('worker.spawn_fifo_held',{tabId:prepared.tab_id,reason:'SUBMISSION_UNVERIFIED'});
    }
    if (tabRegistry.directChild(principal.callerTabId,prepared.tab_id,principal.browserSessionId) &&
        tabRegistry.get(prepared.tab_id,principal.browserSessionId)?.phase === 'prepared') {
      // A confirmed readiness refusal precedes task creation and any send
      // attempt. Keep this worker prepared for inspection; all other failures
      // may have submitted and must remain UNCERTAIN.
      if (!definitelyNotSubmitted)
        await tabRegistry.setPhase(prepared.tab_id,'uncertain',principal.browserSessionId).catch(()=>{});
    }
    throw new Error('Prepared worker tab ' + prepared.tab_id +
      (definitelyNotSubmitted ? ' not submitted; inspect its unsent draft before retrying: '
        : ' outcome UNCERTAIN; inspect the tab and registry before retrying: ') + error.message);
  } finally {
    preparingWorkerTabs.delete(preparationKey);
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
  const tabs = await callExtension('list_tabs', { __trustedPrincipal:principal,
    __sessionBrowserId:principal.browserSessionId });
  const worker = tabs.find((tab) => tab.tab_id === workerTabId && tab.role === 'worker');
  await verifyDirectChild(principal.callerTabId,workerTabId,principal.browserSessionId);
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
  'PROCESSED', 'SAGA_CONFIRMED', 'UNCERTAIN', 'RETRYING', 'SKIPPED',
]);
const PRIVATE_QUEUE_TERMINAL = new Set(['PROCESSED','SAGA_CONFIRMED','SKIPPED']);
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
      !PRIVATE_QUEUE_TERMINAL.has(item.phase));
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
    'phase', 'ref', 'entryType', 'leaseGeneration', 'leaseNonce', 'data', 'ack', 'saga', 'recovery',
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
  // An operator recovery never asserts that a model reviewed a message.
  // It is an auditable, explicitly confirmed delivery/skip decision.
  const recovery=payload.recovery;
  const expectedRecoveryKind=phase==='RETRYING' ? 'manual_retry'
    : phase==='SKIPPED' ? 'manual_skip'
    : phase==='DELIVERED' && recovery ? 'verified_user_turn'
    : phase==='UNCERTAIN' && recovery ? 'retry_unconfirmed' : null;
  if (recovery) {
    if (!prior || !expectedRecoveryKind ||
        Object.keys(recovery).sort().join(',')!=='at,batchId,eventRef,kind,principalId,reason' ||
        recovery.kind!==expectedRecoveryKind || recovery.eventRef!==ref ||
        recovery.batchId!==prior.leaseNonce ||
        recovery.principalId!==event.ownerScope.principalId ||
        typeof recovery.at!=='string' || !Number.isFinite(Date.parse(recovery.at)) ||
        typeof recovery.reason!=='string' || recovery.reason.trim().length<10 ||
        recovery.reason.length>512)
      throw new Error('Invalid explicit queue recovery evidence');
  } else if (phase==='RETRYING' || phase==='SKIPPED') {
    throw new Error('Manual queue recovery requires durable evidence');
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
        !PRIVATE_QUEUE_TERMINAL.has(item.phase);
    });
    if (staleIncarnation) throw new Error('Private recipient incarnation requires reconciliation');
  } else {
    if (!prior || prior.recipientKey !== recipientKey || prior.sourceKey !== sourceKey) {
      throw new Error('Private queue transition references stale recipient/source incarnation');
    }
    if (prior.recovered && !recovery) {
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
          !PRIVATE_QUEUE_TERMINAL.has(item.phase));
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
      (phase === 'UNCERTAIN' && (prior.phase === 'DISPATCHING' || prior.phase === 'DELIVERED')) ||
       (recovery?.kind==='manual_retry' && ['UNCERTAIN','DISPATCHING'].includes(prior.phase)) ||
       (recovery?.kind==='manual_skip' &&
         ['LEASED','DISPATCHING','DELIVERED','UNCERTAIN','RETRYING'].includes(prior.phase)) ||
       (recovery?.kind==='verified_user_turn' &&
         ['LEASED','DISPATCHING','DELIVERED','UNCERTAIN','RETRYING'].includes(prior.phase)) ||
       (recovery?.kind==='retry_unconfirmed' && prior.phase==='RETRYING')
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
      } else if (item.phase === 'DISPATCHING' || item.phase === 'DELIVERED' ||
                 item.phase === 'RETRYING') {
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
    phases.DELIVERED + phases.UNCERTAIN + phases.RETRYING;
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
  const profileDir = process.env.CHAT_ORCH_JOURNAL_DIR ||
    process.env.CHAT_ORCH_PROFILE_DIR;
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
      unresolvedForTab: (tabId,_sessionId) => queueState.fifo
        .map((key) => queueState.byRef.get(key))
        .filter((item) => item.recipientTabId === tabId &&
          !PRIVATE_QUEUE_TERMINAL.has(item.phase))
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
const extensionSockets = new Map(); // browser-session ID -> live extension socket
const pending = new Map(); // id -> { resolve, reject, timer, ws }
let bridge = null; // most recently active socket for legacy calls
let sessionHeartbeatTimer = null;
const bridgeConnected = () => [...extensionSockets.values()].some((ws) => ws.readyState === 1);
// D-029/D-030: only in-flight, authenticated MCP calls may wait for an
// extension. A client abort or deadline removes the waiter; no offline
// operation is persisted or later dispatched.
const extensionReconnectionWaiters=new Map();
function extensionSessionReady(browserSessionId) {
  const ws=extensionSockets.get(browserSessionId);
  return Boolean(ws && ws.readyState===1 && ws.profileReady===true);
}
function waitForExtensionReconnect(browserSessionId,signal,timeoutMs=55000) {
  if(extensionSessionReady(browserSessionId))return Promise.resolve();
  if(signal?.aborted)return Promise.reject(new Error('MCP request cancelled before bridge dispatch'));
  return new Promise((resolve,reject)=>{
    let settled=false;
    const waiters=extensionReconnectionWaiters.get(browserSessionId)||new Set();
    extensionReconnectionWaiters.set(browserSessionId,waiters);
    const cleanup=()=>{
      waiters.delete(complete);
      if(!waiters.size)extensionReconnectionWaiters.delete(browserSessionId);
      clearTimeout(timer);
      signal?.removeEventListener?.('abort',cancel);
    };
    const complete=(error)=>{
      if(settled)return;
      settled=true;cleanup();
      if(error)reject(error);else resolve();
    };
    const cancel=()=>complete(new Error('MCP request cancelled before bridge dispatch'));
    const timer=setTimeout(()=>complete(new Error(
      'Extension did not reconnect before the active MCP request deadline')),timeoutMs);
    waiters.add(complete);
    signal?.addEventListener?.('abort',cancel,{once:true});
    if(extensionSessionReady(browserSessionId))complete();
  });
}
function notifyExtensionReady(browserSessionId) {
  if(!extensionSessionReady(browserSessionId))return;
  for(const done of [...(extensionReconnectionWaiters.get(browserSessionId)||[])])
    done();
}

function extensionSocketFor(params = {}) {
  const principal = params.__trustedPrincipal;
  if (principal?.mode === 'profile') {
    const ws = extensionSockets.get(principal.browserSessionId);
    if (!ws || ws.readyState !== 1 || ws !== principal.socket ||
        ws.connectionGeneration !== principal.socketGeneration) {
      throw new Error('The browser session for this caller is disconnected. Reconnect the matching extension.');
    }
    return ws;
  }
  if (params.__sessionBrowserId) {
    const selected = extensionSockets.get(params.__sessionBrowserId);
    if (!selected || selected.readyState !== 1)
      throw new Error('Selected browser session is disconnected or unknown');
    return selected;
  }
  const sockets = [...extensionSockets.values()].filter((ws) => ws.readyState === 1);
  if (sockets.length === 1) return sockets[0];
  throw new Error(sockets.length
    ? 'Multiple browser sessions are connected; provide a verified caller tab.'
    : 'The browser extension is not connected. Open its popup and check the WebSocket URL.');
}

function callExtension(method, params = {}, timeoutMs = 120000) {
  const liveSockets=[...extensionSockets.values()].filter((ws)=>ws.readyState===1);
  if (method==='list_tabs' && params.__discoveryOnly===true && !params.__sessionBrowserId && liveSockets.length>1) {
    return Promise.all(liveSockets.map((ws)=>callExtension(method,
      {...params,__sessionBrowserId:ws.browserSessionId},timeoutMs)))
      .then((groups)=>groups.flatMap((group,index)=>group.map((tab)=>({...tab,
        browser_session_id:liveSockets[index].browserSessionId}))));
  }
  if (method==='inspect_tab' && params.__sessionBrowserId == null && liveSockets.length>1) {
    return Promise.allSettled(liveSockets.map((ws)=>callExtension(method,
      {...params,__sessionBrowserId:ws.browserSessionId},timeoutMs)))
      .then((results)=>{
        const matches=results.filter((result)=>result.status==='fulfilled' &&
          result.value?.tab_id===params.tab_id);
        if (matches.length===1) return matches[0].value;
        if (matches.length>1) throw new Error('Caller tab ID exists in multiple browser sessions; choose session from list_tabs');
        throw results.find((result)=>result.status==='rejected')?.reason ||
          new Error('Caller tab ID was not found in any connected browser session');
      });
  }
  return new Promise((resolve, reject) => {
    let socket;
    try { socket = extensionSocketFor(params); }
    catch (error) { reject(error); return; }
    const id = crypto.randomUUID();
    const startedAt = Date.now();
    diagnostics.debug('bridge.request',{method,requestId:id,tabId:params.tab_id});
    const timer = setTimeout(() => {
      pending.delete(id);
      diagnostics.warn('bridge.timeout',{method,requestId:id,durationMs:Date.now()-startedAt});
      reject(new Error(`Extension call "${method}" timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    pending.set(id, {
      ws:socket,
      resolve:(result)=>{
        diagnostics.debug('bridge.response',{method,requestId:id,
          durationMs:Date.now()-startedAt,success:true});
        if (method==='list_tabs' && Array.isArray(result)) {
          result=result.map((tab)=>({...tab,browser_session_id:socket.browserSessionId}));
        } else if (method==='inspect_tab' && result && typeof result==='object') {
          result={...result,browser_session_id:socket.browserSessionId};
        }
        resolve(result);
      },
      reject:(error)=>{
        diagnostics.warn('bridge.response',{method,requestId:id,
          durationMs:Date.now()-startedAt,success:false,
          errorClass:classifyDiagnosticError(error)});
        reject(error);
      },timer,
    });
    try { socket.send(JSON.stringify({ type: 'call', id, method, params })); }
    catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

function failSocketPending(socket, reason) {
  for (const [id, request] of pending) {
    if (request.ws !== socket) continue;
    clearTimeout(request.timer);
    request.reject(new Error(reason));
    pending.delete(id);
  }
}

function failAllPending(reason) {
  for (const [id, request] of pending) {
    clearTimeout(request.timer);
    request.reject(new Error(reason));
    pending.delete(id);
  }
}

function bindExtensionSocket(ws, browserSessionId) {
  const previous = extensionSockets.get(browserSessionId);
  ws.browserSessionId = browserSessionId;
  ws.connectionGeneration = ws.requestedConnectionGeneration;
  ws.lastHeartbeatAt = Date.now();
  extensionSockets.set(browserSessionId, ws);
  bridge = ws;
  // Inform the trusted Desktop whenever socket ownership changes, including
  // a fast replacement between health polling intervals. Never export a
  // browser enrollment ID or connection secret over this event.
  process.parentPort?.postMessage({type:'extension_session_changed'});
  diagnostics.info('bridge.connected',{socketGeneration:ws.connectionGeneration});
  if (previous && previous !== ws) {
    callerIdentity.disconnect(previous);
    failSocketPending(previous,'This browser session reconnected; prior call outcome may be uncertain');
    previous.close(4000,'same browser session reconnected');
  }
  ws.on('close', () => {
    callerIdentity.disconnect(ws);
    if (extensionSockets.get(browserSessionId) !== ws) return;
    extensionSockets.delete(browserSessionId);
    if (bridge === ws) bridge = [...extensionSockets.values()].at(-1) || null;
    process.parentPort?.postMessage({type:'extension_session_changed'});
    failSocketPending(ws,'Browser extension session disconnected during call');
    for (const [managerKey, principal] of profileManagerIdentities) {
      if (principal.socket !== ws) continue;
      profileManagerIdentities.delete(managerKey);
      activePrivateManagers.delete(principal.credentialId);
      privateManagerObservations.delete(principal.credentialId);
      armedPrivateDelivery.delete(principal.credentialId);
    }
    diagnostics.warn('bridge.disconnected',{socketGeneration:ws.connectionGeneration});
  });
}

function sendExtensionSettings(ws) {
  if (ws?.readyState !== 1 || !trustedExtensionSockets.has(ws)) return;
  ws.send(JSON.stringify({type:'settings_snapshot',schema:1,
    revision:agentSettingsRevision,settings:agentSettings}));
}

function sendSessionHeartbeat() {
  const now = Date.now();
  for (const ws of extensionSockets.values()) {
    if (ws.readyState !== 1) continue;
    if (now - (ws.lastHeartbeatAt || now) > 60000) {
      diagnostics.warn('bridge.heartbeat_timeout',{socketGeneration:ws.connectionGeneration});
      ws.terminate();
      continue;
    }
    try {
      ws.send(JSON.stringify({type:'session_heartbeat',nonce:crypto.randomUUID(),
        proxy_session_id:proxySessionId}));
    } catch { ws.terminate(); }
  }
}

function resetExtensionSessionState() {
  // Durable capabilities survive a Proxy restart. Every use still re-attests
  // its live browser/incarnation, and a missing tab registry blocks execution
  // until authenticated extension recovery reconstructs approved ancestry.
  callerIdentity.clear({preserveBindings:true});
  profileSocketGeneration++;
  profileManagerIdentities.clear();
  activePrivateManagers.clear();
  privateManagerObservations.clear();
  armedPrivateDelivery.clear();
  pausedPrivateDelivery.clear();
  rootRepairOffers.clear();
  rootRepairBusy.clear();
  tabRegistry = createSessionTabRegistry();
}

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  let handshakeComplete = false;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'register_session') {
      const sessionId = msg.browser_session_id;
      if(EXTENSION_PROFILE_TOKEN) {
        const supplied=typeof msg.profile_token==='string' &&
          /^[a-f0-9]{64}$/i.test(msg.profile_token)
          ? Buffer.from(msg.profile_token,'hex') : Buffer.alloc(32);
        const expected=Buffer.from(EXTENSION_PROFILE_TOKEN,'hex');
        if(!crypto.timingSafeEqual(supplied,expected)) {
          ws.close(4002,'unpaired browser profile');
          return;
        }
      }
      if (!PRIVATE_EVENT_ID.test(sessionId || '') ||
          !Number.isSafeInteger(msg.connection_generation) || msg.connection_generation < 1) {
        ws.close(4002,'invalid browser session handshake');
        return;
      }
      if (handshakeComplete) return;
      handshakeComplete = true;
      ws.profileAuthenticated=Boolean(EXTENSION_PROFILE_TOKEN);
      ws.profileInstallId=PRIVATE_EVENT_ID.test(msg.profile_install_id||'')
        ? msg.profile_install_id : null;
      ws.browserProduct=['edge','chrome'].includes(msg.browser_product)
        ? msg.browser_product : null;
      ws.extensionVersion=/^\d+\.\d+\.\d+$/.test(msg.extension_version||'')
        ? msg.extension_version : null;
      ws.requestedConnectionGeneration=msg.connection_generation;
      // A stale client must not reset unrelated browser profiles. The session
      // acknowledgement lets only this extension clear its own old state.
      bindExtensionSocket(ws,sessionId);
      ws.send(JSON.stringify({type:'session_registered',session_id:sessionId,
        connection_generation:msg.connection_generation,queue_enabled:privateCoordinationEnabled && Boolean(privateJournal),
        proxy_session_id:proxySessionId}));
      // Settings arrive only after the extension has checked whether its old
      // proxy session needs resetting; never let an old socket overwrite it.
      console.log('[bridge] extension session registered');
      return;
    }
    if (!handshakeComplete || extensionSockets.get(ws.browserSessionId) !== ws) return;
    if (msg.type === 'session_ready') {
      ws.profileReady=true;
      sendExtensionSettings(ws);
      const recovery=reattachApprovedAgents(ws.browserSessionId,ws)
        .catch((error)=>{
          diagnostics.warn('identity.restore_held',{
            errorClass:classifyDiagnosticError(error)});
          return {attached:0,held:1};
        }).finally(()=>{
          if(sessionRecoveryPromises.get(ws.browserSessionId)===recovery)
            sessionRecoveryPromises.delete(ws.browserSessionId);
        });
      sessionRecoveryPromises.set(ws.browserSessionId,recovery);
      notifyExtensionReady(ws.browserSessionId);
      return;
    }
    if (msg.type === 'session_heartbeat_ack') {
      ws.lastHeartbeatAt = Date.now();
      return;
    }
    if (msg.type === 'session_heartbeat') {
      ws.lastHeartbeatAt = Date.now();
      ws.send(JSON.stringify({type:'session_heartbeat_ack',nonce:msg.nonce,
        proxy_session_id:proxySessionId}));
      return;
    }
    handleExtensionMessage(ws,msg);
  });
  ws.on('error',()=>{});
  const handshakeTimeout=setTimeout(()=>{
    if (!handshakeComplete) ws.close(4002,'browser session handshake timed out');
  },10000);
  handshakeTimeout.unref?.();
  ws.once('close',()=>clearTimeout(handshakeTimeout));
});

function handleExtensionMessage(ws,msg) {
  if (extensionSockets.get(ws.browserSessionId) !== ws) return;
  if (msg.type === 'settings_applied') {
    if (trustedExtensionSockets.has(ws) && msg.revision === agentSettingsRevision) {
      if(msg.routing_capability==='connector_name_routing_v1' &&
          msg.connector_name===agentSettings.connectorName) {
        ws.routingVerifiedRevision=msg.revision;
        ws.routingVerifiedName=msg.connector_name;
        process.parentPort?.postMessage({type:'agent_settings_synced',revision:msg.revision,
          browserSessionId:ws.browserSessionId});
      } else {
        ws.routingVerifiedRevision=0;
        ws.routingVerifiedName=null;
        process.parentPort?.postMessage({type:'agent_settings_routing_mismatch',
          browserSessionId:ws.browserSessionId});
      }
    }
    return;
  }
  if (msg.type === 'ping') {
    ws.send(JSON.stringify({type:'pong'}));
    return;
  }
  if (msg.type === 'pairing_offer') {
    if (!PRIVATE_EVENT_ID.test(msg.request_id || '')) return;
    if(agentSettings.connectorName &&
        (ws.routingVerifiedRevision!==agentSettingsRevision ||
         ws.routingVerifiedName!==agentSettings.connectorName)) {
      if(ws.readyState===1) ws.send(JSON.stringify({type:'pairing_offer_ack',
        request_id:msg.request_id,ok:false,
        error:'Connector name not verified by the connected extension. Reload the bundled extension and wait for settings sync before pairing.'}));
      return;
    }
    void (async () => {
      const live = await callExtension('inspect_tab', {
        tab_id:msg.tab_id,__sessionBrowserId:ws.browserSessionId},10000);
      if (live.incarnation_id !== msg.incarnation_id ||
          live.route_hash !== msg.route_hash ||
          live.browser_session_id !== ws.browserSessionId ||
          extensionSockets.get(ws.browserSessionId) !== ws)
        throw new Error('Pairing browser tab did not match');
      if (live.is_managed_worker) {
        const managed=tabRegistry?.get(live.tab_id,ws.browserSessionId);
        if (!managed || managed.parentTabId === null ||
            managed.incarnationId !== live.incarnation_id)
          throw new Error('Only a registered, owned Child may pair as a Child');
      } else if (live.parent_approved !== true) {
        throw new Error('A user-approved Parent is required for root pairing');
      }
      callerIdentity.offer({code:msg.code,browserSessionId:ws.browserSessionId,
        tabId:msg.tab_id,incarnationId:msg.incarnation_id,
        routeHash:msg.route_hash,socket:ws});
    })().then(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({type:'pairing_offer_ack',
        request_id:msg.request_id,ok:true}));
    }).catch(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({type:'pairing_offer_ack',
        request_id:msg.request_id,ok:false,error:'Browser tab pairing could not be verified'}));
    });
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
    void acceptPrivateWorkerLoss({...msg,browser_session_id:ws.browserSessionId}).then((receipt) => {
      if (ws.readyState === 1 && extensionSockets.get(ws.browserSessionId) === ws)
        ws.send(JSON.stringify({type:'worker_event_receipt',request_id:msg.request_id,ok:true,receipt}));
    }).catch(() => {
      if (ws.readyState === 1 && extensionSockets.get(ws.browserSessionId) === ws)
        ws.send(JSON.stringify({type:'worker_event_receipt',request_id:msg.request_id,ok:false,
          error:'Durable lost-child event unavailable; reconcile without blind replay'}));
    });
    return;
  }
  if (msg.type === 'worker_done') {
    if (!PRIVATE_EVENT_ID.test(msg.request_id || '')) return;
    void acceptPrivateWorkerCompletion({...msg,browser_session_id:ws.browserSessionId}).then((receipt) => {
      if (ws.readyState === 1 && extensionSockets.get(ws.browserSessionId) === ws)
        ws.send(JSON.stringify({type:'worker_event_receipt',request_id:msg.request_id,ok:true,receipt}));
    }).catch(() => {
      if (ws.readyState === 1 && extensionSockets.get(ws.browserSessionId) === ws)
        ws.send(JSON.stringify({type:'worker_event_receipt',request_id:msg.request_id,ok:false,
          error:'Durable worker receipt unavailable; reconcile without replay'}));
    });
    return;
  }
  if (msg.type === 'result') {
    const request=pending.get(msg.id);
    if (!request || request.ws !== ws) return;
    clearTimeout(request.timer);
    pending.delete(msg.id);
    if (msg.ok) request.resolve(msg.result);
    else {
      const error = new Error(msg.error || 'extension error');
      if (msg.error_code === 'COMPOSER_DRAFT_MISMATCH') error.code = msg.error_code;
      request.reject(error);
    }
  }
}

// ------------------------------------------------- private producer/manager API
// Manager registration is volatile and reset on extension restart or proxy restart.
const activePrivateManagers = new Map(); // browser-session/tab key -> manager context
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
  const observation = await callExtension('manager_state', {
    __trustedPrincipal:principal,__sessionBrowserId:principal.browserSessionId});
  if (!currentPrivatePrincipal(principal)) throw new Error('Configured manager tab changed during registration');
  rememberPrivateManagerReadiness(principal, observation);
  activePrivateManagers.set(principal.credentialId, principal);
  if(!pausedPrivateDelivery.has(principal.credentialId)){
    armedPrivateDelivery.add(principal.credentialId);
    setImmediate(pumpPrivateQueue);
  }
  return { registered: true, manager_tab_id: principal.callerTabId,
    observation: observation.state, storage_ready: true };
}

// Closure is an internal worker lifecycle decision, not a Saga board operation.
// Optional Saga references remain external reporting metadata only.
// Closure is controlled by the parent and internal worker task UUIDs. Saga
// references are optional external metadata, never a gate or ownership key.
async function closeReviewedWorker(principal, args) {
  const worker = tabRegistry.get(args.tab_id,principal.browserSessionId);
  if (!worker || worker.parentTabId !== principal.callerTabId ||
      !['started','reattached'].includes(worker.phase)) {
    throw new Error('Worker is not in a closable state; reconcile it first');
  }
  if (tabRegistry.hasChildren(args.tab_id,principal.browserSessionId))
    throw new Error('Worker has descendants; close or reconcile them first');
  const inspected = await callExtension('inspect_worker_tasks', {
    __trustedPrincipal:principal,__sessionBrowserId:principal.browserSessionId,
    tab_id:args.tab_id,worker_incarnation_id:worker.incarnationId,
  });
  if (inspected?.tab_id !== args.tab_id ||
      inspected.worker_incarnation_id !== worker.incarnationId ||
      !Array.isArray(inspected.tasks) || inspected.tasks.length === 0 ||
      inspected.tasks.some((task)=>!PRIVATE_EVENT_ID.test(task.task_id || '') ||
        !['done','failed'].includes(task.status) ||
        task.parent_reviewed !== true)) {
    throw new Error('Worker tasks are missing, unresolved or awaiting explicit Parent review');
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
  await verifyDirectChild(principal.callerTabId,args.tab_id,principal.browserSessionId);
  if (privateCoordinationEnabled && privateJournal) registeredPrivateManager(principal);
  else if (!currentPrivatePrincipal(principal))
    throw new Error('Parent tab changed during close review');
  return callExtension('close_reviewed_worker',{
    __trustedPrincipal:principal,__sessionBrowserId:principal.browserSessionId,
    tab_id:args.tab_id,worker_incarnation_id:worker.incarnationId,parent_reviewed:true,
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

async function enqueuePrivateStatus(principal, idempotencyKey, summary,originParentUrl=null) {
  const active = registeredPrivateManager(principal);
  const scope = privateManagerScope(active);
  if (typeof summary !== 'string' || summary.length > 4000) {
    throw new Error('Invalid status request summary');
  }
  const origin=verifiedParentConversationRoute(originParentUrl);
  const record = await privateJournal.append(active, scope, 'queue.transition', {
    phase: 'QUEUED', entryType: 'STATUS_REQUEST', leaseGeneration: 0,
    leaseNonce: null, data: { summary,originParentUrl:origin },
  }, idempotencyKey);
  return { event_id: record.id, seq: record.seq, state: 'QUEUED' };
}

// The Child's right to notify its direct Parent comes from the attested
// hierarchy, not from the Parent having recently invoked an MCP tool. A busy
// or temporarily inactive Parent chat must not cause a clarification to vanish.
// Register the *existing* live Parent as the durable FIFO recipient, without
// changing any Parent approval, pairing credential or tab ancestry.
async function directParentRecipient(child) {
  const childRecord=tabRegistry.get(child.callerTabId,child.browserSessionId);
  const parentTabId=childRecord?.parentTabId;
  if(!parentTabId || !tabRegistry.directChild(parentTabId,child.callerTabId,child.browserSessionId))
    throw new Error('Only a managed Child may notify its direct Parent');
  await verifyLiveAncestry(child.callerTabId,child.browserSessionId);
  if(!privateCoordinationEnabled || !privateJournal)
    throw new Error('Direct Parent event queue unavailable; Child task remains pending');
  const parentRecord=tabRegistry.get(parentTabId,child.browserSessionId);
  const live=await callExtension('inspect_tab',{
    tab_id:parentTabId,__sessionBrowserId:child.browserSessionId},10000);
  if(!parentRecord || live.tab_id!==parentTabId ||
      live.incarnation_id!==parentRecord.incarnationId ||
      live.browser_session_id!==child.browserSessionId ||
      live.site!==parentRecord.site ||
      (parentRecord.parentTabId===null && live.parent_approved!==true) ||
      (parentRecord.parentTabId!==null && live.is_managed_worker!==true))
    throw new Error('Direct Parent tab is not currently approved and verified');
  const current=profileManagerIdentities.get(child.browserSessionId+':'+parentTabId);
  if(current && currentPrivatePrincipal(current))return current;
  const observed=await callExtension('attest_profile_manager',{
    tab_id:parentTabId,__sessionBrowserId:child.browserSessionId},10000);
  if(observed.tab_id!==parentTabId ||
      observed.incarnation_id!==parentRecord.incarnationId ||
      observed.browser_session_id!==child.browserSessionId)
    throw new Error('Direct Parent identity changed during notification enrollment');
  const parent=profilePrincipalFromExtension(observed);
  const key=child.browserSessionId+':'+parentTabId;
  const previous=profileManagerIdentities.get(key);
  if(previous && !sameProfileManager(previous,parent)){
    activePrivateManagers.delete(previous.credentialId);
    privateManagerObservations.delete(previous.credentialId);
    armedPrivateDelivery.delete(previous.credentialId);
  }
  profileManagerIdentities.set(key,parent);
  verifiedPrincipalContexts.add(parent);
  activePrivateManagers.set(parent.credentialId,parent);
  if(!pausedPrivateDelivery.has(parent.credentialId))
    armedPrivateDelivery.add(parent.credentialId);
  return parent;
}

// Child asks only its direct Parent. The existing FIFO status event is used
// instead of opening a sibling channel or copying the Parent transcript.
async function requestParentContext(child, question, idempotencyKey,taskId=null) {
  const parent=await directParentRecipient(child);
  const parentTabId=parent.callerTabId;
  const held=await callExtension('hold_child_for_context',{
    __trustedPrincipal:child,__sessionBrowserId:child.browserSessionId,
    task_id:taskId},12000);
  if(held.tab_id!==child.callerTabId ||
      held.status!=='WAITING_FOR_PARENT_CONTEXT')
    throw new Error('Child task could not be marked pending clarification');
  const summary=JSON.stringify({kind:'CHILD_CONTEXT_REQUEST',
    child_tab_id:child.callerTabId,parent_tab_id:parentTabId,
    original_task_id:held.task_id,question,source:'direct_child'});
  const result=await enqueuePrivateStatus(parent,idempotencyKey,summary,
    held.origin_parent_url);
  if (armedPrivateDelivery.has(parent.credentialId))
    void pumpOnePrivateManager(parent);
  return {...result,parent_tab_id:parentTabId,
    original_task_id:held.task_id,task_status:'WAITING_FOR_PARENT_CONTEXT',
    task_completed:false,auto_context_transferred:false};
}

// D-073: a Child may message its direct Parent, just as a Parent may message
// its direct Child. Parent-bound messages join the existing FIFO journal,
// rather than inventing a new background chat/task or sibling messaging path.
async function sendDirectParentMessage(child,text,idempotencyKey) {
  if(typeof text!=='string' || !text.trim() || text.length>3000)
    throw new Error('Direct Parent message must contain 1–3000 characters');
  const parent=await directParentRecipient(child);
  const summary=JSON.stringify({kind:'CHILD_MESSAGE',
    child_tab_id:child.callerTabId,parent_tab_id:parent.callerTabId,
    message:text,source:'direct_child'});
  const result=await enqueuePrivateStatus(parent,idempotencyKey,summary);
  if(armedPrivateDelivery.has(parent.credentialId))
    void pumpOnePrivateManager(parent);
  return {...result,tab_id:parent.callerTabId,queued_for:'direct_parent',
    sent:false,task_created:false};
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
  if (packet.browser_session_id !== active.browserSessionId)
    throw new Error('Worker completion came from a different browser session');
  const task = await callExtension('get_result', {
    task_id: packet.task_id, __trustedPrincipal: active,
    __sessionBrowserId:active.browserSessionId,
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
    originParentUrl:task.origin_parent_url ?? null,
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
  if (packet.resolution != null &&
      !['UNVERIFIED','INTENTIONALLY_CLOSED','DETACHED'].includes(packet.resolution))
    throw new Error('Invalid user closure outcome');
  const url = new URL(packet.saved_url);
  if (url.protocol !== 'https:' ||
      !['chatgpt.com','chat.openai.com','claude.ai','gemini.google.com'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Unsafe child conversation URL');
  }
  const principal = activePrivateManagers.get(packet.credential_id);
  if (!principal) throw new Error('Parent manager not registered');
  const active = registeredPrivateManager(principal);
  if (packet.browser_session_id !== active.browserSessionId)
    throw new Error('Child-loss receipt came from a different browser session');
  const task = await callExtension('get_result',{__trustedPrincipal:active,
    __sessionBrowserId:active.browserSessionId,task_id:packet.task_id});
  if (task.tab_id !== packet.tab_id ||
      task.source_incarnation_id !== packet.worker_incarnation_id ||
      !['done','failed','detached'].includes(task.status)) {
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
      closureResolution:packet.resolution||'UNVERIFIED',
      originalTaskStatus:task.status,
      reason:'Tab removed or unavailable; browser cause not proven'},
  },packet.event_key);
  return {event_id:record.id,seq:record.seq,state:'QUEUED',durably_recorded:true};
}

// A manager opts into automatic wake only after its token-verified registration.
// This volatile arm state deliberately vanishes on restart; no blind replay.
const armedPrivateDelivery = new Set();
const pausedPrivateDelivery = new Set();
const privateDispatching = new Set();
const privateRecoveryInFlight = new Set(); // Desktop operations never race a manager wake.
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
    origin_parent_url:data.originParentUrl || null,
    full_report_ref:original.id,result_sha256:data.resultSha256,
    result_preview:text.slice(0,3000),preview_truncated:text.length>3000,
  });
}

function verifiedParentConversationRoute(value) {
  if (value == null) return null;
  if (typeof value!=='string' || value.length>180) throw new Error('Invalid Parent conversation route');
  let parsed;
  try {parsed=new URL(value);} catch {throw new Error('Invalid Parent conversation route');}
  if (parsed.protocol!=='https:' || parsed.hostname!=='chatgpt.com' ||
      parsed.port || parsed.username || parsed.password ||
      parsed.search || parsed.hash ||
      !/^\/c\/[a-z0-9-]{20,80}\/?$/i.test(parsed.pathname))
    throw new Error('Parent notification route must be a supported ChatGPT conversation URL');
  return parsed.origin+parsed.pathname;
}

// The only recovery entry point for a held manager batch. Never reconstruct a
// different set of events, silently drop history, or accept browser page text as
// proof. Caller identity is the currently paired, local-profile manager.
async function recoverPrivateManagerBatch(principal,batchId,action,reason='') {
  const active=registeredPrivateManager(principal);
  if(!PRIVATE_EVENT_ID.test(batchId||'') ||
      !['recheck','retry_draft','skip'].includes(action))
    throw new Error('Invalid queue recovery action or batch ID');
  if(action==='skip' && (typeof reason!=='string' || reason.trim().length<10 ||
      reason.length>512))
    throw new Error('Skipping requires a meaningful operator reason (10–512 characters)');
  if(privateDispatching.has(active.credentialId) ||
      privateRecoveryInFlight.has(active.credentialId))
    throw new Error('Manager delivery/recovery already in progress');
  privateRecoveryInFlight.add(active.credentialId);
  try {
    const scope=privateManagerScope(active);
    const all=privateJournal.queueState(active,scope);
    const pending=all
      .filter(item=>!PRIVATE_QUEUE_TERMINAL.has(item.phase));
    if(!pending.length || pending[0].leaseNonce!==batchId)
      throw new Error('Recovery must target the oldest unresolved FIFO batch');
    const items=pending.filter(item=>item.leaseNonce===batchId);
    const batchItems=all.filter(item=>item.leaseNonce===batchId);
    if(!items.length || !batchItems.length || batchItems.length>16 ||
        pending.slice(0,items.length).some((item,i)=>item.ref!==items[i].ref) ||
        items.some(item=>!['LEASED','DISPATCHING','DELIVERED','UNCERTAIN','RETRYING'].includes(item.phase)))
      throw new Error('Recovery batch is incomplete or does not match the FIFO prefix');
    const recorded=privateJournal.replay(active,scope);
    const originals=new Map(recorded.filter(item=>item.kind==='queue.transition' &&
      item.payload.phase==='QUEUED').map(item=>[item.id,item]));
    // Even if a crash interrupted a multi-item recovery, the original
    // delivered composer draft describes the COMPLETE leased batch.
    const events=batchItems.map(item=>{
      const original=originals.get(item.ref);
      if(!original)throw new Error('Original durable event is missing');
      return {event_id:original.id,type:item.entryType,
        summary:privateQueueSummary(original),recorded_at:original.recordedAt};
    });
    const origins=[...new Set(batchItems.map(item=>verifiedParentConversationRoute(
      originals.get(item.ref).payload.data?.originParentUrl)))];
    if(origins.length!==1)throw new Error('Recovery batch has mixed destination conversations');
    let prompt=null;
    try {
      prompt=composeAgentPrompt(agentSettings,{kind:'queue',batchId,events});
    } catch(error) {
      // Prompt module settings may change after the original lease. An
      // operator must still be able to skip, without fabricating text.
      if(action!=='skip')throw error;
    }
    const ext={__trustedPrincipal:active,__sessionBrowserId:active.browserSessionId,
      manager_tab_id:active.callerTabId,batch_id:batchId,
      prompt_text:prompt,origin_parent_url:origins[0]};
    const reconcileLedger=async(status)=>{
      try {
        const value=await callExtension('resolve_manager_recovery',
          {...ext,status},10000);
        return value?.recorded===true;
      }catch{return false;}
    };
    const observe=async()=> {
      const result=await callExtension('inspect_manager_batch',ext,15000);
      if(result?.ok!==true)throw new Error('Cannot verify original Parent conversation: '+
        (result?.reason||'unavailable'));
      return result;
    };
    const writePhase=async(phase,kind,operatorReason)=>{
      for(const item of items) {
        if(item.phase===phase)continue;
        const original=originals.get(item.ref);
        await privateJournal.append(active,privateRecordedScope(active,original),'queue.transition',{
          phase,ref:item.ref,leaseGeneration:item.leaseGeneration,leaseNonce:batchId,
          recovery:{kind,eventRef:item.ref,batchId,principalId:active.principalId,
            at:new Date().toISOString(),reason:operatorReason},
        },crypto.randomUUID());
      }
    };
    if(action==='skip'){
      await writePhase('SKIPPED','manual_skip',reason.trim());
      // The durable skip precedes any UI cleanup. Deleting a draft must never
      // be mistaken for an ACK, and a failed cleanup must not restore/replay it.
      const cleanup=prompt===null?{ok:false,reason:'PROMPT_SETTINGS_CHANGED'}
        : await callExtension('clear_skipped_manager_batch',ext,15000)
          .catch(()=>({ok:false,reason:'BROWSER_UNAVAILABLE'}));
      const ledgerSynced=await reconcileLedger('processed');
      setImmediate(pumpPrivateQueue);
      return {phase:'SKIPPED',batch_id:batchId,skipped:items.map(item=>item.ref),
        retained_in_journal:true,automatically_delivered:false,
        ledger_synced:ledgerSynced,draft_cleared:cleanup?.cleared===true,
        draft_cleanup_required:cleanup?.ok!==true || (
          cleanup?.draftPresent===true && cleanup?.cleared!==true)};
    }
    const observed=await observe();
    if(observed.verified){
      if(!items.every(item=>item.phase==='DELIVERED'))
        await writePhase('DELIVERED','verified_user_turn',
          'Exact batch marker verified inside a submitted user turn');
      const ledgerSynced=await reconcileLedger('submitted');
      return {phase:'DELIVERED',batch_id:batchId,verified:true,
        ledger_synced:ledgerSynced,awaiting_manager_ack:true};
    }
    if(action==='recheck')
      return {phase:items[0].phase,batch_id:batchId,verified:false,
        matchingDraft:observed.matchingDraft===true,requires_manual_choice:true};
    if(items.some(item=>item.phase==='DELIVERED'))
      throw new Error('Previously delivered batch requires manager ACK, not a retry');
    if(recorded.some(item=>item.kind==='queue.transition' &&
      item.payload?.phase==='RETRYING' && item.payload.leaseNonce===batchId))
      throw new Error('This batch already had one explicit retry. Recheck or Skip; do not resubmit a possibly sent message');
    if(!observed.matchingDraft || observed.accountChanged ||
        observed.generating || !observed.documentReady)
      throw new Error('Retry refused: exact original draft is not present in an idle Parent tab');
    await writePhase('RETRYING','manual_retry',
      'Operator approved one attempt to submit the matching existing draft');
    let submitted=false;
    try {
      const outcome=await callExtension('retry_manager_batch',ext,45000);
      submitted=outcome?.submitted===true && outcome?.uncertain!==true;
    } catch { /* An attempted submit can have lost its receipt; do not replay. */ }
    await writePhase(submitted?'DELIVERED':'UNCERTAIN',
      submitted?'verified_user_turn':'retry_unconfirmed',
      submitted?'Batch marker verified inside a submitted user turn':
        'Retry attempted; browser submission result remains unverified');
    const ledgerSynced=submitted?await reconcileLedger('submitted'):false;
    return {phase:submitted?'DELIVERED':'UNCERTAIN',batch_id:batchId,
      submitted,ledger_synced:ledgerSynced,
      requires_manual_choice:!submitted,awaiting_manager_ack:submitted};
  } finally {privateRecoveryInFlight.delete(active.credentialId);}
}

async function pumpOnePrivateManager(principal) {
  if (!privateCoordinationEnabled || !privateJournal ||
      !armedPrivateDelivery.has(principal.credentialId) ||
      privateDispatching.has(principal.credentialId) ||
      privateRecoveryInFlight.has(principal.credentialId)) return;
  privateDispatching.add(principal.credentialId);
  diagnostics.debug('fifo.pump_started',{callerTabId:principal.callerTabId});
  try {
    registeredPrivateManager(principal); // Rechecks revocation on every wake.
    const managerScope = privateManagerScope(principal);
    let pendingQueue = privateJournal.queueState(principal, managerScope)
      .filter((item) => !PRIVATE_QUEUE_TERMINAL.has(item.phase));
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
    let originParentUrl = null;
    for (const item of batchItems) {
      const original = firstEvents.get(item.ref);
      if (!original) throw new Error('Queued event source missing from durable journal');
      const requestedOrigin=verifiedParentConversationRoute(
        original.payload.data?.originParentUrl);
      // Never mix notification destinations in one FIFO batch. An event
      // without a known origin must not silently inherit another origin.
      if (events.length && requestedOrigin!==originParentUrl) break;
      if (!events.length) originParentUrl=requestedOrigin;
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
    const ready = await callExtension('manager_state', {
      __trustedPrincipal:principal,__sessionBrowserId:principal.browserSessionId});
    rememberPrivateManagerReadiness(principal, ready);
    // D-056: navigation back to the delegation-origin conversation is
    // explicitly approved even when the *other* currently shown chat is busy.
    // Only bypass the idle gate for a verified, different origin route; the
    // extension rechecks the destination and its idle state before sending.
    const returningToOrigin=Boolean(originParentUrl &&
      ready.conversation_route && ready.conversation_route!==originParentUrl);
    if (!returningToOrigin && (ready.ready !== true || ready.state !== 'idle')) {
      diagnostics.debug('fifo.parent_not_ready',{callerTabId:principal.callerTabId,batchId,
        status:ready.state});
      return;
    }
    // An await above may have admitted another producer: revalidate this
    // exact oldest prefix before writing even the first lease.
    pendingQueue = privateJournal.queueState(principal, managerScope)
      .filter((item) => !PRIVATE_QUEUE_TERMINAL.has(item.phase));
    if (events.some((event, i) =>
      pendingQueue[i]?.ref !== event.event_id || pendingQueue[i].phase !== 'QUEUED')) return;

    // Original source identity was verified at enrollment; a completed worker
    // may close before its immutable result reaches the manager.
    const scopes = events.map((event) =>
      privateRecordedScope(principal, firstEvents.get(event.event_id)));
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
        __trustedPrincipal:principal,__sessionBrowserId:principal.browserSessionId,
        manager_tab_id:principal.callerTabId,
        batch_id:batchId,events,origin_parent_url:originParentUrl,
        prompt_text:composeAgentPrompt(agentSettings,{kind:'queue',batchId,events}),
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
  if(privateRecoveryInFlight.has(principal.credentialId))
    throw new Error('Queue recovery in progress; retry ACK after reconciliation');
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
    __trustedPrincipal:active,__sessionBrowserId:active.browserSessionId,batch_id:batchId,
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
  return async (args,extra) => {
    const startedAt = Date.now();
    const traceId=crypto.randomUUID();
    diagnostics.debug('mcp.call_started',{traceId,method,callerTabId:args?.caller_tab_id,
      tabId:args?.tab_id});
    try {
      if (args?.browser_session_id) args.__sessionBrowserId=args.browser_session_id;
      const caller = await resolveCaller(args,{},extra);
      args.caller_tab_id = caller.callerTabId;
      args.__sessionBrowserId = caller.browserSessionId;
      let result;
      if (method === 'spawn_worker') {
        result = await spawnAndBindWorker(args,caller);
      } else if (method === 'reopen_child') {
        const callerRecord=tabRegistry.get(caller.callerTabId,caller.browserSessionId);
        const root=tabRegistry.get(callerRecord?.rootTabId,caller.browserSessionId);
        if (!root || root.parentTabId !== null ||
            root.browserSessionId !== caller.browserSessionId)
          throw new Error('Root browser identity unavailable for child recovery');
        result = await callExtension(method,{...args,__trustedPrincipal:caller,
          __sessionBrowserId:caller.browserSessionId,
          __rootTabId:root.tabId,__rootIncarnationId:root.incarnationId});
        if (Number.isSafeInteger(result?.tab_id)) {
          const inspected = await callExtension('inspect_tab',{tab_id:result.tab_id,
            __trustedPrincipal:caller,__sessionBrowserId:caller.browserSessionId});
          await tabRegistry.registerChild(caller.callerTabId,inspected);
          await tabRegistry.setPhase(result.tab_id,'reattached',caller.browserSessionId);
          result = {...result,parent_tab_id:caller.callerTabId,
            root_tab_id:tabRegistry.get(result.tab_id,caller.browserSessionId).rootTabId};
        }
      } else {
        const target = args?.tab_id;
        const callerRecord=tabRegistry.get(caller.callerTabId,caller.browserSessionId);
        const directedToParent=method==='send_to_tab' &&
          target===callerRecord?.parentTabId && target!=null;
        if (method === 'send_to_tab' || (method === 'read_chat' && target != null)) {
          if (target !== caller.callerTabId) {
            if (method === 'read_chat') {
              if (!tabRegistry.within(caller.callerTabId,target,caller.browserSessionId))
                throw new Error('Read target is not a descendant of this caller');
              await verifyLiveAncestry(target,caller.browserSessionId);
              args.__ancestorRead = true; // already authorized in Proxy; read-only
            } else if (!directedToParent)
              await verifyDirectChild(caller.callerTabId,target,caller.browserSessionId);
          }
        }
        if (method === 'send_to_tab' && !directedToParent &&
            !['started','reattached'].includes(tabRegistry.get(target,caller.browserSessionId)?.phase))
          throw new Error('Worker is prepared or UNCERTAIN; reconcile before another message');
        if(directedToParent){
          result=await sendDirectParentMessage(caller,args.text,args.idempotency_key);
        } else if (method === 'list_tabs') {
          const tabs = await callExtension('list_tabs',{__trustedPrincipal:caller,
            __sessionBrowserId:caller.browserSessionId,__descendantDiscovery:true});
          result = tabs.filter(t=>{
            if (t.tab_id === caller.callerTabId) return true;
            if (!tabRegistry.within(caller.callerTabId,t.tab_id,caller.browserSessionId)) return false;
            const known=tabRegistry.get(t.tab_id,caller.browserSessionId);
            return t.incarnation_id === known?.incarnationId && t.site === known.site && t.role==='worker';
          })
            .map(t=>({...t,parent_tab_id:tabRegistry.get(t.tab_id,caller.browserSessionId)?.parentTabId ?? null,
              root_tab_id:tabRegistry.get(t.tab_id,caller.browserSessionId)?.rootTabId ?? null}));
        } else result = await callExtension(method,{...args,__trustedPrincipal:caller,
          __sessionBrowserId:caller.browserSessionId});
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
    'Optional bounded wait in seconds (max 50). If the task is still running, keep its task_id and yield your assistant response. Completion arrives by orchestrator notification; do not poll for status.'
  );

function buildServer(principal) {
  const callerTabInput = z.number().int().positive().optional()
    .describe('Optional assertion; caller tab is determined from the paired MCP conversation.');
  const browserSessionInput=z.string().uuid().optional()
    .describe('browser_session_id returned with list_tabs when multiple browser profiles are connected.');
  const server = new McpServer({ name: 'chat-orchestrator', version: '0.1.0' });
  // Every public and private MCP tool shares a single admission barrier.
  // Same-key retries get the exact first response, including an encrypted,
  // bounded operational read snapshot. No general transcript archive exists.
  const originalRegister=server.registerTool.bind(server);
  server.registerTool=(name,config,handler)=>originalRegister(name,{
    ...config,
    inputSchema:{...config.inputSchema,
      agent_credential:z.string().regex(/^[a-f0-9]{64}$/i).optional().describe(
        'Opaque credential issued by pair_conversation in this exact Agent tab. Required for every tool except initial pairing.'),
      idempotency_key:z.string().uuid().describe(
        'Required UUID generated by the caller. Use a fresh key for each logical request, including each fresh read. Reuse the same key only when retrying the identical request.')},
  },async (args,extra)=>{
    try {
      if(name==='pair_conversation') {
        // Replaying a pairing response after restart would disclose a revoked
        // credential. Pairing offers are deliberately process-local.
        return await mcpIdempotency.execute(
          'pair:'+args.code,name,args,()=>handler(args,extra));
      }
      const binding=callerIdentity.getByCredential(args.agent_credential);
      if(!binding)throw new Error('Missing or revoked Agent credential; pair this tab first');
      // Verify the live role/incarnation on EVERY call BEFORE serving any
      // encrypted cached response, including status/read-only calls.
      await resolveCaller(args,{},extra);
      const scope=JSON.stringify([binding.browserSessionId,binding.tabId,
        binding.incarnationId]);
      return await (durableIdempotency||mcpIdempotency).execute(scope,name,args,
        ()=>handler(args,extra));
    } catch(error) {return errorResult(error);}
  });

  server.registerTool('pair_conversation', {
    description:'Bind this ChatGPT conversation to the browser tab selected in the extension popup. Requires a fresh single-use pairing code.',
    inputSchema:{code:z.string().uuid()},
  },async (args,extra)=>{
    try {
      const identity=callerMeta(extra);
      const offer=callerIdentity.peek(args.code);
      const socket=extensionSockets.get(offer.browserSessionId);
      if (!socket || socket !== offer.socket || socket.readyState !== 1)
        throw new Error('Original extension socket disconnected; generate another pairing code');
      const live=await callExtension('inspect_tab', {tab_id:offer.tabId,
        __sessionBrowserId:offer.browserSessionId},10000);
      if (live.incarnation_id !== offer.incarnationId || live.route_hash !== offer.routeHash)
        throw new Error('Pairing tab changed before approval');
      const existing=tabRegistry.get(live.tab_id,offer.browserSessionId);
      if (live.is_managed_worker) {
        if (!existing || existing.parentTabId === null ||
            existing.incarnationId !== live.incarnation_id)
          throw new Error('Only an already-owned managed Child can pair as a Child Agent');
        await verifyLiveAncestry(live.tab_id,offer.browserSessionId);
      } else if (!live.parent_approved || (existing && existing.parentTabId !== null)) {
        throw new Error('Parent tab must be explicitly approved by the user before pairing');
      }
      const bound=callerIdentity.bind({...identity,code:args.code});
      try {
        if (!existing) await tabRegistry.registerRoot(live);
      } catch (error) {
        callerIdentity.revokeCredential(bound.agentCredential);
        throw error;
      }
      let recovery={attached:0,held:0};
      if (!live.is_managed_worker) {
        try {
          recovery=await reconstructLiveDescendants(live.tab_id,offer.browserSessionId);
        } catch {
          recovery={attached:0,held:null,reconciliation_required:true};
        }
      } else {
        // The one-time offer was issued only for this live owned Child tab.
        // An authenticated Child that consumed it must have received its
        // setup prompt, even if ChatGPT's DOM rewrites hid the user turn
        // from the content-script's 12-second confirmation poll. Reconcile
        // the ORIGINAL task without another browser click or prompt.
        try {
          const proof=await callExtension('confirm_child_pairing_submission',{
            tab_id:live.tab_id,worker_incarnation_id:live.incarnation_id,
            __sessionBrowserId:offer.browserSessionId,
            __verifiedChildPairing:true},10000);
          diagnostics.event(proof?.verified?'info':'warn',
            'worker.pairing_submission_reconciled',{
              tabId:live.tab_id,verified:proof?.verified===true});
        } catch (error) {
          // Pairing itself is already valid; retain the uncertain FIFO gate
          // until an authenticated completion or user-turn readback proves
          // this Child's delivery. Never replay the original prompt.
          diagnostics.warn('worker.pairing_submission_evidence_deferred',{
            tabId:live.tab_id,errorClass:classifyDiagnosticError(error)});
        }
      }
      return textResult({paired:true,tab_id:bound.tabId,
        browser_session_id:bound.browserSessionId,agent_id:bound.agentId,
        agent_credential:bound.agentCredential,recovery,
        no_browser_prompt_replayed:true});
    } catch (error) {return errorResult(error);}
  });

  server.registerTool(
    'list_tabs',
    {
      title: 'List chat tabs',
      description:
        'List open chat tabs across connected browser profiles. Each result includes tab_id, browser_session_id, site, title and role. When multiple profiles are connected, pass browser_session_id to scope later calls.',
      inputSchema: {caller_tab_id:callerTabInput.optional(),browser_session_id:browserSessionInput},
    },
    forward('list_tabs', principal)
  );

  server.registerTool(
    'spawn_worker',
    {
      title: 'Start a worker chat',
      description:
        'Open or reuse a worker chat under caller_tab_id. Returns an internal task_id. After delegating all intended work, finish your assistant response and yield; child completions arrive through orchestrator notifications. Do NOT continuously poll get_result while waiting. Review each notified result and send fixing tasks with send_to_tab as needed. Saga references are optional metadata, never worker identities or closure gates. Close only when parent-owned work is terminal and all required result receipts are processed.',
      inputSchema: {
        caller_tab_id:callerTabInput,
        browser_session_id:browserSessionInput,
        saga_task_id:z.number().int().positive().optional()
          .describe('Optional external Saga tracking reference; not a worker identifier or closure prerequisite.'),
        site: z.enum(['chatgpt', 'claude', 'gemini']).default('chatgpt').describe(
          'ChatGPT is the only available provider in v1. Claude/Gemini requests return PROVIDER_NOT_SUPPORTED without spawning.'),
        operation: z.enum(['task','workspace','delegation']).optional().describe('Operation-specific instructions to include.'),
        role: z.string().trim().min(1).max(128).optional()
          .describe('Optional reusable seat label; any project role is allowed. This is metadata, never authorization or an injected role prompt.'),
        role_scope: z.string().trim().min(1).max(128).optional()
          .describe('Reusable profile-local seat label from your skill/task context. Same label and scope reuse the same idle chat; the proxy imposes no role hierarchy.'),
        task: z
          .string()
          .min(1)
          .describe('Self-contained instructions for the worker. Include all the context it needs.'),
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
      inputSchema:{caller_tab_id:callerTabInput,browser_session_id:browserSessionInput,
        task_id:z.string().uuid().describe('Original task_id from CHILD_TAB_LOST notification.')},
    },
    forward('reopen_child',principal)
  );
  server.registerTool(
    'send_to_tab',
    {
      title: 'Send a follow-up to an existing worker tab',
      description:
        'Send to a direct Child or direct Parent only. Child-bound messages return a task_id for get_result. Child-to-Parent messages enter the Parent FIFO event queue and return QUEUED with event_id, not a new task_id.',
      inputSchema: {
        caller_tab_id:callerTabInput,
        browser_session_id:browserSessionInput,
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
        'Get the status/result of a task started by spawn_worker or send_to_tab for an explicit status request or recovery. Can wait up to wait_seconds (max 50). If still running, do NOT poll repeatedly: finish the assistant response and await the orchestrator completion notification.',
      inputSchema: {
        caller_tab_id:callerTabInput,
        browser_session_id:browserSessionInput,
        task_id: z.string().describe('The task_id returned earlier.'),
        wait_seconds: waitSeconds,
      },
    },
    forward('get_result', principal)
  );
  server.registerTool('complete_task',{
    title:'Child Agent: explicitly complete my assigned task',
    description:'Call from the paired Child Agent only after own work is ready. Completion is held until descendants finish and are reviewed. Does not close tabs or claim substantive correctness.',
    inputSchema:{
      caller_tab_id:callerTabInput,
      browser_session_id:browserSessionInput,
      task_id:z.string().uuid().optional().describe('Assigned task ID; required if more than one task could match.'),
      summary:z.string().trim().min(1).max(1200).optional().describe('Brief own-work completion summary; full content stays in browser chat.'),
    },
  },forward('complete_task',principal));
  server.registerTool('review_task', {
    title:'Confirm Parent review of a Child task',
    description:'After inspecting a terminal Child result, explicitly mark its task reviewed. Only then may that same Child begin its next queued independent task.',
    inputSchema:{
      caller_tab_id:callerTabInput,browser_session_id:browserSessionInput,
      tab_id:z.number().int().positive(),
      task_id:z.string().uuid(),
    },
  },async (args,extra)=>{
    try {
      const caller=await resolveCaller(args,{},extra);
      await verifyDirectChild(caller.callerTabId,args.tab_id,caller.browserSessionId);
      const result=await callExtension('review_task',{
        ...args,__trustedPrincipal:caller,__sessionBrowserId:caller.browserSessionId,
      });
      return textResult(result);
    } catch(error) {return errorResult(error);}
  });
  server.registerTool('request_parent_context', {
    title:'Ask the direct Parent for missing task context',
    description:'Child retains its current task. The Proxy notifies its direct Parent through the existing ordered event queue; Parent responds using send_to_tab.',
    inputSchema:{caller_tab_id:callerTabInput,browser_session_id:browserSessionInput,
      task_id:z.string().uuid().optional().describe('Original Child task ID; required if more than one task might be active.'),
      question:z.string().trim().min(1).max(3500)},
  },async(args,extra)=>{
    try {
      const caller=await resolveCaller(args,{},extra);
      return textResult(await requestParentContext(caller,args.question,args.idempotency_key,args.task_id));
    } catch(error) {return errorResult(error);}
  });
  server.registerTool(
    'read_chat',
    {
      title: 'Read a chat transcript',
      description:
        'Read an authorized ChatGPT conversation using the site conversation API where available, with DOM fallback. Reasoning is excluded by default; image and attachment names can be included.',
      inputSchema: {
        caller_tab_id:callerTabInput,
        browser_session_id:browserSessionInput,
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
        browser_session_id:browserSessionInput,
        tab_id: z.number().int().describe('tab_id of the worker to close.'),
        // Saga IDs are external task metadata, never a closure prerequisite.
      },
    },
    async (args) => {
      try {
        const caller = await resolveCaller(args);
        await verifyDirectChild(caller.callerTabId,args.tab_id,caller.browserSessionId);
        if (tabRegistry.hasChildren(args.tab_id,caller.browserSessionId))
          throw new Error('Child has descendants; close or reconcile them before closing this tab');
        const result = await closeReviewedWorker(caller,args);
        if (result?.closed === args.tab_id) await tabRegistry.remove(args.tab_id,caller.browserSessionId);
        return textResult(result);
      } catch (error) { return errorResult(error); }
    }
  );

  // Conditional private API: never present in the standard six-tool endpoint.
  if (privateCoordinationEnabled && privateJournal) {
    server.registerTool('coordination_inspect_worker_tasks', {
      title: 'Recover task identifiers from an owned worker',
      description: 'Read-only task IDs and statuses for a verified direct child. Never retries work.',
      inputSchema: {caller_tab_id:callerTabInput,browser_session_id:browserSessionInput,
        tab_id:z.number().int().positive()},
    }, async (args) => {
      try {
        const caller = await resolveCaller(args);
        await verifyDirectChild(caller.callerTabId,args.tab_id,caller.browserSessionId);
        const worker = tabRegistry.get(args.tab_id,caller.browserSessionId);
        return textResult(await callExtension('inspect_worker_tasks', {
          __trustedPrincipal:caller,tab_id:args.tab_id,
          worker_incarnation_id:worker.incarnationId,
        }));
      } catch (error) { return errorResult(error); }
    });
    server.registerTool('coordination_register_manager', {
      title: 'Register profile manager for private queue',
      description: 'Register the caller tab as a queue recipient without selecting a global manager. No replay on restart.',
      inputSchema: {caller_tab_id:callerTabInput,browser_session_id:browserSessionInput},
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
        browser_session_id:browserSessionInput,
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
      inputSchema: {caller_tab_id:callerTabInput,browser_session_id:browserSessionInput},
    }, async (args) => {
      try {
        const caller = await resolveCaller(args);
        registeredPrivateManager(caller);
        pausedPrivateDelivery.delete(caller.credentialId);
        armedPrivateDelivery.add(caller.credentialId);
        setImmediate(pumpPrivateQueue);
        return textResult({ armed: true, no_replay: true });
      } catch (error) { return errorResult(error); }
    });
    server.registerTool('coordination_pause_delivery', {
      title: 'Pause private manager wake',
      description: 'Stop new batch dispatch for this credential; already submitted batch remains unresolved.',
      inputSchema: {caller_tab_id:callerTabInput,browser_session_id:browserSessionInput},
    }, async (args) => {
      try {
        const caller = await resolveCaller(args);
        pausedPrivateDelivery.add(caller.credentialId);
        armedPrivateDelivery.delete(caller.credentialId);
        return textResult({ armed: false });
      } catch (error) { return errorResult(error); }
    });
    server.registerTool('coordination_ack_batch', {
      title: 'Explicitly acknowledge processed private batch',
      description: 'Call only after handling every ordered event. This records consumer ACK, NOT independently verified Saga completion.',
      inputSchema: {
        caller_tab_id:callerTabInput,
        browser_session_id:browserSessionInput,
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
      inputSchema: {caller_tab_id:callerTabInput,browser_session_id:browserSessionInput,
        event_id:z.string().uuid()},
    }, async (args) => {
      try { return textResult(getPrivateFullReport(await resolveCaller(args), args.event_id)); }
      catch (error) { return errorResult(error); }
    });
    server.registerTool('coordination_pending', {
      title: 'Read own private queue state',
      description: 'Read-only queue phases for the current profile; does not release UNCERTAIN items or perform Saga updates.',
      inputSchema: {caller_tab_id:callerTabInput,browser_session_id:browserSessionInput},
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
      inputSchema: {caller_tab_id:callerTabInput,browser_session_id:browserSessionInput},
    }, async (args) => {
      try {
        const active = await resolveCaller(args,{createRoot:true});
        return textResult(privateJournal.incarnationConflicts(active, privateManagerScope(active)));
      } catch (error) { return errorResult(error); }
    });
    server.registerTool('coordination_get_predecessor_event', {
      title:'Inspect a historical recipient event',
      description:'Read-only verified data for an unresolved prior incarnation. Does not deliver, process or ACK it.',
      inputSchema:{caller_tab_id:callerTabInput,browser_session_id:browserSessionInput,
        event_id:z.string().uuid()},
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
        browser_session_id:browserSessionInput,
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
let currentCompletionAlerts = [];
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
    browserSessionId:profile.browserSessionId,
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
            browserSessionId: principal.browserSessionId,
            batchId: event.leaseNonce,
            principalId: principal.principalId,
            seq: event.firstSeq,
          });
        }
      } catch { /* Owner may be revoked or journal under reconciliation. */ }
    }
  }
  const visiblePending = queue.filter((item) =>
    !PRIVATE_QUEUE_TERMINAL.has(item.phase)).length;
  const hiddenPending = Math.max(0, (aggregate?.pending || 0) - visiblePending);
  // Keep the oldest blocked item of EVERY recipient visible, even when more
  // than 30 later events accumulated. The UI must never lose its recovery
  // controls simply because the FIFO grew.
  const firstPending=new Map();
  for(const item of queue) {
    if(PRIVATE_QUEUE_TERMINAL.has(item.phase))continue;
    const key=item.browserSessionId+':'+item.managerTabId+':'+item.principalId;
    if(!firstPending.has(key))firstPending.set(key,item);
  }
  const selectedQueue=[...new Map([...firstPending.values(),...queue.slice(-30)]
    .map(item=>[item.eventId,item])).values()].sort((a,b)=>a.seq-b.seq);
  const savedHierarchy=tabRegistry?.list().map(({tabId,parentTabId,rootTabId,site,phase,browserSessionId})=>({
    tabId,parentTabId,rootTabId,site,phase,browserSessionId,
  })) || [];
  return {
    storageReady: privateCoordinationEnabled && Boolean(privateJournal),
    deliveryEnabledByDefault: false, registryError, hiddenPending,
    extensionConnected: Boolean(bridgeConnected()),
    browserTabs:currentBrowserTabs,
    completionAlerts:currentCompletionAlerts,
    tabHierarchy:annotateTabPresence(savedHierarchy,currentBrowserTabs),
    seats, phases, queue: selectedQueue,
    toolCalls: privateToolHistory.slice(-25),
    generatedAt: new Date().toISOString(),
  };
}
async function refreshDashboard() {
  if (dashboardRefreshInFlight) return;
  dashboardRefreshInFlight=true;
  try {
    if (!bridgeConnected()) {
      currentBrowserTabs={status:'unavailable',tabs:[],observedAt:null};
      currentCompletionAlerts=[];
    } else {
      // Read-only tab discovery. This must never attest/register identities,
      // change durable relationships, or acknowledge/replay queued work.
      const discovered=await callExtension('list_tabs',{__discoveryOnly:true},2500);
      currentBrowserTabs={
        status:'observed',
        tabs:normalizeOpenChatTabs(discovered),
        observedAt:new Date().toISOString(),
      };
      const profiles=[...extensionSockets.values()].filter((socket)=>
        socket.readyState===1&&socket.profileAuthenticated);
      const monitors=await Promise.allSettled(profiles.map(async(socket)=>{
        const tasks=await callExtension('desktop_completion_status',{
          __trustedDesktopConsent:true,__sessionBrowserId:socket.browserSessionId},3500);
        return Array.isArray(tasks)?tasks.map((item)=>({
          ...item,browser_session_id:socket.browserSessionId})): [];
      }));
      currentCompletionAlerts=monitors.flatMap((item)=>
        item.status==='fulfilled'?item.value:[]).slice(0,50);
    }
  } catch {
    // A failed browser observation is UNKNOWN, not proof that tabs closed.
    currentBrowserTabs={status:'unavailable',tabs:[],observedAt:null};
  } finally {dashboardRefreshInFlight=false;}
}
export async function inspectDashboard() {
  await refreshDashboard();
  return privateDashboardSnapshot();
}
async function publishPrivateDashboard() {
  if (!process.parentPort || dashboardRefreshInFlight) return;
  const snapshot = await inspectDashboard();
  if (!httpServer.listening) return;
  try {
    process.parentPort.postMessage({
      type:'coordination_snapshot',snapshot,
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
const mcpHandler = async (req, res) => {
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
};
app.post('/mcp', attachProfile, mcpHandler);

// Match the AgentBridge route-token design: put the existing public transport
// key in the endpoint *path*, not in query parameters or custom headers.
// The token is not a paired Agent credential. Do not echo it in responses.
function validAgentUrlToken(req) {
  if(PUBLIC_PORT===null)return false;
  let pathname='';
  let validShape=false;
  try {
    const url=new URL(req.originalUrl || req.url,'http://localhost');
    pathname=url.pathname;
    validShape=url.search==='' && url.hash==='' &&
      /^\/mcp\/agent\/[a-f0-9]{64}$/.test(pathname);
  } catch { /* Invalid or malformed URLs fail closed. */ }
  // Hash both paths to a fixed digest, just as AgentBridge does, so
  // timingSafeEqual never throws or leaks path length.
  const actual=crypto.createHash('sha256').update(pathname,'utf8').digest();
  const expected=crypto.createHash('sha256')
    .update('/mcp/agent/'+PUBLIC_MCP_TOKEN,'utf8').digest();
  return validShape && crypto.timingSafeEqual(actual,expected);
}
function requireAgentUrlToken(req,res,next){
  res.set('Cache-Control','no-store');
  res.set('Referrer-Policy','no-referrer');
  if(!validAgentUrlToken(req))
    return res.status(401).json({
      jsonrpc:'2.0',error:{code:-32001,message:'MCP URL authentication required'},id:null,
    });
  next();
}
app.use('/mcp/agent',requireAgentUrlToken);
app.post('/mcp/agent/:token',attachProfile,mcpHandler);

const methodNotAllowed = (_req, res) =>
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed (stateless server: use POST).' },
    id: null,
  });
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);
app.get('/mcp/agent/:token',methodNotAllowed);
app.delete('/mcp/agent/:token',methodNotAllowed);

const httpServer = http.createServer(app);
// The ngrok upstream is a separate HTTP-only listener. It has NO websocket
// upgrade handler and exposes only /health, /mcp and /mcp/agent,
// never /bridge or desktop
// administration endpoints, even if ngrok rewrites Host/Origin headers.
const publicApp=express();
publicApp.use((req,res,next)=>{
  if(req.path==='/health')return app(req,res,next);
  if(req.path==='/mcp/agent' || req.path.startsWith('/mcp/agent/')){
    // Authenticate before allowing public requests to reach the body parser.
    // Direct loopback requests are independently checked by app.use.
    return requireAgentUrlToken(req,res,()=>app(req,res,next));
  }
  if(req.path==='/mcp') {
    const authorization=req.headers.authorization;
    const wellFormed=typeof authorization==='string' &&
      /^Bearer [a-f0-9]{64}$/i.test(authorization);
    const supplied=wellFormed
      ? Buffer.from(authorization.slice(7),'hex') : Buffer.alloc(32);
    const expected=Buffer.from(PUBLIC_MCP_TOKEN,'hex');
    if(!crypto.timingSafeEqual(supplied,expected) || !wellFormed) {
      res.set('WWW-Authenticate','Bearer realm="chat-orchestrator-mcp"');
      return res.status(401).json({
        jsonrpc:'2.0',error:{code:-32001,message:'MCP transport authentication required'},id:null,
      });
    }
    return app(req,res,next);
  }
  return res.status(404).end();
});
const publicHttpServer=PUBLIC_PORT===null?null:http.createServer(publicApp);

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/bridge') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  // The bridge is LOCAL extension IPC, never a public ngrok/WebSocket API.
  // Reject requests whose Host/Origin indicate a remotely forwarded browser
  // or an unrelated webpage. Native loopback clients without Origin remain
  // usable for existing local integration/diagnostic tests.
  const host=String(req.headers.host||'').toLowerCase();
  const boundPort=httpServer.address()?.port ?? PORT;
  const allowedHosts=new Set([`localhost:${boundPort}`,`127.0.0.1:${boundPort}`,`[::1]:${boundPort}`]);
  const remote=String(req.socket.remoteAddress||'').toLowerCase();
  const localRemote=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote);
  const origin=String(req.headers.origin||'');
  const allowedOrigin=!origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ||
    /^moz-extension:\/\/[0-9a-f-]{36}$/i.test(origin);
  if (!allowedHosts.has(host) || !localRemote || !allowedOrigin) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
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
  if(process.env.CHAT_ORCH_SETTINGS_DIR || process.env.CHAT_ORCH_PROFILE_DIR) {
    durableIdempotency=await createDurableIdempotencyLedger(path.join(
      process.env.CHAT_ORCH_SETTINGS_DIR || process.env.CHAT_ORCH_PROFILE_DIR,
      'mcp-operational-replay.bin'));
  }
  // Ownership is scoped to the current Proxy session. Ignore older
  // tab-relations.json entries; never modify the separate durable FIFO journal.
  if (!tabRegistry) tabRegistry = createSessionTabRegistry();
  if ((privateCoordinationRequested || PUBLIC_PORT!==null) &&
      !['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
    throw new Error('Private extension bridge and HTTP-only MCP upstream require loopback bind');
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
      // Both ports are one startup transaction; never leave a local bridge
      // serving an undiscoverable half-started MCP gateway.
      if (publicHttpServer?.listening) {
        await new Promise((done)=>publicHttpServer.close(()=>done()));
      }
      if (httpServer.listening) {
        await new Promise((done)=>httpServer.close(()=>done()));
      }
      // The journal lock was acquired before listen(). A failed bind must
      // release it, otherwise the *next* startup reports a misleading stale
      // owner even though no proxy is running.
      clearInterval(privateDispatchTimer);
      privateDispatchTimer = null;
      clearInterval(sessionHeartbeatTimer);
      sessionHeartbeatTimer = null;
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
    const onListening = async () => {
      httpServer.off('error', onError);
      if (publicHttpServer) {
        try {
          await new Promise((done,fail)=>{
            const reject=(error)=>{publicHttpServer.off('listening',accept);fail(error);};
            const accept=()=>{publicHttpServer.off('error',reject);done();};
            publicHttpServer.once('error',reject);
            publicHttpServer.once('listening',accept);
            publicHttpServer.listen(PUBLIC_PORT,HOST);
          });
        } catch(error) {
          await onError(error);
          return;
        }
      }
      resetExtensionSessionState();
      const address = httpServer.address();
      console.log(`Chat Orchestrator MCP server listening on http://${HOST}:${address.port}`);
      console.log('  Extension bridge: ws://localhost:' + address.port + '/bridge');
      console.log('  MCP endpoints: /mcp (Bearer), /mcp/agent (URL token)'+
        (publicHttpServer?' (HTTP-only upstream '+PUBLIC_PORT+')':''));
      process.parentPort?.postMessage({ type: 'ready', port: address.port });
      clearInterval(sessionHeartbeatTimer);
      sessionHeartbeatTimer=setInterval(sendSessionHeartbeat,15000);
      sessionHeartbeatTimer.unref?.();
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
  clearInterval(sessionHeartbeatTimer);
  sessionHeartbeatTimer = null;
  clearInterval(dashboardTimer);
  dashboardTimer = null;
  currentBrowserTabs = {status:'unavailable',tabs:[],observedAt:null};
  armedPrivateDelivery.clear();
  pausedPrivateDelivery.clear();
  activePrivateManagers.clear();
  privateManagerObservations.clear();
  profileManagerIdentities.clear();
  rootRepairOffers.clear();
  for (const client of wss.clients) {
    if (client.browserSessionId) client.close(4001,'proxy session ended');
    else client.close(4002,'proxy stopping');
    setTimeout(() => client.terminate(),1000).unref?.();
  }
  extensionSockets.clear();
  bridge=null;
  profileSocketGeneration++;
  let listenerError;
  let journalCloseError;
  try {
    if (publicHttpServer?.listening) {
      const closedPublic=new Promise((resolve,reject)=>
        publicHttpServer.close((error)=>error?reject(error):resolve()));
      publicHttpServer.closeIdleConnections?.();
      const forcePublic=setTimeout(()=>publicHttpServer.closeAllConnections?.(),4000);
      forcePublic.unref?.();
      try {await closedPublic;} finally {clearTimeout(forcePublic);}
    }
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

export const desktopMethods = Object.freeze({
  set_orchestrator: 'desktop_set_orchestrator_tab',
  diagnose: 'desktop_diagnose_tab',
  close_legacy_workers: 'desktop_close_legacy_workers',
  close_managed_browser: 'desktop_close_managed_browser',
  verify_managed_browser: 'desktop_verify_managed_browser',
  update_readiness: 'desktop_update_readiness',
});
export async function desktopAction({action, tab_id, browser_session_id, confirmation_nonce,
  decision_id,choice,reason,expected_profile_install_id,expected_browser_product}) {
  if(action==='recover_queue_batch'||action==='focus_queue_manager'){
    if(!privateCoordinationEnabled || !privateJournal || !bridgeConnected())
      throw new Error('Start the private queue and connect the managed browser first');
    const manager=[...activePrivateManagers.values()].filter(principal=>
      principal.callerTabId===tab_id && principal.browserSessionId===browser_session_id);
    if(manager.length!==1)throw new Error('Paired manager in this browser session is unavailable');
    const principal=registeredPrivateManager(manager[0]);
    const observation=await callExtension('manager_state',{
      __trustedPrincipal:principal,__sessionBrowserId:principal.browserSessionId},15000);
    rememberPrivateManagerReadiness(principal,observation);
    if(action==='focus_queue_manager')
      return callExtension('focus_manager_tab',{
        __trustedPrincipal:principal,__sessionBrowserId:principal.browserSessionId},15000);
    return recoverPrivateManagerBatch(principal,decision_id,choice,reason);
  }
  if (action === 'inspect_root_repair') return inspectRootRepair(tab_id,true,browser_session_id);
  if (action === 'confirm_root_repair') return reconcileRootFromDesktop(tab_id,confirmation_nonce,browser_session_id);
  if(action==='list_completion_monitors'||action==='set_manual_completion') {
    const connections=[...extensionSockets.values()].filter((socket)=>
      socket.readyState===1&&socket.profileAuthenticated &&
      (!browser_session_id||socket.browserSessionId===browser_session_id));
    if(connections.length!==1)
      throw new Error('Exactly one authenticated browser profile is required');
    const sessionId=connections[0].browserSessionId;
    if(action==='list_completion_monitors')
      return callExtension('desktop_completion_status',{
        __trustedDesktopConsent:true,__sessionBrowserId:sessionId},12000);
    if(!PRIVATE_EVENT_ID.test(decision_id||'')||
        !['completed','in_progress'].includes(choice))
      throw new Error('Explicit valid task ID and Completed/In Progress choice required');
    return callExtension('desktop_set_manual_completion',{
      __trustedDesktopConsent:true,__sessionBrowserId:sessionId,
      task_id:decision_id,status:choice},12000);
  }
  if (action==='list_agent_closures' || action==='resolve_agent_closure') {
    if (extensionSockets.size!==1 || !bridgeConnected())
      throw new Error('Exactly one verified connected browser profile is required for closure decisions');
    const sessionId=[...extensionSockets.keys()][0];
    const decisions=await callExtension('desktop_list_agent_closures',{
      __trustedDesktopConsent:true,__sessionBrowserId:sessionId,
    },12000);
    if(action==='list_agent_closures') return decisions;
    if(!PRIVATE_EVENT_ID.test(decision_id||'') ||
        !['accident','yes','cancel'].includes(choice))
      throw new Error('Explicit valid closure decision and choice required');
    const closed=decisions.find((item)=>item.id===decision_id &&
      item.browserSessionId===sessionId);
    if(!closed)throw new Error('Pending closure decision missing from selected browser profile');
    if(Date.now()-closed.createdAt<5000)
      throw new Error('Closure confirmation buttons remain disabled for five seconds');
    if(choice==='accident') {
      const resuming=closed.status==='restoring_children' &&
        Number.isSafeInteger(closed.candidateTabId);
      const prepared=resuming
        ? {candidate_tab_id:closed.candidateTabId}
        : await callExtension('desktop_prepare_accident_restore',{
          decision_id,__trustedDesktopConsent:true,__sessionBrowserId:sessionId,
        },15000);
      const live=await callExtension('inspect_tab',{
        tab_id:prepared.candidate_tab_id,__sessionBrowserId:sessionId,
      },12000);
      if(live.browser_session_id!==sessionId || live.tab_id===closed.oldTabId ||
          (resuming && live.incarnation_id!==closed.candidateIncarnationId) ||
          live.site!==(closed.url?.startsWith('https://chatgpt.com/')?'chatgpt':
            closed.url?.startsWith('https://claude.ai/')?'claude':'gemini'))
        throw new Error('Recovered Agent tab did not pass identity/provider verification');
      const original=tabRegistry?.get(closed.oldTabId,sessionId);
      if(original) {
        await tabRegistry.replaceClosedAgent(closed.oldTabId,live,closed.incarnationId);
      } else if (closed.kind==='parent') {
        await tabRegistry.registerRoot(live);
      } else {
        const parent=tabRegistry?.get(closed.parentTabId,sessionId);
        if(!parent)throw new Error('Child Parent must be paired before restoring missing Child ancestry');
        await tabRegistry.registerChild(closed.parentTabId,live);
        await tabRegistry.setPhase(live.tab_id,'reattached',sessionId);
      }
      const result=resuming
        ? {restored:true,new_tab_id:live.tab_id,no_task_replay:true}
        : await callExtension('desktop_commit_accident_restore',{
          decision_id,new_tab_id:live.tab_id,
          new_parent_owner:profileCredentialId(sessionId,live.tab_id),
          __trustedDesktopConsent:true,__sessionBrowserId:sessionId,
        },15000);
      callerIdentity.revokeTab(sessionId,closed.oldTabId);
      // Accident consent covers the captured recursive subtree. Restore in
      // parent-before-child order: reuse verified live tabs, create only
      // closed descendants, and update the Proxy ancestry after each step.
      // Each extension create is durably reserved before its browser effect.
      const mapping=new Map([[closed.oldTabId,live.tab_id]]);
      const remaining=[...(closed.descendants||[])];
      if(remaining.length>200)throw new Error('Restoration subtree exceeds safe tab limit');
      const restored=[];
      while(remaining.length){
        const index=remaining.findIndex((item)=>
          Number.isSafeInteger(item?.tabId) &&
          Number.isSafeInteger(item?.parentTabId) &&
          mapping.has(item.parentTabId) && !mapping.has(item.tabId));
        if(index<0)
          throw new Error('Captured subtree has an unresolved parent or cycle; manual reconciliation required');
        const [item]=remaining.splice(index,1);
        const newParentId=mapping.get(item.parentTabId);
        const observedParent=await callExtension('inspect_tab',{
          tab_id:newParentId,__sessionBrowserId:sessionId,
        },12000);
        const parentRecord=tabRegistry?.get(newParentId,sessionId);
        if(!parentRecord ||
            observedParent.incarnation_id!==parentRecord.incarnationId ||
            observedParent.browser_session_id!==sessionId)
          throw new Error('Restoration Parent changed; no Child will be created');
        const replacement=await callExtension('desktop_restore_closure_descendant',{
          decision_id,old_tab_id:item.tabId,
          old_parent_tab_id:item.parentTabId,new_parent_tab_id:newParentId,
          expected_parent_incarnation:parentRecord.incarnationId,
          new_parent_owner:profileCredentialId(sessionId,newParentId),
          __trustedDesktopConsent:true,__sessionBrowserId:sessionId,
        },15000);
        const observedChild=await callExtension('inspect_tab',{
          tab_id:replacement.tab_id,__sessionBrowserId:sessionId,
        },12000);
        if(observedChild.tab_id!==replacement.tab_id ||
            observedChild.incarnation_id!==replacement.incarnation_id ||
            observedChild.browser_session_id!==sessionId ||
            observedChild.site!=='chatgpt' ||
            observedChild.is_managed_worker!==true)
          throw new Error('Restored Child failed independent identity verification');
        const prior=tabRegistry?.get(item.tabId,sessionId);
        if(prior && item.tabId!==replacement.tab_id)
          await tabRegistry.replaceClosedAgent(item.tabId,observedChild,item.incarnationId);
        else if(prior) {
          if(prior.incarnationId!==observedChild.incarnation_id ||
              prior.parentTabId!==newParentId)
            throw new Error('Still-live descendant ancestry changed during restoration');
        } else {
          await tabRegistry.registerChild(newParentId,observedChild);
          await tabRegistry.setPhase(observedChild.tab_id,'reattached',sessionId);
        }
        if(item.tabId!==replacement.tab_id)
          callerIdentity.revokeTab(sessionId,item.tabId);
        mapping.set(item.tabId,replacement.tab_id);
        restored.push({old_tab_id:item.tabId,tab_id:replacement.tab_id,
          reused:replacement.reused===true,created:replacement.created===true});
      }
      const finished=await callExtension('desktop_finalize_accident_restore',{
        decision_id,__trustedDesktopConsent:true,
        __sessionBrowserId:sessionId,
      },15000);
      if(finished.restored!==true||finished.descendants_verified!==restored.length)
        throw new Error('Restored subtree was not verified as complete');
      let recovery={attached:0,held:0};
      if(closed.kind==='parent') {
        try {recovery=await reconstructLiveDescendants(live.tab_id,sessionId);}
        catch {recovery={reconciliation_required:true};}
      }
      return {...result,restoration_complete:true,
        descendants_verified:restored.length,descendant_tabs:restored,
        recovery,no_task_replay:true};
    }
    const result=await callExtension('desktop_apply_agent_closure',{
      decision_id,choice,__trustedDesktopConsent:true,
      __sessionBrowserId:sessionId,
    },15000);
    const removed=tabRegistry?await tabRegistry.detachSubtree(closed.oldTabId,sessionId):[];
    for (const id of [closed.oldTabId,...removed,...result.affected_tab_ids])
      callerIdentity.revokeTab(sessionId,id);
    return {...result,revoked_agent_tabs:[...new Set(removed)]};
  }
  if (!Object.hasOwn(desktopMethods,action)) throw new Error('Unknown desktop action');
  if (['close_managed_browser','verify_managed_browser','update_readiness'].includes(action)) {
    if(extensionSockets.size!==1 || !bridgeConnected() ||
        ![...extensionSockets.values()][0]?.profileAuthenticated)
      throw new Error('A uniquely profile-authenticated extension is required for managed browser actions');
    const socket=[...extensionSockets.values()][0];
    if(!socket.profileInstallId)
      throw new Error('Extension profile enrollment identity unavailable; reconnect and verify this browser');
    if(action==='close_managed_browser') {
      if(!PRIVATE_EVENT_ID.test(expected_profile_install_id||'') ||
          expected_profile_install_id!==socket.profileInstallId ||
           !['chrome','edge','chromium'].includes(expected_browser_product) ||
           (expected_browser_product==='chromium'
             ? !['chrome','chromium'].includes(socket.browserProduct)
             : expected_browser_product!==socket.browserProduct))
        throw new Error('Dedicated browser enrollment or browser product mismatch; refusing to close browser windows');
    }
    if(action==='verify_managed_browser') {
      if(!socket.browserProduct||!socket.extensionVersion)
        throw new Error('Connected extension must report a supported browser and its build version');
      const verified=await callExtension(desktopMethods[action],{
        __trustedDesktopConsent:true,__sessionBrowserId:socket.browserSessionId},12000);
      if(verified?.profile_install_id!==socket.profileInstallId)
        throw new Error('Extension enrollment changed during verification');
      return {...verified,browser_product:socket.browserProduct,
        extension_version:socket.extensionVersion};
    }
  }
  return callExtension(desktopMethods[action], {tab_id,
    __trustedDesktopConsent:['close_managed_browser','verify_managed_browser','update_readiness'].includes(action),
    expected_profile_install_id:action==='close_managed_browser'?expected_profile_install_id:undefined,
    __sessionBrowserId:browser_session_id}, 12000);
}
export function refreshExtensionSettings() {
  reloadAgentSettings();
  for (const ws of extensionSockets.values()) sendExtensionSettings(ws);
  return agentSettingsRevision;
}
// The standalone manual tester mounts its routes only in its own process.
export { app, httpServer, wss };

if (process.parentPort) {
  process.parentPort.on('message', async (event) => {
    if (event?.data?.type === 'desktop_extension_action') {
      const id = event.data.request_id;
      if (!PRIVATE_EVENT_ID.test(id || '')) return;
      const action = event.data.action;
      if (!Object.hasOwn(desktopMethods,action) &&
          !['inspect_root_repair','confirm_root_repair','verify_managed_browser','update_readiness',
            'list_agent_closures','resolve_agent_closure','recover_queue_batch',
            'focus_queue_manager'].includes(action)) return;
      try {
        const result = await desktopAction(event.data);
        process.parentPort.postMessage({type:'desktop_extension_action_result',request_id:id,ok:true,result});
      } catch (error) {
        process.parentPort.postMessage({type:'desktop_extension_action_result',request_id:id,ok:false,
          error:String(error?.message || 'Extension action failed')});
      }
      return;
    }
    if (event?.data?.type === 'reload_agent_settings') {
      refreshExtensionSettings();
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
