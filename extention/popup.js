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
    $('profileToken').placeholder=state.profileTokenConfigured
      ? 'Connection key saved for this profile (leave blank to keep it)'
      : 'Paste the desktop connection key';
  } catch (error) {
    $('status').textContent = 'Extension background unavailable';
    $('status').className = 'status bad';
    $('next-step').textContent = 'Reload the extension in your browser extensions page and reopen this popup.';
  }
}

$('save').addEventListener('click', async () => {
  const button = $('save');
  const url = $('serverUrl').value.trim();
  const profileToken=$('profileToken').value.trim();
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
  if(profileToken && !/^[a-f0-9]{64}$/i.test(profileToken)) {
    $('next-step').textContent='Connection key must be the 64-character key copied from the desktop application.';
    return;
  }
  button.disabled = true;
  button.textContent = 'Reconnecting…';
  try {
    await chrome.storage.local.set({serverUrl:url,
      ...(profileToken?{profileToken}:{})});
    $('profileToken').value='';
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
$('pair').addEventListener('click', async () => {
  const button = $('pair');
  button.disabled = true;
  $('pairCode').value = '';
  try {
    const result = await chrome.runtime.sendMessage({type:'create_pairing_offer',approve_parent:true});
    if (result?.ok !== true || !result.code)
      throw new Error(result?.error || 'Could not prepare a pairing code');
    $('pairCode').value = result.code;
    $('next-step').textContent = result.role === 'child'
      ? 'Managed Child paired for its existing Parent hierarchy. Invoke pair_conversation in this Child conversation.'
      : result.initialization_status === 'SENT'
        ? 'Parent setup sent automatically. ChatGPT must still complete MCP pairing.'
        : 'Parent approved; setup delivery is uncertain. Inspect this chat before retrying.';
  } catch (error) {
    $('next-step').textContent = String(error?.message || error);
  } finally {
    button.disabled = false;
  }
});
refresh(true);
