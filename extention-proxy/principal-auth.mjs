// Desktop-authorized, scoped connector credentials. The bridge token remains
// transport-only; it never grants a principal or queue authority.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_CREDENTIALS = 64;
const MAX_FILE_BYTES = 128 * 1024;
const ROLES = new Set(['ba', 'pm', 'tl', 'specialist', 'council', 'watchdog']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function label(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 128) {
    throw new Error('Invalid principal ' + field);
  }
  return value.trim();
}

function publicRecord(record) {
  const { tokenDigest: _secret, ...visible } = record;
  return Object.freeze(visible);
}

function readRegistry(filename) {
  if (!fs.existsSync(filename)) return [];
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid principal registry file');
  const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.credentials) ||
      parsed.credentials.length > MAX_CREDENTIALS) throw new Error('Invalid principal registry schema');
  const ids = new Set();
  const digests = new Set();
  const activeTabBindings = new Set();
  for (const record of parsed.credentials) {
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        !UUID.test(record.credentialId) || !UUID.test(record.principalId) ||
        !UUID.test(record.sessionIncarnationId) ||
        (record.browserSessionId !== undefined && !UUID.test(record.browserSessionId)) ||
        !/^[a-f0-9]{64}$/.test(record.tokenDigest) ||
        !ROLES.has(record.role) ||
        (record.seatName !== undefined &&
          (typeof record.seatName !== 'string' || !record.seatName.trim() || record.seatName.length > 128)) ||
        !['workspaceId', 'projectId', 'orchestratorId', 'parentTaskId']
          .every((key) => typeof record[key] === 'string' && record[key].trim() && record[key].length <= 128) ||
        !Number.isSafeInteger(record.callerTabId) || record.callerTabId <= 0 ||
        !Number.isSafeInteger(record.connectionGeneration) || record.connectionGeneration < 1 ||
        !Number.isFinite(Date.parse(record.issuedAt)) ||
        !(record.revokedAt === null || (typeof record.revokedAt === 'string' &&
          Number.isFinite(Date.parse(record.revokedAt)))) ||
        ids.has(record.credentialId) || digests.has(record.tokenDigest)) {
      throw new Error('Invalid principal registry entry');
    }
    ids.add(record.credentialId);
    if (!record.revokedAt && record.browserSessionId) {
      const binding = record.browserSessionId + ':' + record.callerTabId;
      if (activeTabBindings.has(binding)) {
        throw new Error('Duplicate active principal manager-tab binding');
      }
      activeTabBindings.add(binding);
    }
    digests.add(record.tokenDigest);
  }
  return parsed.credentials;
}

function persistRegistry(filename, credentials) {
  if (credentials.length > MAX_CREDENTIALS) throw new Error('Principal registry capacity reached');
  const folder = path.dirname(filename);
  fs.mkdirSync(folder, { recursive: true });
  const tmp = path.join(folder, '.principals-' + crypto.randomUUID() + '.tmp');
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ version: 1, credentials }), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filename);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

export function createPrincipalCredential(filename, input) {
  if (!input || typeof input !== 'object') throw new Error('Missing principal enrollment');
  const role = label(input.role, 'role').toLowerCase();
  if (!ROLES.has(role)) throw new Error('Unsupported principal role');
  const seatName = label(input.seatName || role.toUpperCase(), 'seat');
  const workspaceId = label(input.workspaceId, 'workspace');
  const projectId = label(input.projectId, 'project');
  const orchestratorId = label(input.orchestratorId, 'orchestrator');
  const parentTaskId = label(input.parentTaskId, 'parent task');
  if (!Number.isSafeInteger(input.callerTabId) || input.callerTabId <= 0) {
    throw new Error('Invalid principal tab');
  }
  if (!UUID.test(input.browserSessionId || '') ||
      !UUID.test(input.managerIncarnationId || '')) {
    throw new Error('Trusted extension manager tab attestation required');
  }
  const records = readRegistry(filename);
  // One physical manager conversation cannot be controlled by two active principals.
  // A revoked credential may be replaced only through fresh trusted enrollment.
  if (records.some((record) => !record.revokedAt &&
      record.browserSessionId === input.browserSessionId &&
      record.callerTabId === input.callerTabId)) {
    throw new Error('Manager tab is already paired to an active principal; revoke it first');
  }
  if (records.length >= MAX_CREDENTIALS) throw new Error('Principal registry capacity reached');
  const token = crypto.randomBytes(32).toString('base64url');
  const record = {
    credentialId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    role, seatName, workspaceId, projectId, orchestratorId, parentTaskId,
    callerTabId: input.callerTabId,
    sessionIncarnationId: input.managerIncarnationId,
    browserSessionId: input.browserSessionId,
    connectionGeneration: 1,
    tokenDigest: crypto.createHash('sha256').update(token).digest('hex'),
    issuedAt: new Date().toISOString(),
    revokedAt: null,
  };
  persistRegistry(filename, [...records, record]);
  return { token, principal: publicRecord(record) };
}

export function listPrincipalCredentials(filename) {
  return readRegistry(filename).map(publicRecord);
}

export function revokePrincipalCredential(filename, credentialId) {
  if (!UUID.test(String(credentialId))) throw new Error('Invalid credential ID');
  const records = readRegistry(filename);
  const index = records.findIndex((record) => record.credentialId === credentialId);
  if (index < 0) return false;
  if (records[index].revokedAt) return true;
  records[index] = { ...records[index], revokedAt: new Date().toISOString() };
  persistRegistry(filename, records);
  return true;
}

export function resolvePrincipalCredential(filename, token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
  const digest = crypto.createHash('sha256').update(token).digest();
  let matched = null;
  for (const record of readRegistry(filename)) {
    const stored = Buffer.from(record.tokenDigest, 'hex');
    if (stored.length === digest.length && crypto.timingSafeEqual(stored, digest)) {
      if (!record.revokedAt) matched = publicRecord(record);
    }
  }
  return matched;
}
