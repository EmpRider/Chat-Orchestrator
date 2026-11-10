// Read-only discovery of already-running LOCAL ngrok agents. Another process
// may own a tunnel left behind after a Desktop crash; it must NEVER be killed
// or reconfigured merely to reclaim a public endpoint.
const API_PORTS = Object.freeze(Array.from({length: 16}, (_, i) => 4040 + i));
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function matchingNgrokTunnel(records, domain, proxyPort) {
  let expected;
  try { expected = new URL(domain); } catch { return false; }
  if (expected.protocol !== 'https:' || expected.pathname !== '/' ||
      expected.search || expected.hash || !Number.isSafeInteger(proxyPort)) return false;
  if (!records || !Array.isArray(records.tunnels)) return false;
  return records.tunnels.some((tunnel) => {
    if (!tunnel || typeof tunnel.public_url !== 'string') return false;
    let publicUrl;
    let localTarget;
    try {
      publicUrl = new URL(tunnel.public_url);
      const addr = tunnel.config?.addr;
      if (typeof addr !== 'string') return false;
      localTarget = new URL(/^\d+$/.test(addr) ? 'http://localhost:'+addr : addr);
    } catch { return false; }
    return publicUrl.origin === expected.origin &&
      publicUrl.protocol === 'https:' &&
      LOOPBACK_HOSTS.has(localTarget.hostname.toLowerCase()) &&
      localTarget.protocol === 'http:' &&
      Number(localTarget.port || 80) === proxyPort &&
      (localTarget.pathname === '/' || localTarget.pathname === '') &&
      !localTarget.username && !localTarget.password;
  });
}

export async function findReusableNgrokTunnel(domain, proxyPort, {
  fetchImpl = fetch, ports = API_PORTS, timeoutMs = 550,
} = {}) {
  if (!Number.isSafeInteger(proxyPort) || proxyPort < 1024 || proxyPort > 65535)
    return null;
  const responses = await Promise.all(ports.map(async (apiPort) => {
    if (!Number.isSafeInteger(apiPort) || apiPort < 1024 || apiPort > 65535)
      return null;
    try {
      const response = await fetchImpl('http://127.0.0.1:'+apiPort+'/api/tunnels', {
        signal:AbortSignal.timeout(timeoutMs),
      });
      if (!response?.ok) return null;
      const records = await response.json();
      return matchingNgrokTunnel(records,domain,proxyPort) ? {apiPort} : null;
    } catch {
      return null; // Failed discovery is not authorization to kill processes.
    }
  }));
  const matches = responses.filter(Boolean);
  // Two different agents claiming to own the same endpoint is ambiguous.
  return matches.length === 1 ? matches[0] : null;
}

export function describeNgrokExit(code) {
  if (code === 'ERR_NGROK_320') {
    return 'ngrok says this domain belongs to another account (ERR_NGROK_320). Check the authtoken for the account that owns this domain.';
  }
  if (code === 'ERR_NGROK_334') {
    return 'The ngrok domain is already online in another tunnel (ERR_NGROK_334). An existing agent may still be running. Close that endpoint in ngrok or use the matching local tunnel; unrelated ngrok processes are never stopped automatically.';
  }
  return 'ngrok stopped. Check the dedicated domain and authtoken'+(code?' ('+code+')':'')+'.';
}
