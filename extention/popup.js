const $ = (id) => document.getElementById(id);

async function refresh(fillFields = false) {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'popup_status' });
    const connected = state.wsState === 'connected';
    const synced = connected && Boolean(state.settingsSynced);
    $('status').textContent = synced ? 'Connected · Settings synchronized'
      : connected ? 'Connected · Credential needs attention'
      : 'Disconnected · Check local proxy';
    $('status').className = 'status ' + (synced ? 'ok' : 'bad');
    $('next-step').textContent = synced
      ? 'Your browser extension is ready. Continue from the Orchestrator desktop or ChatGPT.'
      : connected
        ? 'Open Connections in the desktop app, copy the extension-only credential, paste it below, then Save and reconnect.'
        : 'Start the Orchestrator desktop proxy, confirm its local port, then Save and reconnect here.';
    $('info').textContent = 'Workers: ' + state.workers.length +
      ' · Running: ' + state.running +
      ' · Queue: ' + (state.coordinationMode || 'unknown');
    if (fillFields) {
      $('serverUrl').value = state.cfg.serverUrl;
      $('token').value = state.cfg.token;
    }
  } catch (error) {
    $('status').textContent = 'Extension background unavailable';
    $('status').className = 'status bad';
    $('next-step').textContent = 'Reload the extension in your browser extensions page and reopen this popup.';
  }
}

$('save').addEventListener('click', async () => {
  const button = $('save');
  const url = $('serverUrl').value.trim();
  const token = $('token').value.trim();
  let validUrl = false;
  try {
    const parsed = new URL(url);
    validUrl = (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') &&
      parsed.pathname === '/bridge' && !parsed.username && !parsed.password;
  } catch {}
  if (!validUrl || !token || token.length > 256) {
    $('status').textContent = 'Connection details are incomplete';
    $('status').className = 'status bad';
    $('next-step').textContent = 'Enter a valid local WebSocket URL and the extension-only credential copied from the desktop app.';
    return;
  }
  button.disabled = true;
  button.textContent = 'Reconnecting…';
  try {
    await chrome.storage.local.set({ serverUrl: url, token });
    await chrome.runtime.sendMessage({ type: 'reconnect' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    await refresh(false);
  } catch {
    $('status').textContent = 'Could not reconnect';
    $('status').className = 'status bad';
    $('next-step').textContent = 'Confirm the proxy is running and the extension-only credential belongs to the same desktop profile.';
  } finally {
    button.disabled = false;
    button.textContent = 'Save and reconnect';
  }
});
refresh(true);
