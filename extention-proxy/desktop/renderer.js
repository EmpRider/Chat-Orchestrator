const $ = (id) => document.getElementById(id);
let currentState;
let domainDirty = false;
let proxyPortDirty = false;
let browserSelectionDirty = false;
let connectorNameDirty = false;
let showSavedTabHistory = false;
let lastCoordinationSnapshot = null;
let journalRecoveryBusy=false;
let journalRecoveryFeedback='';
// Recovery feedback survives the periodic snapshot render that recreates rows.
const queueRecoveryFeedback = new Map();
const queueRecoveryBusy = new Set();
const completionDecisionBusy = new Set();
const completionDecisionFeedback = new Map();

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
  if (!connectorNameDirty) $('connector-name').value = state.connectorName ?? '';
  if (!browserSelectionDirty) $('managed-browser').value = state.managedBrowserSelection || 'none';
  if (!browserSelectionDirty) $('chromium-executable').value = state.customChromiumExecutable || '';
  $('chromium-executable-row').hidden=$('managed-browser').value!=='chromium';
  $('managed-browser-status').textContent = state.managedBrowserError ||
    (state.managedBrowserSelection==='none' ? 'Select your installed browser to create a dedicated profile.'
      : `Managed ${state.managedBrowserSelection} profile: ${state.managedBrowserPhase || 'selected'} · Extension: ${state.extensionConnected?'connected':'not yet connected'} · Identity: ${state.managedBrowserVerified?'live verified':state.onboardingComplete?'reverification required':'not yet verified'}`);
  $('open-managed-extensions').disabled = !state.managedBrowserSelection || state.managedBrowserSelection === 'none';
  const selected=Boolean(state.managedBrowserSelection && state.managedBrowserSelection!=='none');
  $('onboarding-panel').hidden=state.onboardingComplete===true;
  $('verify-managed-browser').disabled=!selected || !state.extensionConnected;
  $('repair-managed-browser').disabled=!selected || !state.extensionConnected;
  $('finish-onboarding').disabled=!state.managedBrowserVerified || !state.extensionConnected ||
    !state.connectorName || !state.agentSettingsSyncRevision || state.connectorRoutingSyncError===true;
  $('onboarding-status').textContent=state.onboardingComplete
    ? state.managedBrowserVerified
      ? 'Setup completed. The currently connected extension matches your saved browser enrollment.'
      : 'Setup was saved, but the live browser connection has not yet been reverified. Use Repair / Reverify if needed.'
    : !selected ? 'Step 1: choose and open a supported browser.'
    : !state.extensionConnected ? 'Step 2: install the extension in the dedicated browser and connect it to the Proxy.'
    : !state.managedBrowserVerified ? 'Step 3: confirm the connected extension is in the dedicated browser, then Verify.'
    : !state.connectorName ? 'Step 4: save the exact ChatGPT MCP connector name under One-time browser setup.'
    : !state.agentSettingsSyncRevision ? 'Step 5: reload the extension and verify the new connector-name settings sync.'
    : 'Step 6: click Finish setup. Your browser and named connector are verified.';
  $('connector-sync-status').textContent=!state.connectorName
    ? 'Connector name not set. Pairing is disabled until you save the exact ChatGPT connector name.'
    : !state.extensionConnected
      ? 'Connector: '+state.connectorName+' · Extension disconnected; waiting for verified settings sync.'
      : state.connectorRoutingSyncError
        ? 'Connector: '+state.connectorName+' · Outdated extension detected. Reload the bundled extension in the managed browser, then reconnect.'
        : state.agentSettingsSyncRevision
          ? 'Connector: '+state.connectorName+' · Extension verified connector routing, revision '+state.agentSettingsSyncRevision+'.'
          : 'Connector: '+state.connectorName+' · Waiting for extension routing verification. Reload extension if this persists.';
  $('unpacked-extension-path').textContent = state.unpackedExtensionPath || 'Unavailable';
  $('auto-start-windows').checked = state.autoStartWindows === true;
  $('profile-description').textContent = `Profile: ${state.profile || 'default'} · Port ${state.port ?? 8787}. Stop proxy and Ngrok to change. Launch another with --profile=name.`;
  $('extension-local-url').textContent = state.localWebSocketUrl || `ws://127.0.0.1:${state.port ?? 8787}/bridge`;
  $('server-dot').className = 'dot' + (state.phase === 'running' ? ' ok' : state.phase === 'error' ? ' error' : '');
  $('extension-state').textContent = state.extensionConnected ? 'Connected' : 'Disconnected';
  $('extension-dot').className = 'dot' + (state.extensionConnected ? ' ok' : '');
  const queue = state.coordinationState === 'disabled' ? 'Queue off'
    : state.coordinationState === 'private_ready' ? 'Private storage ready'
    : state.coordinationState === 'active' ? 'Queue active' : 'Queue unknown';
  $('extension-detail').textContent = `WebSocket · ${queue}`;
  $('extension-settings-sync').textContent = state.connectorRoutingSyncError && state.extensionConnected
    ? 'Outdated extension: reload in managed browser'
    : state.extensionConnected && state.agentSettingsSyncRevision
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
  const update=state.update||{};
  const pending=Boolean(update.pendingVersion);
  $('update-status').textContent=`Installed: ${update.currentVersion||'unknown'} · ${update.phase||'not checked'}`
    +(update.availableVersion?` · available: ${update.availableVersion}`:'')
    +(update.message?` — ${update.message}`:'');
  $('update-notice').hidden=!pending && update.phase!=='available';
  $('update-notice-text').textContent=pending
    ? `Update ${update.pendingVersion} pending — Agent work must finish first.`
    : `Update ${update.availableVersion||''} available (manual approval required).`;
  $('update-now').disabled=update.phase!=='available'||pending;
  $('cancel-update').disabled=!pending;
  $('configure-private-coordination').textContent = state.privateCoordinationOptIn
    ? 'Disable private queue on next proxy start' : 'Prepare & enable queue on next proxy start';
  const journal = state.privateJournalInspection;
  const recovery=state.journalRecovery||{};
  const recoveryNeeded=state.phase!=='running' &&
    (journal?.requiresManualOwnerCheck===true ||
      ['RECOVERY_INTERRUPTED','OWNER_UNVERIFIED','OWNER_MAY_BE_RUNNING',
        'JOURNAL_NOT_EMPTY','INSPECTION_FAILED'].includes(recovery.reason));
  $('journal-recovery-panel').hidden=!recoveryNeeded;
  $('journal-recovery-shortcut').hidden=!recoveryNeeded;
  $('journal-recovery-explanation').textContent=recoveryNeeded
    ? (recovery.ownerPid?'Owner PID '+recovery.ownerPid+' · ':'')+
      'Journal '+(journal?.bytes??'unknown')+' bytes · '+
      (recovery.explanation||'Inspect this profile before restarting.')
    : 'No journal ownership recovery required.';
  $('recover-empty-journal-lock').disabled=journalRecoveryBusy ||
    !recoveryNeeded || recovery.canRecover!==true;
  $('journal-recovery-feedback').textContent=journalRecoveryFeedback ||
    (recovery.canRecover
      ? 'Empty-journal recovery is available. Confirm no unfinished Agent work before archiving.'
      : 'Keep this profile stopped until the ownership and delivery status are verified.');
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
  const alerts=$('completion-alerts');
  const presenceSummary = $('tab-presence-summary');
  const historyToggle = $('toggle-tab-history');
  const summary = $('coordination-summary');
  const seats = $('agent-seats');
  const hierarchy = $('tab-hierarchy');
  const queue = $('queue-items');
  const tools = $('tool-call-log');
  if (!summary || !seats || !hierarchy || !queue || !tools) return;
  if (!snapshot) {
    if(alerts)alerts.textContent='Proxy disconnected; pending task statuses unknown';
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
  queue.textContent='';
  const visibleQueue=snapshot.queue||[];
  if(!visibleQueue.length)queue.textContent=snapshot.storageReady
    ? hiddenPending>0 ? `${hiddenPending} event(s) need manager re-registration before reconciliation`
      : 'No queued events' : 'Queue not active';
  const oldestByRecipient=new Set();
  for(const item of visibleQueue){
    const line=document.createElement('div');
    line.className='coordination-row';
    const label=document.createElement('span');
    label.textContent=`${item.type} · ${item.phase} · tab ${item.managerTabId} · ${item.eventId.slice(0,8)}`;
    line.append(label);
    const recipient=`${item.browserSessionId}:${item.managerTabId}:${item.principalId}`;
    const recoveryKey=`${recipient}:${item.batchId||item.eventId}`;
    const terminal=['PROCESSED','SAGA_CONFIRMED','SKIPPED'].includes(item.phase);
    if(!terminal && !oldestByRecipient.has(recipient)){
      oldestByRecipient.add(recipient);
      if(item.batchId && ['LEASED','DISPATCHING','DELIVERED','UNCERTAIN','RETRYING'].includes(item.phase)){
        const setFeedback=(message,isError=false)=>{
          queueRecoveryFeedback.delete(recoveryKey);
          queueRecoveryFeedback.set(recoveryKey,{message,isError});
          if(queueRecoveryFeedback.size>100)
            queueRecoveryFeedback.delete(queueRecoveryFeedback.keys().next().value);
          notify(message,isError);
          renderCoordinationSnapshot(lastCoordinationSnapshot);
        };
        const performRecovery=async(label,action)=>{
          if(queueRecoveryBusy.has(recoveryKey))return;
          queueRecoveryBusy.add(recoveryKey);
          setFeedback(`${label}…`);
          try {
            await action();
          } catch(error) {
            setFeedback(`Recovery failed: ${error?.message||String(error)}`,true);
          } finally {
            queueRecoveryBusy.delete(recoveryKey);
            renderCoordinationSnapshot(lastCoordinationSnapshot);
          }
        };
        const control=(title,callback)=>{
          const button=document.createElement('button');
          button.type='button';button.className='secondary';button.textContent=title;
          button.disabled=queueRecoveryBusy.has(recoveryKey);
          button.addEventListener('click',callback);
          line.append(button);
        };
        const operate=async(action,reason='')=>{
          const result=await window.bridge.recoverQueueBatch(item.managerTabId,
            item.browserSessionId,item.batchId,action,reason);
          setFeedback(result.draft_cleanup_required
            ? 'Batch skipped and journal retained, but browser draft cleanup needs manual inspection. Open tab and clear ONLY the old notification draft.'
            : result.ledger_synced===false && ['SKIPPED','DELIVERED'].includes(result.phase)
              ? 'Journal updated, but extension ledger did not synchronize. Recheck the manager tab before continuing.'
            : result.verified?'Sent user turn verified; awaiting agent review/ACK.'
            : result.phase==='SKIPPED'?'Batch skipped, original events retained in journal.'
            : result.phase==='DELIVERED'?'Batch submitted; awaiting agent review/ACK.'
            : result.matchingDraft===true
              ? 'Exact unsent batch draft found. Retry exact draft or Skip batch.'
              : 'No submitted user turn or matching draft verified. Queue remains held; inspect tab or Skip.');
        };
        control('Open tab',()=>performRecovery('Opening manager tab',async()=>{
          await window.bridge.focusQueueManager(item.managerTabId,item.browserSessionId);
          setFeedback('Manager tab focused. Check the original notification draft.');
        }));
        control('Recheck',()=>performRecovery('Checking for submitted batch',()=>operate('recheck')));
        if(item.phase!=='DELIVERED')
          control('Retry exact draft',()=>{
            if(!window.confirm('Retry ONLY the matching unsent batch draft? An earlier Send may have succeeded. No new text will be inserted.'))return;
            return performRecovery('Checking exact draft before retry',()=>operate('retry_draft'));
          });
        control('Skip batch',()=>{
          const reason=window.prompt('Reason for skipping this whole FIFO batch (minimum 10 characters):','');
          if(reason==null)return;
          if(reason.trim().length<10){setFeedback('A skip reason must contain at least 10 characters.',true);return;}
          if(!window.confirm('Skip this batch without delivering it? Child reports remain in the journal for later review.'))return;
          return performRecovery('Recording operator skip',()=>operate('skip',reason.trim()));
        });
      }
    }
    const feedback=queueRecoveryFeedback.get(recoveryKey);
    if(feedback){
      const status=document.createElement('span');
      status.className='queue-recovery-feedback';
      status.setAttribute('role','status');
      status.style.color=feedback.isError?'#ff98a8':'#a4a4af';
      status.textContent=feedback.message;
      line.append(status);
    }
    queue.append(line);
  }
  rows(tools, (snapshot.toolCalls || []).slice(-8).reverse(), (item) =>
    `${item.method} · ${item.ok ? 'OK' : 'ERROR'} · ${item.durationMs}ms · ${item.caller}`,
    'No tool calls recorded');
  if(alerts){
    alerts.textContent='';
    const pending=Array.isArray(snapshot.completionAlerts)?snapshot.completionAlerts:[];
    if(!pending.length)alerts.textContent='No task currently needs a manual decision';
    for(const task of pending){
      const line=document.createElement('div');
      line.className='coordination-row';
      const label=document.createElement('span');
      const waiting=task.status==='waiting_for_children';
      const notificationPending=task.notification_pending===true;
      const last=task.last_observation;
      label.textContent=`Child tab ${task.tab_id} · task ${task.task_id} · ${task.status}`+
        ` · evidence: ${task.completion_evidence||'UNKNOWN'}`+
        ` · last UI check: ${last?.state||'NOT_OBSERVED'} (${last?.evidence||'NONE'})`+
        ` · checks: ${task.check_count||0}`+
        (waiting?' · Own work confirmed; waiting for descendant reviews':
          notificationPending
            ? ' · Parent FIFO journal receipt NOT confirmed; same-task reconciliation pending'
            : ' · periodic refresh/reinspection continues');
      line.append(label);
      if(task.pending_descendants){
        const blockers=document.createElement('span');
        blockers.className='queue-recovery-feedback';
        const items=(task.pending_descendant_tasks||[]).map((item)=>
          `tab ${item.tab_id}, task ${item.task_id||'unavailable'}: ${item.status}`);
        blockers.textContent=' Descendant review blocks final completion: '+
          (items.length?items.join('; '):'pending dependency; inspect Child tree');
        line.append(blockers);
      }
      const key=`${task.browser_session_id}:${task.task_id}`;
      if(task.manual_required===true&&!waiting){
        for(const [choice,title] of [['completed','Completed'],['in_progress','In Progress']]){
          const button=document.createElement('button');
          button.type='button';
          button.className='secondary';
          button.textContent=title;
          button.disabled=completionDecisionBusy.has(key);
          button.addEventListener('click',async()=>{
            if(completionDecisionBusy.has(key))return;
            completionDecisionBusy.add(key);
            for(const child of line.children)
              if(child.type==='button')child.disabled=true;
            try{
              const result=await window.bridge.setCompletionStatus(task.task_id,choice,
                task.browser_session_id);
              const accepted=result?.task_id===task.task_id &&
                (choice==='completed'
                  ? ['done','waiting_for_children'].includes(result.status)
                  : ['running','uncertain'].includes(result.status));
              if(!accepted)
                throw new Error('No matching task/status acknowledgement was returned');
              const outcome=result?.pending_descendants
                ? 'Own work confirmed; still waiting for descendant review. No Parent completion event yet.'
                : result?.notification_pending
                  ? 'Own work completed, but Parent FIFO receipt is unconfirmed. Same-task reconciliation is scheduled; do not resubmit the prompt.'
                : choice==='completed'
                  ? 'User-confirmed own-work completion recorded; Parent review is still required.'
                  : 'In Progress recorded; monitoring continues.';
              completionDecisionFeedback.set(key,{message:outcome,error:false});
              notify(outcome);
            }catch(error){
              const message='Manual completion action uncertain: '+(error?.message||String(error))+
                '. Recheck the task before retrying; a previous click may have taken effect.';
              completionDecisionFeedback.set(key,{message,error:true});
              notify(message,true);
            }finally{
              completionDecisionBusy.delete(key);
              renderCoordinationSnapshot(lastCoordinationSnapshot);
            }
          });
          line.append(button);
        }
      }
      const feedback=completionDecisionFeedback.get(key);
      if(feedback){
        const message=document.createElement('span');
        message.className='queue-recovery-feedback';
        message.setAttribute('role','status');
        message.textContent=feedback.message;
        message.style.color=feedback.error?'#ff98a8':'#a4a4af';
        line.append(message);
      }
      alerts.append(line);
    }
  }
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

$('copy-url').addEventListener('click', () => perform(() => window.bridge.copyUrl(), 'Authenticated URL copied with token. Keep it private; select No authentication in ChatGPT.'));
$('domain').addEventListener('input', () => { domainDirty = true; });
$('proxy-port').addEventListener('input', () => { proxyPortDirty = true; });
$('connector-name').addEventListener('input', () => { connectorNameDirty = true; });
$('save-connector-name').addEventListener('click',()=>perform(async()=>{
  const name=$('connector-name').value.trim();
  if(!name)throw new Error('Enter the exact connector name configured in ChatGPT, such as PC1');
  const settings=await window.bridge.getAgentSettings();
  await window.bridge.saveAgentSettings({...settings,connectorName:name});
  connectorNameDirty=false;
  render(await window.bridge.status());
},'Connector name saved. Verify the extension routing status under One-time browser setup before pairing.'));
$('managed-browser').addEventListener('change',()=>{
  browserSelectionDirty=true;
  $('chromium-executable-row').hidden=$('managed-browser').value!=='chromium';
});
$('choose-chromium-executable').addEventListener('click',()=>perform(async()=>{
  const selected=await window.bridge.chooseChromiumExecutable();
  if(selected){$('chromium-executable').value=selected;browserSelectionDirty=true;}
}));
$('save-managed-browser').addEventListener('click',()=>perform(async()=>{
  const selected=await window.bridge.configureManagedBrowser(
    $('managed-browser').value,$('chromium-executable').value);
  browserSelectionDirty=false;
  render(selected);
  notify('Dedicated browser profile configured. Install the extension once and verify its connection.');
}));
$('open-managed-extensions').addEventListener('click',()=>perform(
  ()=>window.bridge.openManagedBrowserExtensions(),
  'Browser extensions page opened in the dedicated profile.'));
$('copy-extension-path').addEventListener('click',()=>perform(
  ()=>window.bridge.copyExtensionPath(),
  'Bundled extension folder copied. Choose Load unpacked in the managed browser.'));
$('copy-profile-token').addEventListener('click',()=>perform(
  ()=>window.bridge.copyProfileToken(),
  'Profile connection key copied. Paste it into this managed browser extension popup only.'));
const verifyManagedBrowser=()=>perform(async()=>{
  if(!window.confirm('Is this extension running inside the dedicated Chromium-based browser profile opened by Chat Orchestrator? This binds that installation for browser-close actions.'))return;
  render(await window.bridge.verifyManagedBrowser());
},'Connected extension installation verified for this selected browser.');
$('verify-managed-browser').addEventListener('click',verifyManagedBrowser);
$('repair-managed-browser').addEventListener('click',verifyManagedBrowser);
$('finish-onboarding').addEventListener('click',()=>perform(async()=>{
  render(await window.bridge.finishOnboarding());
},'First-run setup completed. You can revisit Connections any time.'));
$('check-updates').addEventListener('click',()=>perform(async()=>{
  render(await window.bridge.checkUpdates());
},'Official published releases checked.'));
$('update-now').addEventListener('click',()=>perform(async()=>{
  if(!window.confirm('Approve an update request? It will stay pending until all Agent tasks and Parent reviews finish, then open the official publisher release page. It will NOT install or stop this app automatically.'))return;
  render(await window.bridge.requestUpdate());
},'Update request recorded. Review its status before manually installing anything.'));
$('cancel-update').addEventListener('click',()=>perform(async()=>{
  render(await window.bridge.cancelUpdate());
},'Pending update cancelled.'));
$('auto-start-windows').addEventListener('change',async()=>{
  const enabled=$('auto-start-windows').checked;
  try {
    const next=await window.bridge.setAutoStartWindows(enabled);
    render(next);
    notify(next.autoStartWindows?'Windows startup enabled.':'Windows startup disabled.');
  } catch(error) {
    $('auto-start-windows').checked=currentState?.autoStartWindows===true;
    notify(error.message||String(error),true);
  }
});
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
$('copy-public-mcp-token').addEventListener('click',()=>perform(async()=>{
  await window.bridge.copyPublicMcpToken();
},'MCP transport key copied. Set it in a compatible MCP client Authorization header.'));
$('start').addEventListener('click', () => perform(async () => render(await window.bridge.start()), 'Starting local proxy…'));
$('stop').addEventListener('click', () => perform(async () => render(await window.bridge.stop()), 'Local proxy stopped.'));
$('configure-private-coordination').addEventListener('click', () => perform(async () => {
  const enabled = currentState?.privateCoordinationOptIn !== true;
  render(await window.bridge.configurePrivateCoordination(enabled));
  notify(enabled ? 'Private journal prepared; restart the proxy to activate.' : 'Private queue disabled on next proxy start. Restart to apply.');
}));
$('open-journal-folder').addEventListener('click',()=>perform(async()=>{
  await window.bridge.openJournalFolder();
  journalRecoveryFeedback='Opened the local profile folder. Keep its journal and lock evidence private.';
  render(currentState);
}));
$('recover-empty-journal-lock').addEventListener('click',async()=>{
  if(journalRecoveryBusy)return;
  journalRecoveryBusy=true;
  const snapshot=currentState?.journalRecovery?.snapshot;
  $('recover-empty-journal-lock').disabled=true;
  try {
    const result=await window.bridge.recoverEmptyJournalLock(snapshot);
    if(result?.archived){
      journalRecoveryFeedback='Stale owner lock archived as '+result.archiveName+
        '. Select Start to resume the local Proxy. No events were replayed.';
      notify('Empty journal lock archived. Start the local Proxy when ready.');
    }else journalRecoveryFeedback='Recovery cancelled. No journal files were changed.';
  }catch(error){
    journalRecoveryFeedback='Recovery could not proceed: '+(error?.message||String(error));
    notify(journalRecoveryFeedback,true);
  }finally{
    journalRecoveryBusy=false;
    try {render(await window.bridge.status());}
    catch(error){notify('Recovery finished but status could not be refreshed: '+error.message,true);}
  }
});
$('minimize-to-tray').addEventListener('change', async () => {
  const enabled = $('minimize-to-tray').checked;
  try {
    render(await window.bridge.setMinimizeToTray(enabled));
    notify(enabled ? 'X will minimize to the system tray.'
      : 'X will ask whether to exit, keeping or closing the managed browser.');
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
  $('completion-initial').value=String(settings.completionMonitor?.initialMinutes??5);
  $('completion-retries').value=(settings.completionMonitor?.retryMinutes??[5,3,1]).join(',');
  $('completion-hydration').value=String(settings.completionMonitor?.hydrationSeconds??5);
  $('completion-continued').value=String(settings.completionMonitor?.continuedMinutes??2);
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
    connectorName: currentState?.connectorName ?? agentDraft.connectorName ?? '',
    enabled: $('agent-enabled').checked,
    maxWorkers: Number($('agent-max-workers').value),
    maxTasksPerHour: Number($('agent-max-tasks').value),
    taskTimeoutMin: Number($('agent-timeout').value),
    completionMonitor:{
      initialMinutes:Number($('completion-initial').value),
      retryMinutes:$('completion-retries').value.split(',').map((part)=>Number(part.trim())),
      hydrationSeconds:Number($('completion-hydration').value),
      continuedMinutes:Number($('completion-continued').value),
    },
    promptSchema: agentDraft.promptSchema,
    promptModules: agentDraft.promptModules,
  };
  agentDraft = await window.bridge.saveAgentSettings(candidate);
  $('agent-settings-message').textContent = 'Saved to this profile. Sync sent to connected extension, otherwise sent on next connection.';
}, 'Extension settings saved to this proxy profile.'));

// Decisions survive Proxy restarts in the extension's local operational state.
// Countdowns enable buttons; they never select an outcome or expire a dialog.
const closureFirstShown=new Map();
let closureSnapshot=[];
let closureBusy=false;
let closureRefreshBusy=false;
let closureError='';
function renderAgentClosureDialog() {
  const overlay=$('closure-overlay');
  if(!overlay)return;
  const pending=closureSnapshot.filter((entry)=>entry.status!=='resolved');
  const entry=pending[0];
  if(!entry) {overlay.hidden=true;return;}
  overlay.hidden=false;
  if(!closureFirstShown.has(entry.id))closureFirstShown.set(entry.id,Date.now());
  $('closure-heading').textContent=entry.kind==='parent'
    ? 'An approved Parent Agent tab closed'
    : 'A managed Child Agent tab closed';
  $('closure-identity').textContent=
    `${entry.title || 'Agent'} · old tab ${entry.oldTabId} · ${entry.kind}`+
    (entry.parentTabId?` · still-owning Parent tab ${entry.parentTabId}`:'');
  $('closure-url').textContent=entry.url?
    `Saved conversation: ${entry.url}`:'No verified conversation URL was captured; Accident recovery is held.';
  const descendants=Array.isArray(entry.descendants)?entry.descendants:[];
  const unresolved=descendants.filter((d)=>
    ['running','uncertain','waiting_for_children','waiting_for_parent_context','queued'].includes(d.state));
  $('closure-warning').textContent=unresolved.length
    ? `${unresolved.length} descendant Agent(s) still have active, queued, or Parent-context-dependent work. Existing browser work continues while you decide. An intentional Yes closes this subtree immediately; Cancel leaves tabs open but unmanaged.`
    : 'No active descendant tasks were observed in the captured closure snapshot.';
  $('closure-descendants').textContent=descendants.length
    ? descendants.map((d)=>`Tab ${d.tabId} · parent ${d.parentTabId} · ${d.title||d.site||'Agent'} · ${d.state}`).join('\n')
    : 'No registered descendants in this closure snapshot.';
  $('closure-backlog').textContent=pending.length>1
    ? `${pending.length-1} other closure decision(s) are awaiting your separate choice.`:'';
  const seconds=Math.max(0,5-Math.floor((Date.now()-closureFirstShown.get(entry.id))/1000));
  const resuming=entry.status==='restoring_children' &&
    Number.isSafeInteger(entry.candidateTabId);
  const ready=seconds===0 && !closureBusy &&
    (entry.status==='pending'||resuming) &&
    currentState?.phase==='running' && currentState?.extensionConnected===true;
  $('closure-accident').textContent=resuming?'Resume Accident':'Accident';
  for (const name of ['accident','yes','cancel'])
    $('closure-'+name).disabled=!ready || (name!=='accident'&&resuming) ||
      (name==='accident' && !resuming && !entry.url);
  $('closure-countdown').textContent=resuming
    ? 'Some descendants are still being restored. Resume Accident verifies the existing tabs and never replays their tasks.'
    : entry.status!=='pending'
    ? 'Recovery decision is in progress or uncertain. No automatic retry or duplicate tab creation.'
    : closureBusy?'Applying your choice; original Agent relationships are being verified…'
    : seconds?`Actions enabled in ${seconds} second(s). No action will be selected automatically.`
      : currentState?.extensionConnected?'Choose Accident, Yes, or Cancel. No default action.'
        :'Extension disconnected. Decision is preserved until reconnect.';
  $('closure-error').textContent=closureError;
}
async function refreshAgentClosures() {
  if(closureRefreshBusy || typeof window.bridge.listAgentClosures!=='function' ||
     currentState?.phase!=='running' || !currentState?.extensionConnected)return;
  closureRefreshBusy=true;
  try {
    const data=await window.bridge.listAgentClosures();
    if(Array.isArray(data)) {
      closureSnapshot=data;
      renderAgentClosureDialog();
    }
  } catch(error) {
    // Preserve last-known dialogs: a missing bridge is not authorization to
    // silently dismiss or choose an outcome.
    if(closureSnapshot.length) {
      closureError=String(error?.message||error);
      renderAgentClosureDialog();
    }
  } finally {closureRefreshBusy=false;}
}
async function selectAgentClosure(choice) {
  if(closureBusy || typeof window.bridge.resolveAgentClosure!=='function')return;
  const entry=closureSnapshot.find((item)=>item.status!=='resolved');
  if(!entry || entry.status!=='pending')return;
  if(Date.now()-closureFirstShown.get(entry.id)<5000)return;
  if(currentState?.phase!=='running' || !currentState.extensionConnected)return;
  closureBusy=true;closureError='';
  renderAgentClosureDialog();
  try {
    const result=await window.bridge.resolveAgentClosure(entry.id,choice);
    if(choice==='accident')
      notify(`Restored physical Agent tab ${result.new_tab_id}. Pair the restored Parent/Child before resuming new orchestrated work.`);
    else if(choice==='yes')
      notify('Closed only the selected Agent subtree. Unrelated Agent tabs remain untouched.');
    else
      notify('Descendant tabs remain open but are detached from Chat Orchestrator; future MCP calls are forbidden.');
    closureSnapshot=closureSnapshot.filter((item)=>item.id!==entry.id);
    closureFirstShown.delete(entry.id);
  } catch(error) {
    closureError=String(error?.message||error);
  } finally {
    closureBusy=false;
    renderAgentClosureDialog();
    void refreshAgentClosures();
  }
}
for (const name of ['accident','yes','cancel'])
  $('closure-'+name)?.addEventListener('click',()=>void selectAgentClosure(name));
if(typeof window.setInterval==='function') {
  window.setInterval(()=>{renderAgentClosureDialog();void refreshAgentClosures();},1000);
}