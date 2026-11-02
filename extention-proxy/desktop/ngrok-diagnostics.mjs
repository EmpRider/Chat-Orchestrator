// ngrok's JSON log records may contain URLs and credentials. Only selected
// fields are eligible for diagnostics, and diagnostic output is opt-in.
const MAX_LINE = 8192;
const MAX_DETAIL = 1200;
const ERROR_CODE = /ERR_NGROK_\d+/;
const INTERESTING = /tunnel|session|connect|start|stop|auth|config|fail|error|endpoint|online/i;

function redact(value, secrets) {
  let output = String(value)
    .replace(/(https?:\/\/[^\s"'<>?#]+)\?[^\s"'<>]*/gi, '$1?[redacted]')
    .replace(/\b(authorization|ngrok_authtoken|authtoken|access_token|api[_-]?key|password|secret|token)\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+/gi, '$1 [redacted]');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      output = output.split(secret).join('[redacted]');
    }
  }
  return output.slice(0, MAX_DETAIL);
}

export function inspectNgrokLogLine(line, secrets = []) {
  const value = String(line).slice(0, MAX_LINE);
  const code = value.match(ERROR_CODE)?.[0] || '';
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    // Unstructured output is not safe to print, even in diagnostic mode.
    return code ? { code, diagnostic: `error code ${code}` } : null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const level = typeof parsed.lvl === 'string' ? parsed.lvl.toLowerCase() : '';
  const message = typeof parsed.msg === 'string' ? parsed.msg : '';
  const detail = typeof parsed.err === 'string' ? parsed.err : '';
  if (!message && !detail) return code ? { code, diagnostic: `error code ${code}` } : null;
  // Routine connection-pool chatter is frequent and hides actionable errors.
  if (level === 'info' && message === 'join connections') return null;
  if (!['eror', 'error', 'fatal', 'warn'].includes(level) &&
      !INTERESTING.test(message) && !INTERESTING.test(detail)) return null;
  const parts = [level || 'info', redact(message, secrets), redact(detail, secrets)].filter(Boolean);
  return { code, diagnostic: parts.join(' | ').slice(0, MAX_DETAIL * 2) };
}

export function createNgrokLogReader(onRecord, secrets = []) {
  let pending = '';
  const emit = (line) => {
    const record = inspectNgrokLogLine(line, secrets);
    if (record) onRecord(record);
  };
  return {
    write(chunk) {
      pending += String(chunk);
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        emit(pending.slice(0, newline).replace(/\r$/, ''));
        pending = pending.slice(newline + 1);
      }
      if (pending.length > MAX_LINE) pending = pending.slice(-MAX_LINE);
    },
    flush() {
      if (pending) emit(pending);
      pending = '';
    },
  };
}
