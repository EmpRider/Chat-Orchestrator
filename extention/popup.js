const $ = (id) => document.getElementById(id);

async function refresh(fillFields = false) {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'popup_status' });
    const connected = state.wsState === 'connected';
    const synced = connected && Boolean(state.settingsSynced);
    $('status').textContent = synced ? 'Connected - Settings synchronized'
      : connected ? 'Connected - Synchronizing settings'
      : 'Disconnected - Check local proxy';
    $('status').className = 'status ' + (connected ? 'ok' : 'bad');
    $('next-step').textContent = synced
      ? 'Ready. Continue from the Orchestrator desktop or ChatGPT.'
      : connected ? 'Waiting for settings from the desktop proxy.'
      : 'Start the desktop proxy, confirm its port, then Save and reconnect.';
    $('info').textContent = 'Workers: ' + state.workers.length +
      ' · Running: ' + state.running +
      ' · Queue: ' + (state.coordinationMode || 'unknown');
    if (fillFields) $('serverUrl').value = state.cfg.serverUrl;
  } catch (error) {
    $('status').textContent = 'Extension background unavailable';
    $('status').className = 'status bad';
    $('next-step').textContent = 'Reload the extension in your browser extensions page and reopen this popup.';
  }
}

$('save').addEventListener('click', async () => {
  const button = $('save');
  const url = $('serverUrl').value.trim();
  let validUrl = false;
  try {
    const parsed = new URL(url);
    validUrl = (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') &&
      parsed.pathname === '/bridge' && !parsed.username && !parsed.password;
  } catch {}
  if (!validUrl) {
    $('status').textContent = 'Enter a valid WebSocket URL';
    $('status').className = 'status bad';
    $('next-step').textContent = 'Use the WebSocket URL from the desktop Connections page.';
    return;
  }
  button.disabled = true;
  button.textContent = 'Reconnecting…';
  try {
    await chrome.storage.local.set({ serverUrl: url });
    await chrome.runtime.sendMessage({ type: 'reconnect' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    await refresh(false);
  } catch {
    $('status').textContent = 'Could not reconnect';
    $('status').className = 'status bad';
    $('next-step').textContent = 'Confirm the desktop proxy is running at this URL.';
  } finally {
    button.disabled = false;
    button.textContent = 'Save and reconnect';
  }
});
refresh(true);
