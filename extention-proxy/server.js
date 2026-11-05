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
import { listPrincipalCredentials, resolvePrincipalCredential } from './principal-auth.mjs';
import { disabledAgentSettings, normalizeAgentSettings } from './agent-settings.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

// ---------------------------------------------------------------- auth token
function loadToken() {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  const file = process.env.BRIDGE_TOKEN_FILE || path.join(__dirname, '.token');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}
let TOKEN;
let EXTENSION_TOKEN = null; // Distinct from MCP transport and scoped credentials.
function loadExtensionToken() {
  const file = process.env.EXTENSION_BRIDGE_TOKEN_FILE;
  if (file && !path.isAbsolute(file)) throw new Error('Extension bridge token path must be absolute');
  const value = process.env.EXTENSION_BRIDGE_TOKEN ||
    (file ? fs.readFileSync(file, 'utf8').trim() : null);
  if (!value) return null;
  if (value.length < 32 || value.length > 128 || /\s/.test(value) ||
      safeEqual(value, TOKEN)) {
    throw new Error('Private extension bridge token must be distinct, bounded and secret');
  }
  return value;
}
const PRINCIPAL_REGISTRY_FILE = path.join(
  path.dirname(process.env.BRIDGE_TOKEN_FILE || path.join(__dirname, '.token')),
  'coordination-principals.json'
);
// Settings live beside this profile's bridge token, never in the extension.
const AGENT_SETTINGS_FILE = path.join(path.dirname(PRINCIPAL_REGISTRY_FILE), 'settings.json');
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
      agentSettings = normalizeAgentSettings(stored.agentSettings || {});
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

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function requestToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  if (req.headers['x-bridge-token']) return String(req.headers['x-bridge-token']);
  return String(req.query?.token || '');
}

function requireToken(req, res, next) {
  const token = requestToken(req);
  if (safeEqual(token, TOKEN)) {
    // Legacy callers retain their own isolated scope, never a privileged principal.
    req.bridgePrincipal = Object.freeze({ mode: 'legacy' });
    return next();
  }
  try {
    const record = resolvePrincipalCredential(PRINCIPAL_REGISTRY_FILE, token);
    if (!record) return res.status(401).json({ error: 'unauthorized' });
    req.bridgePrincipal = Object.freeze({ mode: 'scoped', ...record });
    if (privateCoordinationEnabled) verifiedPrincipalContexts.add(req.bridgePrincipal);
    return next();
  } catch (error) {
    console.error('[auth] principal registry unavailable:', error?.message);
    return res.status(503).json({ error: 'principal registry unavailable' });
  }
}

// ------------------------------------------- private P0 coordination (inert)
/**
 * Independently authenticated caller identity. The shared bridge token is
 * transport access only; request parameters cannot establish this context.
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

// No enrollment or grants exist. Future trusted enrollment must register frozen
// contexts and scopes using independently verified per-caller credentials.
// A worker-completion producer needs an authenticated origin/receipt, and
// manager-originated status needs its own independently trusted credential.
// Neither may inherit authority from the shared bridge transport token.
let privateCoordinationEnabled = false;
const privateCoordinationRequested = process.env.CHAT_ORCH_PRIVATE_COORDINATION === '1';
let privateJournal = null; // Only if the preprovisioned journal passes strict replay.
const verifiedPrincipalContexts = new WeakSet();
const verifiedCoordinationScopes = new WeakSet();

/** @param {PrincipalContext} principal @param {PrivateCoordinationScope} scope */
function authorizePrivateCoordination(principal, scope) {
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

// Only the authenticated MCP token path can admit a verified principal.
async function verifiedPrivateWorkerScope(principal, workerTabId) {
  if (!privateCoordinationEnabled || !verifiedPrincipalContexts.has(principal)) {
    throw new Error('Private queue requires authenticated scoped caller');
  }
  const tabs = await callExtension('list_tabs', { __trustedPrincipal: principal });
  const worker = tabs.find((tab) => tab.tab_id === workerTabId && tab.role === 'worker');
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
const PRIVATE_QUEUE_ENTRY_TYPES = new Set(['CHILD_RESULT', 'STATUS_REQUEST']);

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

function privateScopedRetryKey(owner, idempotencyKey) {
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

function privateQueueStep(reduced, event) {
  const ownerKey = privateScopeKey(event.ownerScope);
  const recipientKey = privateRecipientKey(event.recipient);
  const sourceKey = privateSourceKey(event.source);
  const payload = event.payload;
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
      return item.recipientTabId === event.recipient.tabId &&
        item.recipientKey !== recipientKey &&
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
  const reduced = { byRef: new Map(), fifo: [] };
  let expectedSeq = 0;
  for (const event of events) {
    if (event.seq !== ++expectedSeq) throw new Error('Private queue sequence gap');
    const step = privateQueueStep(reduced, event);
    reduced.byRef.set(step.key, step.next);
    if (step.queued) reduced.fifo.push(step.key);
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
      retryKey = privateScopedRetryKey(event.ownerScope, event.idempotencyKey);
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
  // Desktop supplies this absolute path under Electron app.getPath('userData').
  // CLI without an explicit user-data token path cannot open a private journal.
  const tokenFile = process.env.BRIDGE_TOKEN_FILE;
  if (!tokenFile || !path.isAbsolute(tokenFile) ||
      path.basename(tokenFile).toLowerCase() !== 'bridge.token') {
    throw new Error('Private journal requires the desktop user-data token path');
  }
  const journalPath = path.join(path.dirname(tokenFile), 'coordination.events.journal');
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
      privateScopedRetryKey(event.ownerScope, event.idempotencyKey), event,
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
        return Promise.reject(new Error('Private journal requires independently authenticated owner'));
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
        const retryKey = privateScopedRetryKey(ownerScope, idempotencyKey);
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
        const ref = payload?.phase === 'QUEUED' ? id : payload?.ref;
        const prior = queueState.byRef.get(
          privateScopeKey(ownerScope) + '#' + String(ref).toLowerCase()
        );
        const entryType = payload?.phase === 'QUEUED' ? payload?.entryType : prior?.entryType;
        // Status is modeled as a manager-originated ordered barrier, but no
        // status ingress or manager delivery path is registered.
        const source = entryType === 'STATUS_REQUEST'
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
        queueState.byRef.set(step.key, step.next);
        if (step.queued) queueState.fifo.push(step.key);
        return structuredClone(stored);
      });
      serial = operation.catch(() => {});
      return operation;
    };

    return Object.freeze({
      replay: (principal, scope) => {
        if (!authorizePrivateCoordination(principal, scope)) {
          throw new Error('Private journal replay requires authenticated owner');
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
          throw new Error('Private queue state requires authenticated owner');
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
          throw new Error('Private recovery diagnostics require authenticated owner');
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
      append,
      diagnosticCounts: () => privateQueueDiagnosticCounts(queueState),
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
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Extension call "${method}" timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
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
      console.log('[bridge] extension disconnected');
      failAllPending('Extension disconnected while a call was in flight');
    }
  });
});

// ------------------------------------------------- private producer/manager API
// The temporary registration is LOST on proxy restart. This intentionally
// prevents automatic delivery to a reused numeric tab until re-authenticated.
const activePrivateManagers = new Map(); // credentialId -> frozen token-verified principal
const privateManagerObservations = new Map(); // transient authenticated readiness, never persisted

function privateManagerScope(principal) {
  if (!privateCoordinationEnabled || !privateJournal ||
      !verifiedPrincipalContexts.has(principal) || principal.mode !== 'scoped') {
    throw new Error('Private coordination requires an authenticated scoped manager');
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
  if (!active || active.principalId !== principal.principalId ||
      active.sessionIncarnationId !== principal.sessionIncarnationId ||
      active.connectionGeneration !== principal.connectionGeneration) {
    throw new Error('Manager is not registered in this proxy session');
  }
  const record = listPrincipalCredentials(PRINCIPAL_REGISTRY_FILE)
    .find((item) => item.credentialId === principal.credentialId && !item.revokedAt);
  if (!record || record.principalId !== principal.principalId) {
    activePrivateManagers.delete(principal.credentialId);
    throw new Error('Manager credential revoked or absent');
  }
  return active;
}

function rememberPrivateManagerReadiness(principal, observation) {
  if (!observation || observation.tab_id !== principal.callerTabId ||
      !['idle', 'busy', 'draft', 'uncertain', 'unknown'].includes(observation.state) ||
      observation.browser_session_id !== principal.browserSessionId ||
      observation.incarnation_id !== principal.sessionIncarnationId) {
    throw new Error('Paired manager tab could not be attested');
  }
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
  return ['idle', 'busy', 'draft', 'uncertain', 'unknown'].includes(observation.state)
    ? observation.state : 'unknown';
}

async function registerPrivateManager(principal) {
  privateManagerScope(principal);
  const observation = await callExtension('manager_state', { __trustedPrincipal: principal });
  rememberPrivateManagerReadiness(principal, observation);
  activePrivateManagers.set(principal.credentialId, principal);
  return { registered: true, manager_tab_id: principal.callerTabId,
    observation: observation.state, storage_ready: true };
}

// Independent readback from the already-running LOCAL Saga UI. A client-supplied
// note/status is never accepted as proof; missing board fails closed.
const SAGA_READBACK_BASE = process.env.SAGA_READBACK_BASE_URL || 'http://127.0.0.1:4319';
async function sagaReadTask(taskId) {
  const base = new URL(SAGA_READBACK_BASE);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' ||
      base.username || base.password || base.search || base.hash ||
      base.pathname !== '/') {
    throw new Error('Saga readback must use a dedicated 127.0.0.1 HTTP origin');
  }
  const response = await fetch(new URL('/api/tasks/' + taskId, base), {
    signal: AbortSignal.timeout(3000), headers: { accept: 'application/json' },
    redirect: 'error',
  });
  if (!response.ok) throw new Error('Saga task readback unavailable');
  const task = await response.json();
  if (task.id !== taskId || task.is_deleted) throw new Error('Saga task identity unavailable');
  return task;
}

async function verifiedSagaClose(principal, args) {
  const active = registeredPrivateManager(principal);
  const managerScope = privateManagerScope(active);
  if (!PRIVATE_EVENT_ID.test(args.saga_event_id || '') ||
      !Number.isSafeInteger(args.saga_note_id) || args.saga_note_id <= 0 ||
      !Number.isSafeInteger(args.saga_task_id) || args.saga_task_id <= 0) {
    throw new Error('Scoped close HELD: event, task and note verification IDs are required');
  }
  const item = privateJournal.queueState(active, managerScope)
    .find((entry) => entry.ref === args.saga_event_id);
  if (!item || !['PROCESSED', 'SAGA_CONFIRMED'].includes(item.phase)) {
    throw new Error('Scoped close HELD: child result has no processed journal ACK');
  }
  const original = privateJournal.replay(active, managerScope).find((event) =>
    event.id === args.saga_event_id && event.payload.phase === 'QUEUED' &&
    event.payload.entryType === 'CHILD_RESULT');
  if (!original || original.source.tabId !== args.tab_id ||
      original.payload.data.workerTabId !== args.tab_id) {
    throw new Error('Scoped close HELD: event does not belong to this worker');
  }
  const parentTaskId = Number(active.parentTaskId);
  if (!Number.isSafeInteger(parentTaskId) || parentTaskId <= 0) {
    throw new Error('Scoped close HELD: parent Saga task binding invalid');
  }
  const parent = await sagaReadTask(parentTaskId);
  const board = args.saga_task_id === parentTaskId
    ? parent : await sagaReadTask(args.saga_task_id);
  if (String(board.project_id) !== String(active.projectId) ||
      String(parent.project_id) !== String(active.projectId) ||
      board.epic_id !== parent.epic_id) {
    throw new Error('Scoped close HELD: Saga project/epic binding mismatch');
  }
  const subtaskId = args.saga_subtask_id ?? null;
  if (subtaskId === null ? board.status !== 'done' :
      !board.subtasks?.some((entry) =>
        entry.id === subtaskId && entry.status === 'done')) {
    throw new Error('Scoped close HELD: Saga task/subtask not complete');
  }
  const marker = 'CHATORCH_SAGA_VERIFIED ' + [
    args.saga_event_id, original.payload.data.taskId,
    String(args.tab_id), active.credentialId,
  ].join(' ');
  const note = board.notes?.find((entry) => entry.id === args.saga_note_id &&
    entry.related_entity_type === 'task' && entry.related_entity_id === board.id &&
    typeof entry.content === 'string' && entry.content.includes(marker));
  if (!note) throw new Error('Scoped close HELD: linked Saga evidence note missing');
  const noteDigest = crypto.createHash('sha256').update(note.content).digest('hex');
  // Read once more before release: board could have changed during journal sync.
  const fresh = await sagaReadTask(board.id);
  const freshNote = fresh.notes?.find((entry) =>
    entry.id === note.id && entry.content === note.content);
  const stillDone = subtaskId === null ? fresh.status === 'done'
    : fresh.subtasks?.some((entry) => entry.id === subtaskId && entry.status === 'done');
  if (!freshNote || !stillDone) {
    throw new Error('Scoped close HELD: Saga readback changed before release');
  }
  if (item.phase === 'PROCESSED') {
    await privateJournal.append(active, privateRecordedScope(active, original),
      'queue.transition', {
        phase: 'SAGA_CONFIRMED', ref: item.ref,
        leaseGeneration: item.leaseGeneration, leaseNonce: item.leaseNonce,
        saga: {
          eventRef: item.ref, principalId: active.principalId,
          workerTabId: args.tab_id, sagaTaskId: board.id,
          sagaSubtaskId: subtaskId, sagaNoteId: note.id,
          noteSha256: noteDigest, readbackAt: new Date().toISOString(),
        },
      }, crypto.randomUUID());
  }
  return callExtension('close_verified_worker', {
    __trustedPrincipal: active, tab_id: args.tab_id,
    worker_incarnation_id: original.source.incarnationId,
    saga_verified: true, saga_event_id: item.ref,
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

async function pumpOnePrivateManager(principal) {
  if (!privateCoordinationEnabled || !privateJournal ||
      !armedPrivateDelivery.has(principal.credentialId) ||
      privateDispatching.has(principal.credentialId)) return;
  privateDispatching.add(principal.credentialId);
  try {
    registeredPrivateManager(principal); // Rechecks revocation on every wake.
    const managerScope = privateManagerScope(principal);
    let pendingQueue = privateJournal.queueState(principal, managerScope)
      .filter((item) => item.phase !== 'PROCESSED' && item.phase !== 'SAGA_CONFIRMED');
    if (!pendingQueue.length || pendingQueue[0].phase !== 'QUEUED') return;
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
    let size = 0;
    for (const item of batchItems) {
      const original = firstEvents.get(item.ref);
      if (!original) throw new Error('Queued event source missing from durable journal');
      const data = original.payload.data;
      const summary = item.entryType === 'STATUS_REQUEST'
        ? data.summary
        : JSON.stringify({ task_id: data.taskId, worker_tab_id: data.workerTabId,
          status: data.status, result: data.result, error: data.error });
      if (typeof summary !== 'string') throw new Error('Invalid durable event summary');
      if (summary.length > 20000 || size + summary.length > 52000) break; // Defer whole event, never truncate it.
      size += summary.length;
      events.push({ event_id: original.id, type: item.entryType,
        summary, recorded_at: original.recordedAt });
    }
    if (!events.length) return; // Oversized immutable event requires manual handling.
    const ready = await callExtension('manager_state', { __trustedPrincipal: principal });
    rememberPrivateManagerReadiness(principal, ready);
    if (ready.ready !== true || ready.state !== 'idle') return;
    // An await above may have admitted another producer: revalidate this
    // exact oldest prefix before writing even the first lease.
    pendingQueue = privateJournal.queueState(principal, managerScope)
      .filter((item) => item.phase !== 'PROCESSED' && item.phase !== 'SAGA_CONFIRMED');
    if (events.some((event, i) =>
      pendingQueue[i]?.ref !== event.event_id || pendingQueue[i].phase !== 'QUEUED')) return;

    const batchId = crypto.randomUUID();
    const scopes = [];
    for (const event of events) {
      const original = firstEvents.get(event.event_id);
      if (original.source.type === 'worker_tab') {
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
    let submitted = false;
    try {
      const outcome = await callExtension('wake_manager', {
        __trustedPrincipal: principal, batch_id: batchId, events,
      });
      submitted = outcome?.submitted === true && outcome.uncertain !== true;
    } catch { /* Submitted status may be ambiguous; never retry. */ }
    for (let i = 0; i < events.length; i++) {
      await privateJournal.append(principal, scopes[i], 'queue.transition', {
        phase: submitted ? 'DELIVERED' : 'UNCERTAIN',
        ref: events[i].event_id, leaseGeneration: 1, leaseNonce: batchId,
      }, crypto.randomUUID());
    }
  } catch (error) {
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
    throw new Error('Batch processing ACK does not match delivered FIFO records');
  }
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
    try {
      // Trust boundary: ignore any caller-supplied identity; the server owns it.
      const result = await callExtension(method, { ...(args || {}), __trustedPrincipal: principal });
      recordToolActivity(principal, method, true, startedAt);
      return textResult(result);
    } catch (err) {
      recordToolActivity(principal, method, false, startedAt);
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
  const server = new McpServer({ name: 'chat-orchestrator', version: '0.1.0' });

  server.registerTool(
    'list_tabs',
    {
      title: 'List chat tabs',
      description:
        'List open Claude / ChatGPT tabs in the user\'s browser with their tab_id, site, title and role (orchestrator, worker, or other).',
      inputSchema: {},
    },
    forward('list_tabs', principal)
  );

  server.registerTool(
    'spawn_worker',
    {
      title: 'Start a worker chat',
      description:
        'Open a NEW chat session in a separate browser window on the given site and send it a task. It works like a sub-agent: the worker has no memory of this conversation unless you pass context. Returns a task_id (and the result if it finishes within wait_seconds). Use get_result to collect the answer. The worker window stays open after it finishes, so you can send follow-ups with send_to_tab. YOU are responsible for closing it with close_worker (using the tab_id) once you have the result and no longer need that worker.',
      inputSchema: {
        site: z.enum(['chatgpt', 'claude', 'gemini']).describe('Which chat site the worker runs on.'),
        role: z.enum(['ba', 'pm', 'tl', 'specialist', 'council_a', 'council_b',
          'council_c', 'council_d', 'council_e', 'watchdog']).optional()
          .describe('Reusable role-seat prompt; defaults to specialist.'),
        role_scope: z.string().optional().describe('Opt-in reusable seat within this authenticated caller: PM/Watchdog epic:N, TL task:N, Council parent:N. Subsequent spawn_worker with the same role+scope continues the SAME idle chat; it never closes or replaces a running worker.'),
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
            'Optional. If true, the extension closes this worker window by itself shortly after the task succeeds (no follow-ups possible). Default false: the window stays open until you call close_worker.'
          ),
        wait_seconds: waitSeconds,
      },
    },
    forward('spawn_worker', principal)
  );

  server.registerTool(
    'send_to_tab',
    {
      title: 'Send a follow-up to an existing worker tab',
      description:
        'Send another message to a worker tab that is already open (continues that chat). Returns a task_id; use get_result to collect the reply.',
      inputSchema: {
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
        'Close a worker tab/window that was opened by spawn_worker. Call this yourself when you have collected a worker\'s result and no longer need it. Safe to call on an already-closed tab.',
      inputSchema: {
        tab_id: z.number().int().describe('tab_id of the worker to close.'),
        saga_task_id: z.number().int().positive().optional(),
        saga_subtask_id: z.number().int().positive().optional(),
        saga_note_id: z.number().int().positive().optional(),
        saga_event_id: z.string().uuid().optional(),
      },
    },
    async (args) => {
      try {
        if (principal.mode === 'scoped') {
          return textResult(await verifiedSagaClose(principal, args));
        }
        return textResult(await callExtension('close_worker', {
          ...args, __trustedPrincipal: principal,
        }));
      } catch (error) { return errorResult(error); }
    }
  );

  // Conditional private API: never present in the standard six-tool endpoint.
  if (privateCoordinationEnabled && privateJournal) {
    server.registerTool('coordination_register_manager', {
      title: 'Register scoped manager for private queue',
      description: 'Attest the paired manager tab for this proxy process. No automatic replay on restart.',
      inputSchema: {},
    }, async () => {
      try { return textResult(await registerPrivateManager(principal)); }
      catch (error) { return errorResult(error); }
    });
    server.registerTool('coordination_status_request', {
      title: 'Queue an ordered manager status barrier',
      description: 'Durably enqueue STATUS_REQUEST after earlier child reports; does not send a chat prompt.',
      inputSchema: {
        idempotency_key: z.string().uuid(),
        summary: z.string().max(4000),
      },
    }, async (args) => {
      try { return textResult(await enqueuePrivateStatus(principal, args.idempotency_key, args.summary)); }
      catch (error) { return errorResult(error); }
    });
    server.registerTool('coordination_start_delivery', {
      title: 'Arm private automatic batched manager wake',
      description: 'After explicit registration, automatically wake the paired manager once on stable idle. No recovered UNCERTAIN replay.',
      inputSchema: {},
    }, async () => {
      try {
        registeredPrivateManager(principal);
        armedPrivateDelivery.add(principal.credentialId);
        setImmediate(pumpPrivateQueue);
        return textResult({ armed: true, no_replay: true });
      } catch (error) { return errorResult(error); }
    });
    server.registerTool('coordination_pause_delivery', {
      title: 'Pause private manager wake',
      description: 'Stop new batch dispatch for this credential; already submitted batch remains unresolved.',
      inputSchema: {},
    }, async () => {
      armedPrivateDelivery.delete(principal.credentialId);
      return textResult({ armed: false });
    });
    server.registerTool('coordination_ack_batch', {
      title: 'Explicitly acknowledge processed private batch',
      description: 'Call only after handling every ordered event. This records consumer ACK, NOT independently verified Saga completion.',
      inputSchema: {
        batch_id: z.string().uuid(),
        event_ids: z.array(z.string().uuid()).min(1).max(16),
      },
    }, async (args) => {
      try {
        const result = await acknowledgePrivateBatch(principal, args.batch_id, args.event_ids);
        setImmediate(pumpPrivateQueue);
        return textResult(result);
      } catch (error) { return errorResult(error); }
    });
    server.registerTool('coordination_get_report', {
      title: 'Read immutable owner-scoped child report',
      description: 'Read full report bytes from a validated journal event; no mutable worker tab dependence.',
      inputSchema: { event_id: z.string().uuid() },
    }, async (args) => {
      try { return textResult(getPrivateFullReport(principal, args.event_id)); }
      catch (error) { return errorResult(error); }
    });
    server.registerTool('coordination_pending', {
      title: 'Read own private queue state',
      description: 'Scoped read-only queue phases; does not release UNCERTAIN items or perform Saga updates.',
      inputSchema: {},
    }, async () => {
      try {
        const active = registeredPrivateManager(principal);
        const scope = privateManagerScope(active);
        return textResult({ events: privateJournal.queueState(active, scope) });
      } catch (error) { return errorResult(error); }
    });
  }

  return server;
}

// Desktop-only snapshot through Electron utilityProcess IPC, never public HTTP.
const privateToolHistory = [];
let dashboardTimer = null;
function recordToolActivity(principal, method, ok, startedAt) {
  privateToolHistory.push({
    at: new Date().toISOString(), method, ok,
    durationMs: Date.now() - startedAt,
    caller: principal?.mode === 'scoped' ? principal.role : 'legacy',
  });
  if (privateToolHistory.length > 80) privateToolHistory.shift();
}
function privateDashboardSnapshot() {
  let seats = [];
  let registryError = false;
  try {
    seats = listPrincipalCredentials(PRINCIPAL_REGISTRY_FILE).map((principal) => ({
      credentialId: principal.credentialId,
      seatName: principal.seatName || principal.role.toUpperCase(),
      role: principal.role, workspaceId: principal.workspaceId,
      projectId: principal.projectId, parentTaskId: principal.parentTaskId,
      callerTabId: principal.callerTabId, revoked: Boolean(principal.revokedAt),
      registered: activePrivateManagers.has(principal.credentialId),
      deliveryArmed: armedPrivateDelivery.has(principal.credentialId),
      readiness: privateReadinessState({
        revoked: Boolean(principal.revokedAt),
        registered: activePrivateManagers.has(principal.credentialId),
        connected: Boolean(bridgeConnected()),
        observation: privateManagerObservations.get(principal.credentialId),
      }),
    }));
  } catch { registryError = true; }
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
  return {
    storageReady: privateCoordinationEnabled && Boolean(privateJournal),
    deliveryEnabledByDefault: false, registryError, hiddenPending,
    extensionConnected: Boolean(bridgeConnected()),
    seats, phases, queue: queue.slice(-30),
    toolCalls: privateToolHistory.slice(-25),
    generatedAt: new Date().toISOString(),
  };
}
function publishPrivateDashboard() {
  if (!process.parentPort) return;
  try {
    process.parentPort.postMessage({
      type: 'coordination_snapshot', snapshot: privateDashboardSnapshot(),
    });
  } catch { /* No export of internal errors or credentials. */ }
}

// ---------------------------------------------------------------- HTTP app
const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/health', (_req, res) => {
  let principalState = 'not_enrolled';
  try {
    const active = listPrincipalCredentials(PRINCIPAL_REGISTRY_FILE).filter((p) => !p.revokedAt);
    principalState = active.some((p) => p.browserSessionId) ? 'enrolled'
      : active.length ? 're_pair_required' : 'not_enrolled';
  } catch { principalState = 'error'; }
  res.json({
    ok: true,
    extensionConnected: Boolean(bridgeConnected()),
    coordination: {
      enabled: false, // Public automated delivery is not yet wired/authorized.
      storageReady: privateCoordinationEnabled && Boolean(privateJournal),
      principalState,
    },
  });
});
app.post('/mcp', requireToken, async (req, res) => {
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
  const supplied = url.searchParams.get('token') || '';
  const directLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
    !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'] &&
    !req.headers.forwarded;
  // Legacy bridge remains compatible while private coordination is off.
  // Private worker completion/attestation NEVER uses the shared MCP token.
  const extensionAuthenticated = Boolean(directLocal && EXTENSION_TOKEN && safeEqual(supplied, EXTENSION_TOKEN));
  const ok = url.pathname === '/bridge' &&
    (privateCoordinationRequested
      ? extensionAuthenticated
      : safeEqual(supplied, TOKEN) || extensionAuthenticated);
  if (!ok) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (extensionAuthenticated) trustedExtensionSockets.add(ws);
    wss.emit('connection', ws, req);
  });
});

export async function startServer() {
  if (httpServer.listening) return httpServer.address();
  TOKEN = loadToken();
  EXTENSION_TOKEN = loadExtensionToken();
  reloadAgentSettings();
  if (privateCoordinationRequested && !EXTENSION_TOKEN) {
    throw new Error('Private coordination requires separate extension bridge credential');
  }
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
    const onError = (error) => {
      httpServer.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off('error', onError);
      const address = httpServer.address();
      console.log(`Chat Orchestrator MCP server listening on http://${HOST}:${address.port}`);
      console.log('  Extension bridge: ws://localhost:' + address.port + '/bridge');
      console.log('  MCP endpoint: /mcp (token required; credential not logged)');
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

export async function stopServer() {
  failAllPending('The local MCP server is stopping');
  clearInterval(privateDispatchTimer);
  privateDispatchTimer = null;
  clearInterval(dashboardTimer);
  dashboardTimer = null;
  armedPrivateDelivery.clear();
  activePrivateManagers.clear();
  for (const client of wss.clients) client.terminate();
  if (httpServer.listening) {
    await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  }
  if (privateJournal) {
    const journal = privateJournal;
    privateJournal = null;
    privateCoordinationEnabled = false;
    await journal.close();
  }
}

if (process.parentPort) {
  process.parentPort.on('message', async (event) => {
    if (event?.data?.type === 'desktop_extension_action') {
      const id = event.data.request_id;
      if (!PRIVATE_EVENT_ID.test(id || '')) return;
      const action = event.data.action;
      const method = {set_orchestrator: 'desktop_set_orchestrator_tab',
        diagnose: 'desktop_diagnose_tab', close_legacy_workers: 'desktop_close_legacy_workers'}[action];
      if (!method) return;
      try {
        const result = await callExtension(method, {tab_id: event.data.tab_id}, 12000);
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
    if (event?.data?.type === 'attest_manager_tab') {
      const requestId = event.data.request_id;
      if (!PRIVATE_EVENT_ID.test(requestId || '')) return;
      try {
        if (!Number.isSafeInteger(event.data.tab_id) || event.data.tab_id <= 0) {
          throw new Error('Invalid manager tab for desktop attestation');
        }
        const result = await callExtension('attest_manager_tab', { tab_id: event.data.tab_id }, 10000);
        process.parentPort.postMessage({ type: 'manager_attestation', request_id: requestId,
          ok: true, result });
      } catch (error) {
        process.parentPort.postMessage({ type: 'manager_attestation', request_id: requestId,
          ok: false, error: String(error?.message || 'Tab attestation failed') });
      }
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
});
