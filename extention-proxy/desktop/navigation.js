// View-only navigation. Existing trusted IPC handlers remain in renderer.js.
(() => {
  const titles = Object.freeze({
    overview: 'Overview',
    connections: 'Connections',
    agents: 'Agents & queue',
    settings: 'Preferences',
  });
  const byId = (id) => document.getElementById(id);
  const navItems = [...document.querySelectorAll('[data-view]')];

  function showView(name) {
    if (!Object.hasOwn(titles, name)) return;
    for (const [view, title] of Object.entries(titles)) {
      const section = byId('view-' + view);
      section.hidden = view !== name;
      if (view === name) byId('page-title').textContent = title;
    }
    for (const button of navItems) {
      const active = button.dataset.view === name;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    document.querySelector('.app-shell').scrollTop = 0;
  }

  for (const button of navItems) {
    button.addEventListener('click', () => showView(button.dataset.view));
  }
  for (const button of document.querySelectorAll('[data-open-view]')) {
    button.addEventListener('click', () => showView(button.dataset.openView));
  }
  byId('quick-copy-url').addEventListener('click', () => byId('copy-url').click());

  function setStep(id, label, color) {
    const target = byId(id);
    target.textContent = label;
    target.className = 'step-state' + (color ? ' ' + color : '');
  }
  function update(state) {
    if (!state) return;
    byId('sidebar-profile').textContent = state.profile || 'default';
    const running = state.phase === 'running';
    const ext = running && state.extensionConnected;
    const synced = ext && Number(state.agentSettingsSyncRevision) > 0;
    const online = Boolean(state.routeVerified);
    setStep('quick-extension-status', synced ? 'Ready' : ext ? 'Syncing' : 'Not connected',
      synced ? 'good' : ext ? 'warn' : '');
    setStep('quick-connector-status', online ? 'Online' : 'Not connected', online ? 'good' : '');
    byId('quick-copy-url').disabled = !state.domain;
    let headline, guidance;
    if (!running) {
      headline = 'Start the local proxy';
      guidance = 'Use Start proxy below. Your saved profile and Ngrok tunnel settings will be reused.';
    } else if (!ext) {
      headline = 'Connect the browser extension';
      guidance = 'Open Connections, then enter the displayed local WebSocket URL in the extension popup.';
    } else if (!synced) {
      headline = 'Extension connected; waiting for settings sync';
      guidance = 'Check the local WebSocket URL in the extension popup and select Save connection & reconnect.';
    } else if (!online) {
      headline = 'Your extension is ready. Connect the tunnel';
      guidance = 'Add your dedicated ngrok domain and authtoken under Connections, then select Save & connect.';
      headline = 'All connections are ready';
      guidance = 'The extension is synchronized and the MCP route is online. You can delegate tasks from ChatGPT.';
    }
    byId('setup-headline').textContent = headline;
    byId('setup-guidance').textContent = guidance;
  }
  window.bridge.onState(update);
  window.bridge.status().then(update).catch(() => {});
})();
