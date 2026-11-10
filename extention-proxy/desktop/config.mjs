// An explicit, credential-free CLI config avoids AgentBridge's default
// ngrok.yml. NGROK_AUTHTOKEN is supplied only through the child environment.
export const ISOLATED_NGROK_CONFIG = 'version: 3\nagent: {}\n';

export const PRIVATE_QUEUE_PREFERENCE_SCHEMA = 1;
// The former implicit off state migrates once to the new on-by-default behavior.
// A deliberate opt-out saved after migration is still respected.
export function resolvePrivateQueuePreference(saved = {}) {
  return saved?.privateQueuePreferenceSchema === PRIVATE_QUEUE_PREFERENCE_SCHEMA
    ? saved.privateCoordinationOptIn !== false
    : true;
}

export function normalizeProxyPort(input) {
  const value = String(input ?? '').trim();
  if (!/^[0-9]{4,5}$/.test(value)) throw new Error('Enter a local port from 1024 to 65535');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Enter a local port from 1024 to 65535');
  }
  return port;
}

export function normalizeProfileName(input) {
  const name = String(input ?? 'default').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
    throw new Error('Profile must begin with a letter and use up to 32 letters, numbers, - or _');
  }
  return name;
}

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

export function connectorUrl(domain) {
  if (!domain) return '';
  return new URL('/mcp', normalizeNgrokDomain(domain)).toString();
}

export function normalizeNgrokAuthtoken(input) {
  const value = String(input || '').trim();
  if (value.length < 10 || value.length > 1024 || /\s/.test(value)) {
    throw new Error('Enter a valid ngrok authtoken (without spaces).');
  }
  return value;
}
