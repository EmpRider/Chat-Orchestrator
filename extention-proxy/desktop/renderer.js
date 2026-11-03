const $ = (id) => document.getElementById(id);
let currentState;
let visibleToken = false;
let domainDirty = false;

function notify(message, isError = false) {
  $('message').textContent = message;
  $('message').style.color = isError ? '#ff98a8' : '#a4a4af';
}

function render(state) {
  const wasVerified = Boolean(currentState?.routeVerified);
  currentState = state;
  $('overall').textContent = state.phase === 'running' ? 'Server running' : state.phase;
  $('overall').className = 'pill' + (state.phase === 'running' ? '' : state.phase === 'error' ? ' error' : ' muted');
  $('server-state').textContent = state.phase[0].toUpperCase() + state.phase.slice(1);
  $('server-dot').className = 'dot' + (state.phase === 'running' ? ' ok' : state.phase === 'error' ? ' error' : '');
  $('extension-state').textContent = state.extensionConnected ? 'Connected' : 'Disconnected';
  $('extension-dot').className = 'dot' + (state.extensionConnected ? ' ok' : '');
  $('ngrok-state').textContent = state.routeVerified ? 'Online'
    : state.ngrokPhase === 'error' ? 'Error'
    : state.ngrokPhase === 'starting' ? 'Connecting…'
    : state.domain ? 'Offline' : 'Not configured';
  $('ngrok-dot').className = 'dot' + (state.routeVerified ? ' ok' : state.ngrokPhase === 'error' ? ' error' : '');
  $('ngrok-detail').textContent = state.ngrokPhase === 'error'
    ? 'Check connection settings' : state.routeVerified ? 'Public MCP route verified' : 'Dedicated domain';
  $('ngrok-token-status').textContent = state.ngrokAuthConfigured ? '(saved securely)' : '(required)';
  $('ngrok-token').placeholder = state.ngrokAuthConfigured ? 'Leave blank to keep saved token' : 'Paste your ngrok authtoken';
  $('start').disabled = state.phase === 'starting' || state.phase === 'stopping'
    || (state.phase === 'running' && (state.ngrokPhase === 'running' || state.ngrokPhase === 'starting'));
  $('stop').disabled = (state.phase === 'stopped' && state.ngrokPhase === 'stopped') || state.phase === 'stopping' || state.ngrokPhase === 'stopping';
  $('minimize-to-tray').checked = state.minimizeToTray !== false;
  $('minimize-to-tray').disabled = state.trayAvailable === false;
  // Health polling updates the dashboard while users edit both fields.
  // Preserve the unsaved hostname even after focus moves to the authtoken.
  if (!domainDirty) $('domain').value = state.domain;
  $('connector-url').textContent = state.domain
    ? `${state.domain}${state.publicPath}?token=••••••••`
    : 'Enter your ngrok domain above';
  $('copy-url').disabled = !state.domain;
  if (state.error || state.ngrokError) notify([state.error, state.ngrokError].filter(Boolean).join(' · '), true);
  else if (state.routeVerified && !wasVerified) notify('Ngrok tunnel verified. Copy the connector URL into ChatGPT.');
}

async function perform(action, successMessage) {
  try {
    await action();
    if (successMessage) notify(successMessage);
  } catch (error) {
    notify(error.message || String(error), true);
  }
}

$('toggle-token').addEventListener('click', () => perform(async () => {
  visibleToken = !visibleToken;
  $('token-value').textContent = visibleToken ? await window.bridge.showToken() : '••••••••••••••••••••••••••••';
  $('toggle-token').setAttribute('aria-label', visibleToken ? 'Hide token' : 'Reveal token');
  $('toggle-token').title = visibleToken ? 'Hide token' : 'Reveal token';
  $('token-visibility-icon').src = visibleToken ? 'assets/hide.png' : 'assets/visible.png';
}));
$('copy-token').addEventListener('click', () => perform(() => window.bridge.copyToken(), 'Token copied to clipboard.'));
$('copy-url').addEventListener('click', () => perform(() => window.bridge.copyUrl(), 'Connector URL copied. Keep it private.'));
$('domain').addEventListener('input', () => { domainDirty = true; });
$('configure-ngrok').addEventListener('click', async () => {
  const button = $('configure-ngrok');
  button.disabled = true;
  try {
    const saved = await window.bridge.configureNgrok($('domain').value.trim(), $('ngrok-token').value);
    domainDirty = false;
    render(saved);
    notify('Settings saved. Connecting your dedicated ngrok tunnel…');
  } catch (error) {
    notify(error.message || String(error), true);
  } finally {
    $('ngrok-token').value = '';
    button.disabled = false;
  }
});
$('start').addEventListener('click', () => perform(async () => render(await window.bridge.start()), 'Starting local proxy…'));
$('stop').addEventListener('click', () => perform(async () => render(await window.bridge.stop()), 'Local proxy stopped.'));
$('import-token').addEventListener('click', () => perform(async () => {
  if (await window.bridge.importToken()) {
    visibleToken = false;
    $('token-value').textContent = '••••••••••••••••••••••••••••';
    $('toggle-token').setAttribute('aria-label', 'Reveal token');
    $('toggle-token').title = 'Reveal token';
    $('token-visibility-icon').src = 'assets/visible.png';
    notify('Existing bridge token imported. Reconnecting local proxy…');
  }
}));
$('minimize-to-tray').addEventListener('change', async () => {
  const checked = $('minimize-to-tray').checked;
  try {
    const saved = await window.bridge.setMinimizeToTray(checked);
    render(saved);
    notify(checked ? 'Closing this window will keep the proxy in the tray.' : 'Closing this window will exit and stop the proxy.');
  } catch (error) {
    $('minimize-to-tray').checked = currentState?.minimizeToTray !== false;
    notify(error.message || String(error), true);
  }
});
window.addEventListener('blur', () => {
  visibleToken = false;
  $('token-value').textContent = '••••••••••••••••••••••••••••';
  $('toggle-token').setAttribute('aria-label', 'Reveal token');
  $('toggle-token').title = 'Reveal token';
  $('token-visibility-icon').src = 'assets/visible.png';
});
window.bridge.onState(render);
perform(async () => render(await window.bridge.status()));
