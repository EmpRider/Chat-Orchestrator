const $ = (id) => document.getElementById(id);

async function refresh(fillFields = false) {
  const status = await chrome.runtime.sendMessage({type: 'popup_status'});
  const connected = status.wsState === 'connected' && status.settingsSynced;
  $('status').textContent = status.wsState === 'connected' && !status.settingsSynced
    ? 'Connected · Settings not authorized (use the extension-only token)'
    : `Proxy: ${status.wsState} · ${status.settingsSynced ? 'Settings synced' : 'Not synced'}`;
  $('status').className = `status ${connected ? 'ok' : 'bad'}`;
  $('info').textContent = `Worker tabs: ${status.workers.length} · Running: ${status.running} · Private queue: ${status.coordinationMode || 'unknown'}`;
  if (fillFields) {
    $('serverUrl').value = status.cfg.serverUrl;
    $('token').value = status.cfg.token;
  }
}

$('save').addEventListener('click', async () => {
  const url = $('serverUrl').value.trim();
  const token = $('token').value.trim();
  let validUrl = false;
  try {
    const parsed = new URL(url);
    validUrl = (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') &&
      parsed.pathname === '/bridge' && !parsed.username && !parsed.password;
  } catch {}
  if (!validUrl || !token || token.length > 256) {
    $('status').textContent = 'Enter a valid bridge WebSocket URL and extension-only token.';
    $('status').className = 'status bad';
    return;
  }
  await chrome.storage.local.set({serverUrl: url, token});
  await chrome.runtime.sendMessage({type: 'reconnect'});
  setTimeout(() => refresh(false), 650);
});

refresh(true);
