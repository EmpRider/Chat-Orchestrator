const $ = (id) => document.getElementById(id);
let currentState;
let visibleToken = false;
let domainDirty = false;
let proxyPortDirty = false;

function notify(message, isError = false) {
  $('message').textContent = message;
  $('message').style.color = isError ? '#ff98a8' : '#a4a4af';
}

function render(state) {
  const wasVerified = Boolean(currentState?.routeVerified);
  currentState = state;
  renderCoordinationSnapshot(state.coordinationSnapshot);
  $('overall').textContent = state.phase === 'running' ? 'Server running' : state.phase;
  $('overall').className = 'pill' + (state.phase === 'running' ? '' : state.phase === 'error' ? ' error' : ' muted');
  $('server-state').textContent = state.phase[0].toUpperCase() + state.phase.slice(1);
  $('proxy-port-label').textContent = `localhost:${state.port ?? 8787}`;
  const portLocked = state.phase !== 'stopped' || state.ngrokPhase !== 'stopped';
  $('proxy-port').disabled = portLocked;
  $('save-proxy-port').disabled = portLocked;
  if (!proxyPortDirty) $('proxy-port').value = String(state.port ?? 8787);
  $('profile-description').textContent = `Profile: ${state.profile || 'default'} · Port ${state.port ?? 8787}. Stop proxy and Ngrok to change. Launch another with --profile=name.`;
  $('extension-local-url').textContent = state.localWebSocketUrl || `ws://127.0.0.1:${state.port ?? 8787}/bridge`;
  $('server-dot').className = 'dot' + (state.phase === 'running' ? ' ok' : state.phase === 'error' ? ' error' : '');
  $('extension-state').textContent = state.extensionConnected ? 'Connected' : 'Disconnected';
  $('extension-dot').className = 'dot' + (state.extensionConnected ? ' ok' : '');
  const pairing = state.principalState === 'enrolled' ? 'Paired'
    : state.principalState === 're_pair_required' ? 'Re-pair required'
    : state.principalState === 'not_enrolled' ? 'Unpaired'
    : state.principalState === 'error' ? 'Pairing error' : 'Identity unknown';
  const queue = state.coordinationState === 'disabled' ? 'Queue off'
    : state.coordinationState === 'private_ready' ? 'Private storage ready'
    : state.coordinationState === 'active' ? 'Queue active' : 'Queue unknown';
  $('extension-detail').textContent = `WebSocket · ${pairing} · ${queue}`;
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
  $('configure-private-coordination').textContent = state.privateCoordinationOptIn
    ? 'Disable private queue on next proxy start' : 'Prepare & enable queue on next proxy start';
  $('private-coordination-state').textContent = state.privateCoordinationRestartRequired
    ? 'Restart the local proxy to apply this change. UNCERTAIN events need manual reconciliation.'
    : state.privateCoordinationOptIn
      ? 'Private queue selected. Startup refuses stale locks or corrupt journals.'
      : 'Default off. Journal provisioning makes no power-loss guarantee on Windows.';
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

function renderCoordinationSnapshot(snapshot) {
  const summary = $('coordination-summary');
  const seats = $('agent-seats');
  const queue = $('queue-items');
  const tools = $('tool-call-log');
  if (!summary || !seats || !queue || !tools) return;
  if (!snapshot) {
    summary.textContent = 'Proxy disconnected · state unknown';
    seats.textContent = 'Unknown'; queue.textContent = 'Unknown'; tools.textContent = 'Unknown';
    return;
  }
  const phases = snapshot.phases || {};
  const hiddenPending = Number.isSafeInteger(snapshot.hiddenPending) ? snapshot.hiddenPending : 0;
  summary.textContent = `${snapshot.storageReady ? 'Private storage ready' : 'Queue off'} · ${phases.QUEUED || 0} queued · ${phases.UNCERTAIN || 0} uncertain` +
    (hiddenPending ? ` · ${hiddenPending} require re-pair/reconciliation` : '');
  function rows(target, items, makeText, emptyText) {
    target.textContent = '';
    if (!items?.length) { target.textContent = emptyText; return; }
    for (const item of items) {
      const line = document.createElement('div');
      line.className = 'coordination-row';
      line.textContent = makeText(item);
      target.append(line);
    }
  }
  rows(seats, snapshot.seats, (seat) =>
    `${seat.seatName} · ${seat.readiness || 'unknown'} · ${seat.deliveryArmed ? 'armed' : seat.registered ? 'registered' : 'paired'} · tab ${seat.callerTabId}`,
    snapshot.registryError ? 'Registry error' : 'No paired seats');
  rows(queue, (snapshot.queue || []).slice(-8), (item) =>
    `${item.type} · ${item.phase} · tab ${item.managerTabId} · ${item.eventId.slice(0, 8)}`,
    snapshot.storageReady
      ? hiddenPending > 0 ? `${hiddenPending} pending event(s) hidden until trusted re-pair; no automatic replay` : 'No queued events'
      : 'Queue not active');
  rows(tools, (snapshot.toolCalls || []).slice(-8).reverse(), (item) =>
    `${item.method} · ${item.ok ? 'OK' : 'ERROR'} · ${item.durationMs}ms · ${item.caller}`,
    'No tool calls recorded');
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
$('copy-extension-token').addEventListener('click', () => perform(() => window.bridge.copyExtensionToken(), 'Extension-only token copied. Paste into the browser extension settings.'));
$('copy-url').addEventListener('click', () => perform(() => window.bridge.copyUrl(), 'Connector URL copied. Keep it private.'));
$('domain').addEventListener('input', () => { domainDirty = true; });
$('proxy-port').addEventListener('input', () => { proxyPortDirty = true; });
$('save-proxy-port').addEventListener('click', () => perform(async () => {
  const saved = await window.bridge.configurePort($('proxy-port').value);
  proxyPortDirty = false;
  render(saved);
  notify(`Port ${saved.port} saved for ${saved.profile || 'default'}. Start the proxy to apply it.`);
}));
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
$('configure-private-coordination').addEventListener('click', () => perform(async () => {
  const enabled = currentState?.privateCoordinationOptIn !== true;
  render(await window.bridge.configurePrivateCoordination(enabled));
  notify(enabled ? 'Private journal prepared; restart the proxy to activate.' : 'Private queue disabled on next proxy start. Restart to apply.');
}));
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

let oneTimePrincipalToken = null;
function checkedPairTabId() {
  const raw = $('pair-tab').value.trim();
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error('Enter an actual positive manager tab ID');
  return Number(raw);
}
async function refreshPrincipals() {
  const list = $('principal-list');
  list.textContent = '';
  for (const principal of await window.bridge.listPrincipals()) {
    const line = document.createElement('div');
    line.className = 'principal-row';
    const description = document.createElement('span');
    description.textContent = `${principal.seatName || principal.role.toUpperCase()} · ${principal.projectId} · tab ${principal.callerTabId}` +
      (principal.revokedAt ? ' · Revoked' : !principal.browserSessionId ? ' · Re-pair required' : '');
    line.append(description);
    if (!principal.revokedAt) {
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'link-button';
      revoke.textContent = 'Revoke';
      revoke.addEventListener('click', () => perform(async () => {
        await window.bridge.revokePrincipal(principal.credentialId);
        await refreshPrincipals();
      }, 'Scoped credential revoked.'));
      line.append(revoke);
    }
    list.append(line);
  }
}
$('principal-panel').addEventListener('toggle', () => {
  if ($('principal-panel').open) perform(refreshPrincipals);
});
$('pair-principal').addEventListener('click', () => perform(async () => {
  const result = await window.bridge.enrollPrincipal({
    role: $('pair-role').value,
    seatName: $('pair-seat').value || $('pair-role').value.toUpperCase(),
    workspaceId: $('pair-workspace').value,
    projectId: $('pair-project').value,
    orchestratorId: $('pair-orchestrator').value,
    parentTaskId: $('pair-parent-task').value,
    callerTabId: checkedPairTabId(),
  });
  oneTimePrincipalToken = result.token;
  $('copy-principal-url').disabled = false;
  await refreshPrincipals();
  notify('Scoped identity created. Copy its URL now; it is not shown again.');
}));
$('copy-principal-url').addEventListener('click', () => perform(async () => {
  if (!oneTimePrincipalToken) throw new Error('Create a new scoped identity first');
  await window.bridge.copyScopedUrl(oneTimePrincipalToken);
}, 'Scoped connector URL copied. Keep it private.'));
window.addEventListener('blur', () => {
  oneTimePrincipalToken = null;
  $('copy-principal-url').disabled = true;
});

$('pair-seat').addEventListener('change', () => {
  const seat = $('pair-seat').value;
  if (!seat) return;
  $('pair-role').value = seat.startsWith('Council') ? 'council'
    : seat === 'BA Watchdog' ? 'watchdog' : seat.toLowerCase();
});
