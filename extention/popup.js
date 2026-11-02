const $ = (id) => document.getElementById(id);
const FIELDS = ['serverUrl', 'token', 'maxWorkers', 'maxTasksPerHour', 'taskTimeoutMin', 'workerSystemPrompt'];

function show(text) {
  $('out').hidden = false;
  $('out').textContent = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
}

async function refresh(fillFields) {
  const s = await chrome.runtime.sendMessage({ type: 'popup_status' });
  const connected = s.wsState === 'connected';
  $('status').textContent = `Server: ${s.wsState}`;
  $('status').className = `status ${connected ? 'ok' : 'bad'}`;
  $('info').textContent =
    `Orchestrator tab: ${s.cfg.orchestratorTabId ?? 'not set'} · Workers open: ${s.workers.length} · Running tasks: ${s.running}`;
  $('enabled').checked = s.cfg.enabled;
  $('autoClose').checked = s.cfg.autoCloseWorkers;
  $('useSysPrompt').checked = s.cfg.useWorkerSystemPrompt;
  if (fillFields) FIELDS.forEach((f) => ($(f).value = s.cfg[f]));
}

async function activeChatTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

$('enabled').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ enabled: e.target.checked });
  refresh(false);
});

$('autoClose').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ autoCloseWorkers: e.target.checked });
});

$('useSysPrompt').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ useWorkerSystemPrompt: e.target.checked });
});

$('resetPrompt').addEventListener('click', async () => {
  await chrome.storage.local.remove('workerSystemPrompt');
  refresh(true);
});

$('save').addEventListener('click', async () => {
  const values = {
    serverUrl: $('serverUrl').value.trim(),
    token: $('token').value.trim(),
    maxWorkers: Number($('maxWorkers').value) || 4,
    maxTasksPerHour: Number($('maxTasksPerHour').value) || 30,
    taskTimeoutMin: Number($('taskTimeoutMin').value) || 10,
    workerSystemPrompt: $('workerSystemPrompt').value,
  };
  await chrome.storage.local.set(values);
  await chrome.runtime.sendMessage({ type: 'reconnect' });
  setTimeout(() => refresh(false), 800);
});

$('setOrch').addEventListener('click', async () => {
  const tab = await activeChatTab();
  await chrome.runtime.sendMessage({ type: 'set_orchestrator', tabId: tab.id });
  refresh(false);
});

$('diagnose').addEventListener('click', async () => {
  const tab = await activeChatTab();
  try {
    show(await chrome.tabs.sendMessage(tab.id, { cmd: 'diagnose' }));
  } catch {
    show('Content script not reachable in this tab. Open a claude.ai / chatgpt.com tab and reload it.');
  }
});

$('closeAll').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'close_all_workers' });
  refresh(false);
});

refresh(true);
