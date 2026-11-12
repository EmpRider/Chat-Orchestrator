const $ = (id) => document.getElementById(id);
let currentState;
let domainDirty = false;
let proxyPortDirty = false;
let showSavedTabHistory = false;
let lastCoordinationSnapshot = null;

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
  const queue = state.coordinationState === 'disabled' ? 'Queue off'
    : state.coordinationState === 'private_ready' ? 'Private storage ready'
    : state.coordinationState === 'active' ? 'Queue active' : 'Queue unknown';
  $('extension-detail').textContent = `WebSocket · ${queue}`;
  $('extension-settings-sync').textContent = state.extensionConnected && state.agentSettingsSyncRevision
    ? `Extension applied revision ${state.agentSettingsSyncRevision}`
    : state.extensionConnected ? 'Awaiting settings acknowledgement' : 'Sync on next connection';
  $('ngrok-state').textContent = state.routeVerified ? 'Online'
    : state.ngrokPhase === 'error' ? 'Error'
    : state.ngrokPhase === 'starting' ? 'Connecting…'
    : state.domain ? 'Offline' : 'Not configured';
  $('ngrok-dot').className = 'dot' + (state.routeVerified ? ' ok' : state.ngrokPhase === 'error' ? ' error' : '');
  $('ngrok-detail').textContent = state.ngrokPhase === 'error'
    ? 'Check connection settings'
    : state.ngrokReused && state.routeVerified
      ? 'Existing local ngrok tunnel reused · public MCP route verified'
      : state.ngrokReused ? 'Checking existing local ngrok tunnel'
      : state.routeVerified ? 'Public MCP route verified' : 'Dedicated domain';
  $('ngrok-token-status').textContent = state.ngrokAuthConfigured ? '(saved securely)' : '(required)';
  $('ngrok-token').placeholder = state.ngrokAuthConfigured ? 'Leave blank to keep saved token' : 'Paste your ngrok authtoken';
  $('start').disabled = state.phase === 'starting' || state.phase === 'stopping'
    || (state.phase === 'running' && (state.ngrokPhase === 'running' || state.ngrokPhase === 'starting'));
  $('stop').disabled = (state.phase === 'stopped' && state.ngrokPhase === 'stopped') || state.phase === 'stopping' || state.ngrokPhase === 'stopping';
  $('minimize-to-tray').checked = state.minimizeToTray !== false;
  $('minimize-to-tray').disabled = state.trayAvailable === false;
  $('configure-private-coordination').textContent = state.privateCoordinationOptIn
    ? 'Disable private queue on next proxy start' : 'Prepare & enable queue on next proxy start';
  const journal = state.privateJournalInspection;
  $('private-journal-inspection').textContent = journal?.error
    ? 'Private journal cannot be inspected safely; keep queue off and reconcile manually.'
    : journal?.lockPresent
      ? 'Journal ' + journal.bytes + ' bytes · owner lock exists, liveness unverified. After crash do not remove/replay automatically.'
      : journal?.present
        ? 'Journal ' + journal.bytes + ' bytes · no lock. Full integrity is checked by the proxy at startup.'
        : state.privateCoordinationOptIn
        ? 'Queue journal will be provisioned before the proxy starts.'
        : 'Private journal not provisioned; queue disabled for this profile.';
  $('private-coordination-state').textContent = state.privateCoordinationRestartRequired
    ? 'Restart the local proxy to apply this change. UNCERTAIN events need manual reconciliation.'
    : state.privateCoordinationOptIn
      ? 'Private queue selected. Startup refuses stale locks or corrupt journals.'
      : 'Queue disabled for this profile. Journal provisioning makes no power-loss guarantee on Windows.';
  // Health polling updates the dashboard while users edit both fields.
  // Preserve the unsaved hostname even after focus moves to the authtoken.
  if (!domainDirty) $('domain').value = state.domain;
  $('connector-url').textContent = state.domain
    ? `${state.domain}${state.publicPath}`
    : 'Enter your ngrok domain above';
  $('copy-url').disabled = !state.domain;
  if (state.error || state.ngrokError) notify([state.error, state.ngrokError].filter(Boolean).join(' · '), true);
  else if (state.routeVerified && !wasVerified) notify('Ngrok tunnel verified. Copy the connector URL into ChatGPT.');
}

function renderCoordinationSnapshot(snapshot) {
  lastCoordinationSnapshot = snapshot;
  const presenceSummary = $('tab-presence-summary');
  const historyToggle = $('toggle-tab-history');
  const summary = $('coordination-summary');
  const seats = $('agent-seats');
  const hierarchy = $('tab-hierarchy');
  const queue = $('queue-items');
  const tools = $('tool-call-log');
  if (!summary || !seats || !hierarchy || !queue || !tools) return;
  if (!snapshot) {
    summary.textContent = 'Proxy disconnected · state unknown';
    seats.textContent = 'Unknown'; hierarchy.textContent = 'Unknown';
    queue.textContent = 'Unknown'; tools.textContent = 'Unknown';
    if (presenceSummary) presenceSummary.textContent = 'Browser state unavailable';
    if (historyToggle) historyToggle.hidden = true;
    return;
  }
  const phases = snapshot.phases || {};
  const hiddenPending = Number.isSafeInteger(snapshot.hiddenPending) ? snapshot.hiddenPending : 0;
  summary.textContent = `${snapshot.storageReady ? 'Private storage ready' : 'Queue off'} · ${phases.QUEUED || 0} queued · ${phases.UNCERTAIN || 0} uncertain` +
    (hiddenPending ? ` · ${hiddenPending} need manual reconciliation` : '');
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
    `${seat.seatName} · ${seat.readiness || 'unknown'} · ${seat.deliveryArmed ? 'armed' : seat.registered ? 'registered' : 'available'} · tab ${seat.callerTabId} · session ${seat.browserSessionId || 'unknown'}`,
    snapshot.registryError ? 'Queue state error' : 'No active seats');
  const recorded = Array.isArray(snapshot.tabHierarchy) ? snapshot.tabHierarchy : [];
  const presence = snapshot.browserTabs;
  const observed = presence?.status === 'observed';
  const openTabs = observed && Array.isArray(presence.tabs) ? presence.tabs : [];
  const liveRecords = recorded.filter((entry) => entry.presence === 'open_unverified');
  const staleRecords = recorded.filter((entry) => entry.presence !== 'open_unverified');
  // Discovery of a numeric tab ID is not attestation of its saved session.
  const displayed = showSavedTabHistory || !observed ? recorded : liveRecords;
  if (presenceSummary) {
    presenceSummary.textContent = observed
      ? `${openTabs.length} open chat tab(s) detected · ${liveRecords.length} matching saved ID(s) (identity unverified) · ${staleRecords.length} historical/mismatched registration(s)`
      : 'Live browser observation unavailable · saved registrations are not confirmed open';
  }
  if (historyToggle) {
    historyToggle.hidden = !observed || staleRecords.length === 0;
    historyToggle.textContent = showSavedTabHistory
      ? 'Hide saved history'
      : `Show saved history (${staleRecords.length})`;
  }
  rows(hierarchy, displayed, (entry) => {
    const relation = entry.parentTabId == null
      ? `Root tab ${entry.tabId} · ${entry.site}`
      : `↳ Tab ${entry.tabId} · parent ${entry.parentTabId} · root ${entry.rootTabId} · ${entry.site} · ${entry.phase || 'unknown'}`;
    const status = entry.presence === 'open_unverified' ? 'open ID (identity unverified)'
      : entry.presence === 'not_open' ? 'not currently open'
      : entry.presence === 'site_mismatch' ? 'site changed / possible tab reuse'
      : 'presence unknown';
    return `${relation} · session ${entry.browserSessionId || 'unknown'} · ${status}`;
  }, observed
    ? openTabs.length
      ? `${openTabs.length} chat tab(s) open, but none matches a saved registration`
      : 'No saved registrations currently open'
    : 'No saved tab relationships');
  rows(queue, (snapshot.queue || []).slice(-8), (item) =>
    `${item.type} · ${item.phase} · tab ${item.managerTabId} · ${item.eventId.slice(0, 8)}`,
    snapshot.storageReady
      ? hiddenPending > 0 ? `${hiddenPending} pending event(s) held for manual reconciliation` : 'No queued events'
      : 'Queue not active');
  rows(tools, (snapshot.toolCalls || []).slice(-8).reverse(), (item) =>
    `${item.method} · ${item.ok ? 'OK' : 'ERROR'} · ${item.durationMs}ms · ${item.caller}`,
    'No tool calls recorded');
}

$('toggle-tab-history')?.addEventListener('click', () => {
  showSavedTabHistory = !showSavedTabHistory;
  renderCoordinationSnapshot(lastCoordinationSnapshot);
});

async function perform(action, successMessage) {
  try {
    await action();
    if (successMessage) notify(successMessage);
  } catch (error) {
    notify(error.message || String(error), true);
  }
}

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
window.bridge.onState(render);
perform(async () => render(await window.bridge.status()));

// Extension behavior is edited only through trusted desktop IPC, never WebSocket writes.
let agentDraft = null;
let agentDefaults = null;
let activePromptModule = 'core';
function flushPromptDraft() {
  if(agentDraft)agentDraft.promptModules[activePromptModule]=$('agent-prompt-text').value;
}
function displayAgentSettings(settings) {
  $('agent-enabled').checked=settings.enabled;
  $('agent-max-workers').value=String(settings.maxWorkers);
  $('agent-max-tasks').value=String(settings.maxTasksPerHour);
  $('agent-timeout').value=String(settings.taskTimeoutMin);
  activePromptModule='core';
  $('agent-prompt-module').value=activePromptModule;
  $('agent-prompt-text').value=settings.promptModules[activePromptModule];
}
async function loadAgentSettings() {
  [agentDraft,agentDefaults]=await Promise.all([window.bridge.getAgentSettings(),window.bridge.getDefaultAgentSettings()]);
  displayAgentSettings(agentDraft);
  $('agent-settings-message').textContent='Loaded. Changes are local until Save.';
}
$('extension-settings-panel').addEventListener('toggle',()=>{
  if($('extension-settings-panel').open&&!agentDraft)perform(loadAgentSettings);
});
$('agent-prompt-module').addEventListener('change',()=>{
  if(!agentDraft)return;
  flushPromptDraft();
  activePromptModule=$('agent-prompt-module').value;
  $('agent-prompt-text').value=agentDraft.promptModules[activePromptModule];
});
$('agent-prompt-reset').addEventListener('click',()=>{
  if(!agentDraft||!agentDefaults)return;
  agentDraft.promptModules[activePromptModule]=agentDefaults.promptModules[activePromptModule];
  $('agent-prompt-text').value=agentDraft.promptModules[activePromptModule];
  $('agent-settings-message').textContent='Module reset in editor. Click Save to apply.';
});
$('agent-prompt-preview').addEventListener('click',()=>perform(async()=>{
  if(!agentDraft)throw Error('Load settings before preview');
  flushPromptDraft();
  const output=$('agent-prompt-preview-output');
  const kind=['queue','child_result','status_request','child_tab_lost','failure'].includes(activePromptModule)?'queue':'task';
  const eventType={child_result:'CHILD_RESULT',status_request:'STATUS_REQUEST',child_tab_lost:'CHILD_TAB_LOST',failure:'TOOL_FAILURE'}[activePromptModule]||'STATUS_REQUEST';
  output.textContent=await window.bridge.previewPrompt(
    kind==='queue' ? {kind:'queue',batchId:'preview-only',events:[{event_id:'preview-only',type:eventType,summary:'Example event'}],promptModules:agentDraft.promptModules} :
    {kind:'task',operation:activePromptModule==='workspace'?'workspace':activePromptModule==='delegation'?'delegation':'task',
    task:'Example task; no action is executed.',promptModules:agentDraft.promptModules});
  output.hidden=false;
},'Preview generated without browser submission.'));
$('agent-reset-all').addEventListener('click', () => {
  if (!agentDefaults) return;
  agentDraft = structuredClone(agentDefaults);
  displayAgentSettings(agentDraft);
  $('agent-settings-message').textContent = 'All defaults loaded in editor. Click Save to apply.';
});
function selectedAdminTab() {
  const raw = $('agent-admin-tab').value.trim();
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error('Enter a positive browser chat tab ID');
  return Number(raw);
}
async function performAgentAction(action, tabId) {
  const result = await window.bridge.extensionAction(action, tabId);
  $('agent-admin-output').hidden = false;
  $('agent-admin-output').textContent = JSON.stringify(result, null, 2);
}
$('agent-set-orchestrator').addEventListener('click', () => perform(() =>
  performAgentAction('set_orchestrator', selectedAdminTab()), 'Legacy orchestrator tab set.'));
$('agent-diagnose-tab').addEventListener('click', () => perform(() =>
  performAgentAction('diagnose', selectedAdminTab()), 'Tab diagnostics received.'));
let rootRepairOffer=null;
$('agent-inspect-root').addEventListener('click',()=>perform(async()=>{
  rootRepairOffer=null;
  $('agent-confirm-root').disabled=true;
  const tabId=selectedAdminTab();
  const browserSessionId=$('agent-admin-session').value.trim() || undefined;
  const result=await window.bridge.extensionAction('inspect_root_repair',tabId,undefined,browserSessionId);
  $('agent-admin-output').hidden=false;
  $('agent-admin-output').textContent=JSON.stringify(result,null,2);
  if(result.can_reconcile && result.confirmation_nonce){
    rootRepairOffer={tabId,nonce:result.confirmation_nonce,
      browserSessionId:result.browser_session_id};
    $('agent-confirm-root').disabled=false;
  }
},'Root inspection complete. Unsafe recoveries remain blocked.'));
$('agent-confirm-root').addEventListener('click',()=>perform(async()=>{
  const offer=rootRepairOffer;
  rootRepairOffer=null;
  $('agent-confirm-root').disabled=true;
  if(!offer || offer.tabId!==selectedAdminTab() ||
      ($('agent-admin-session').value.trim() && $('agent-admin-session').value.trim()!==offer.browserSessionId))
    throw Error('Inspect the same root and browser session again first');
  if(!window.confirm('Re-attest this root? No FIFO events will be replayed or acknowledged.'))return;
  const result=await window.bridge.extensionAction('confirm_root_repair',offer.tabId,offer.nonce,
    offer.browserSessionId);
  $('agent-admin-output').hidden=false;
  $('agent-admin-output').textContent=JSON.stringify(result,null,2);
},'Root recovered. Register it again using Worker Tool.'));
$('agent-close-legacy').addEventListener('click', () => perform(() =>
  performAgentAction('close_legacy_workers'), 'Legacy closure request finished; inspect held count.'));
$('agent-settings-save').addEventListener('click', () => perform(async () => {
  if (!agentDraft) throw new Error('Open the panel to load profile settings first');
  flushPromptDraft();
  const candidate = {
    enabled: $('agent-enabled').checked,
    maxWorkers: Number($('agent-max-workers').value),
    maxTasksPerHour: Number($('agent-max-tasks').value),
    taskTimeoutMin: Number($('agent-timeout').value),
    promptSchema: agentDraft.promptSchema,
    promptModules: agentDraft.promptModules,
  };
  agentDraft = await window.bridge.saveAgentSettings(candidate);
  $('agent-settings-message').textContent = 'Saved to this profile. Sync sent to connected extension, otherwise sent on next connection.';
}, 'Extension settings saved to this proxy profile.'));