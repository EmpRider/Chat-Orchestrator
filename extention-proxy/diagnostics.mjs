// Local, privacy-preserving structured diagnostics. Separate from the durable
// FIFO journal: diagnostic failures must NEVER affect task or ACK semantics.
import fs from 'node:fs';
import path from 'node:path';
import { LogLayer, StructuredTransport } from 'loglayer';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 3; // current file plus two historical rotations
const IDENTIFIER = /^[a-z][a-z0-9_.-]{0,79}$/;
const UUID = /^[0-9a-f-]{36}$/i;
const SAFE_FIELDS = new Set([
  'traceId','requestId','tabId','parentTabId','rootTabId','workerTabId',
  'windowId','expectedWindowId','actualWindowId','groupId','expectedGroupId',
  'actualGroupId','taskId','batchId','eventId','incarnationId',
  'method','site','status','phase','fromPhase','toPhase','reason',
  'errorClass','mismatchField','connectionGeneration','attempt',
  'durationMs','count','queueDepth','batchSize','processedCount',
  'remainingCount','ownerVerified','journalReady','extensionConnected',
  'success','reused','wasFocused','wasActive','forceKilled',
  'acknowledged','socketGeneration','groupMemberCount','sessionMatch',
  'incarnationMatch','siteMatch','managedWorkerMatch','level','build',
]);
const SAFE_ENUM = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/;
const SAFE_LEVELS = new Set(['debug','info','warn','error']);

function cleanMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const cleaned = {};
  for (const [key,value] of Object.entries(metadata)) {
    if (!SAFE_FIELDS.has(key)) continue;
    if (typeof value === 'boolean') cleaned[key] = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      cleaned[key] = value;
    else if (typeof value === 'string' &&
      (['traceId','requestId','taskId','batchId','eventId','incarnationId'].includes(key)
        ? UUID.test(value) : SAFE_ENUM.test(value))) cleaned[key] = value;
  }
  return cleaned;
}

// Error text, stack traces, prompts, auth tokens and URLs are NEVER logged.
export function classifyDiagnosticError(error) {
  const message = String(error?.message || '');
  if (/session\/incarnation changed|session changed/i.test(message)) return 'identity_changed';
  if (/group|window/i.test(message)) return 'tab_placement';
  if (/UNCERTAIN/i.test(message)) return 'uncertain_outcome';
  if (/ACK|batch processing/i.test(message)) return 'ack_rejected';
  if (/lock|journal/i.test(message)) return 'journal_unavailable';
  if (/timeout|timed out/i.test(message)) return 'timeout';
  if (/disconnect|not connected/i.test(message)) return 'disconnected';
  if (/permission|outside this caller|owned/i.test(message)) return 'ownership_rejected';
  return 'operation_failed';
}

export function createDiagnostics({ component, directory = process.env.CHAT_ORCH_PROFILE_DIR,
  level = process.env.CHAT_ORCH_LOG_LEVEL || (process.env.CHAT_ORCH_DIAGNOSTICS === '1' ? 'debug' : 'info'),
  maxBytes = MAX_FILE_BYTES } = {}) {
  if (typeof component !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(component))
    throw new Error('Invalid diagnostics component');
  const minLevel = SAFE_LEVELS.has(level) ? level : 'info';
  const ranks = {debug:0,info:1,warn:2,error:3};
  const enabled = typeof directory === 'string' && path.isAbsolute(directory);
  const filename = enabled ? path.join(directory, `diagnostics-${component}.jsonl`) : null;
  let currentSize = -1;
  let loggingFailed = false;

  function rotateIfNeeded(bytes) {
    if (currentSize < 0) {
      fs.mkdirSync(directory,{recursive:true,mode:0o700});
      currentSize = fs.existsSync(filename) ? fs.statSync(filename).size : 0;
    }
    if (currentSize + bytes <= maxBytes) return;
    for (let i=MAX_FILES-1;i>=1;i--) {
      const previous = i===1 ? filename : `${filename}.${i-1}`;
      const next = `${filename}.${i}`;
      if (fs.existsSync(next)) fs.unlinkSync(next);
      if (fs.existsSync(previous)) fs.renameSync(previous,next);
    }
    currentSize=0;
  }
  const sink = (entry) => {
    if (!enabled || loggingFailed) return;
    try {
      // Only our pre-sanitized metadata reaches this transport.
      const line = JSON.stringify(entry)+'\n';
      const bytes=Buffer.byteLength(line);
      if (bytes > 2048) return;
      rotateIfNeeded(bytes);
      fs.appendFileSync(filename,line,{encoding:'utf8',mode:0o600,flag:'a'});
      currentSize += bytes;
    } catch {
      loggingFailed=true; // Never propagate diagnostic failures to the FIFO path.
    }
  };
  const output={log:sink,debug:sink,info:sink,warn:sink,error:sink};
  const logger = new LogLayer({
    transport:new StructuredTransport({logger:output}),
    metadataFieldName:'data',
    contextFieldName:'context',
  });
  logger.setLevel(minLevel);

  const event = (severity,name,metadata={}) => {
    if (!SAFE_LEVELS.has(severity) || ranks[severity]<ranks[minLevel] ||
        typeof name !== 'string' || !IDENTIFIER.test(name)) return;
    try {logger.withMetadata({component,...cleanMetadata(metadata)})[severity](name);}
    catch { /* logging must be non-fatal */ }
  };
  return Object.freeze({
    path:filename,
    event,
    debug:(name,data)=>event('debug',name,data),
    info:(name,data)=>event('info',name,data),
    warn:(name,data)=>event('warn',name,data),
    error:(name,data)=>event('error',name,data),
  });
}
