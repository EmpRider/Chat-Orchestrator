import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// An explicit, credential-free CLI config avoids AgentBridge's default
// ngrok.yml. NGROK_AUTHTOKEN is supplied only through the child environment.
export const ISOLATED_NGROK_CONFIG = 'version: 3\nagent: {}\n';

export function normalizeNgrokDomain(input) {
  const value = String(input || '').trim();
  let url;
  try {
    const address = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
    url = new URL(address);
  } catch {
    throw new Error('Enter a valid ngrok hostname or HTTPS URL, for example example.ngrok-free.dev');
  }
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Enter only an ngrok hostname or HTTPS origin, without a path or query');
  }
  return url.origin;
}

export function connectorUrl(domain, token) {
  if (!domain || !token) return '';
  const url = new URL('/mcp', normalizeNgrokDomain(domain));
  url.searchParams.set('token', token);
  return url.toString();
}

export function normalizeNgrokAuthtoken(input) {
  const value = String(input || '').trim();
  if (value.length < 10 || value.length > 1024 || /\s/.test(value)) {
    throw new Error('Enter a valid ngrok authtoken (without spaces).');
  }
  return value;
}

export function ensureDesktopToken(file, legacyFile, overrideToken) {
  if (overrideToken) return overrideToken;
  if (fs.existsSync(file)) {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (!saved) throw new Error('The saved bridge token is empty. Import a valid token.');
    return saved;
  }

  let token = crypto.randomBytes(24).toString('hex');
  if (legacyFile && fs.existsSync(legacyFile)) {
    const legacy = fs.readFileSync(legacyFile, 'utf8').trim();
    if (legacy) token = legacy;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return token;
}
