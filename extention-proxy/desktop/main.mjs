import { app, BrowserWindow, Menu, Tray, clipboard, ipcMain, nativeImage, safeStorage, shell, utilityProcess } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectorUrl, ISOLATED_NGROK_CONFIG, normalizeNgrokAuthtoken, normalizeNgrokDomain, normalizeProxyPort, normalizeProfileName, PRIVATE_QUEUE_PREFERENCE_SCHEMA, resolvePrivateQueuePreference } from './config.mjs';
import { createNgrokLogReader } from './ngrok-diagnostics.mjs';
import { findReusableNgrokTunnel, describeNgrokExit } from './ngrok-reuse.mjs';
import { inspectPrivateJournal, preparePrivateJournal } from './coordination-storage.mjs';
import { createDesktopTray, installWindowCloseBehavior, minimizeToTrayPreference } from './tray-lifecycle.mjs';
import { DEFAULT_AGENT_SETTINGS, normalizeAgentSettings, replaceObsoletePromptSettings, disabledAgentSettings, composeAgentPrompt } from '../agent-settings.mjs';
import { createDiagnostics } from '../diagnostics.mjs';

// Set CHAT_ORCH_DIAGNOSTICS=1 for lifecycle messages (never credentials).
const debug = (message) => {
  if (process.env.CHAT_ORCH_DIAGNOSTICS === '1') console.error(`[desktop] ${message}`);
};

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A two-key, test-only packaged smoke mode preserves the production port/profile.
// It is never enabled in ordinary packaged app launches.
const PACKAGED_SMOKE_MODE = app.isPackaged && process.env.CHAT_ORCH_PACKAGED_SMOKE === '1';
const E2E_MODE = process.env.CHAT_ORCH_E2E_MODE === '1' &&
  (!app.isPackaged || PACKAGED_SMOKE_MODE);
let PORT = E2E_MODE ? Number(process.env.CHAT_ORCH_E2E_PORT || 8897) : 8787;
const PACKAGED_SMOKE_EXIT_MS = PACKAGED_SMOKE_MODE
  ? Number(process.env.CHAT_ORCH_PACKAGED_SMOKE_EXIT_MS || 45000) : 0;
if (E2E_MODE && (!Number.isSafeInteger(PORT) || PORT < 1024 || PORT > 65535 || PORT === 8787)) {
  throw new Error('Isolated E2E must use a non-production loopback port');
}
if (PACKAGED_SMOKE_MODE && (!Number.isSafeInteger(PACKAGED_SMOKE_EXIT_MS) ||
    PACKAGED_SMOKE_EXIT_MS < 15000 || PACKAGED_SMOKE_EXIT_MS > 120000)) {
  throw new Error('Packaged smoke requires a bounded automatic exit timer');
}
let window;
let tray;
let minimizeToTray = true;
let exitStarted = false;
let exitReady = false;
let child;
let stopProxyPromise = null; // Serialize overlapping tray Exit / Stop requests.
const desktopExtensionActions = new Map(); // local admin requests only
let ngrokChild;
let ngrokReused = null; // external locally verified tunnel; never owned or terminated
let ngrokGeneration = 0;
let domain = '';
let phase = 'stopped';
let ngrokPhase = 'stopped';
let errorMessage = '';
let ngrokError = '';
let routeVerified = false;
let extensionConnected = false;
let coordinationState = 'unknown';
let privateCoordinationOptIn = true;
let runningPrivateCoordination = null;
let coordinationSnapshot = null; // Owned utilityProcess emits redacted, read-only state.
let stopping = false;
let agentSettings = normalizeAgentSettings({});
let agentSettingsSyncRevision = 0;

// Optional loopback CDP is test-only; packaged releases never expose DevTools.
if (E2E_MODE && !app.isPackaged && process.env.CHAT_ORCH_E2E_CDP_PORT) {
  const cdpPort = Number(process.env.CHAT_ORCH_E2E_CDP_PORT);
  if (!Number.isSafeInteger(cdpPort) || cdpPort < 1024 || cdpPort > 65535) {
    throw new Error('Invalid isolated E2E DevTools port');
  }
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', String(cdpPort));
}
// Explicit profile isolation happens before the single-instance lock.
// The default profile retains its historical userData directory and port.
const profileArgs = process.argv.filter((arg) => arg === '--profile' || arg.startsWith('--profile='));
if (profileArgs.length > 1 || profileArgs[0] === '--profile') {
  throw new Error('Use one --profile=name argument');
}
const PROFILE = normalizeProfileName(profileArgs[0]?.slice('--profile='.length) ?? 'default');
if (E2E_MODE && PROFILE !== 'default') throw new Error('Isolated E2E cannot override its profile');
if (!E2E_MODE && PROFILE !== 'default') {
  const profileDir = path.join(app.getPath('appData'), 'Chat Orchestrator Profiles', PROFILE);
  fs.mkdirSync(profileDir, { recursive: true });
  app.setPath('userData', profileDir);
}
// Explicit E2E profile prevents single-instance takeover or mutation of live user settings.
if (E2E_MODE) {
  const isolatedDir = process.env.CHAT_ORCH_E2E_DATA_DIR;
  if (!isolatedDir || !path.isAbsolute(isolatedDir)) {
    throw new Error('E2E mode requires an absolute isolated data directory');
  }
  if (PACKAGED_SMOKE_MODE &&
      !path.basename(isolatedDir).toLowerCase().startsWith('chat-orchestrator-smoke-')) {
    throw new Error('Packaged smoke profile requires an explicit disposable directory name');
  }
  fs.mkdirSync(isolatedDir, { recursive: true });
  app.setPath('userData', isolatedDir);
}
app.setName(E2E_MODE ? 'Chat Orchestrator E2E' : 'Chat Orchestrator');
if (process.platform === 'win32') app.setAppUserModelId(E2E_MODE
  ? 'com.empirerider.chat-orchestrator.e2e' : 'com.empirerider.chat-orchestrator');
const hasInstanceLock = app.requestSingleInstanceLock();
debug(`single-instance lock=${hasInstanceLock}`);
if (!hasInstanceLock) app.quit();

const dataDir = () => app.getPath('userData');
const diagnostics = createDiagnostics({component:'desktop',directory:dataDir()});
const settingsFile = () => path.join(dataDir(), 'settings.json');
const ngrokAuthFile = () => path.join(dataDir(), 'ngrok-auth.bin');
const ngrokConfigFile = () => path.join(dataDir(), 'ngrok-isolated.yml');
const privateCoordinationJournalPath = () => path.join(dataDir(), 'coordination.events.journal');

// Provision from trusted desktop startup or IPC. A future start may use the journal,
// but no record is ACKed merely because this file was created. On Windows,
// power-loss directory-entry durability is not claimed; recovery stays fail-closed.
function preparePrivateCoordinationJournal() {
  return preparePrivateJournal(privateCoordinationJournalPath());
}
function privateJournalInspection() {
  try { return inspectPrivateJournal(privateCoordinationJournalPath()); }
  catch { return {present:false,bytes:0,lockPresent:false,ownerVerified:false,
    requiresManualOwnerCheck:true,error:'Journal/lock needs manual inspection'}; }
}

function ensureIsolatedNgrokConfig() {
  fs.mkdirSync(dataDir(), { recursive: true });
  // Only non-secret config structure is stored; never the decrypted token.
  fs.writeFileSync(ngrokConfigFile(), ISOLATED_NGROK_CONFIG, { mode: 0o600 });
  return ngrokConfigFile();
}

function state() {
  return {
    phase,
    ngrokPhase,
    ngrokReused: Boolean(ngrokReused),
    ngrokError,
    ngrokAuthConfigured: fs.existsSync(ngrokAuthFile()),
    error: errorMessage,
    extensionConnected,
    coordinationState,
    privateCoordinationOptIn,
    privateCoordinationJournalPresent: fs.existsSync(privateCoordinationJournalPath()),
    privateJournalInspection: privateJournalInspection(),
    privateCoordinationRestartRequired: Boolean(child && runningPrivateCoordination !== privateCoordinationOptIn),
    coordinationSnapshot,
    agentSettingsSyncRevision,
    domain,
    profile: PROFILE,
    port: PORT,
    routeVerified,
    minimizeToTray,
    trayAvailable: Boolean(tray && !tray.isDestroyed()),
    localWebSocketUrl: `ws://127.0.0.1:${PORT}/bridge`,
    publicPath: '/mcp',
  };
}

function publishState() {
  if (window && !window.isDestroyed()) window.webContents.send('bridge:state', state());
}

function loadSettings() {
  if (!fs.existsSync(settingsFile())) {
    agentSettings = normalizeAgentSettings({});
    return;
  }
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    domain = saved.domain ? normalizeNgrokDomain(saved.domain) : '';
    minimizeToTray = minimizeToTrayPreference(saved.minimizeToTray);
    privateCoordinationOptIn = resolvePrivateQueuePreference(saved);
    agentSettings = replaceObsoletePromptSettings(saved.agentSettings || {});
    if (!E2E_MODE) PORT = normalizeProxyPort(saved.proxyPort ?? 8787);
    if (saved.privateQueuePreferenceSchema !== PRIVATE_QUEUE_PREFERENCE_SCHEMA ||
        saved.agentSettings?.systemPrompts !== undefined || saved.agentSettings?.useWorkerSystemPrompt !== undefined) writeSettings();
  } catch {
    domain = '';
    minimizeToTray = true;
    privateCoordinationOptIn = false;
    agentSettings = disabledAgentSettings();
    if (!E2E_MODE) PORT = 8787;
  }
}

function writeSettings() {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify({ domain, minimizeToTray, privateCoordinationOptIn, privateQueuePreferenceSchema: PRIVATE_QUEUE_PREFERENCE_SCHEMA, proxyPort: PORT, agentSettings }, null, 2), { encoding: 'utf8', mode: 0o600 });
}

async function saveNgrokAuth(value) {
  const auth = normalizeNgrokAuthtoken(value);
  if (!await safeStorage.isAsyncEncryptionAvailable()) {
    throw new Error('Secure credential storage is unavailable. Ngrok token was not saved.');
  }
  const encrypted = await safeStorage.encryptStringAsync(auth);
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(ngrokAuthFile(), encrypted, { mode: 0o600 });
}

async function loadNgrokAuth() {
  if (!fs.existsSync(ngrokAuthFile())) return '';
  if (!await safeStorage.isAsyncEncryptionAvailable()) {
    throw new Error('Secure credential storage is unavailable. Reconnect when it is available.');
  }
  try {
    const encrypted = fs.readFileSync(ngrokAuthFile());
    const { result } = await safeStorage.decryptStringAsync(encrypted);
    return normalizeNgrokAuthtoken(result);
  } catch {
    throw new Error('Saved ngrok credentials cannot be unlocked. Re-enter the ngrok authtoken.');
  }
}

async function startNgrok() {
  if (ngrokChild || ngrokReused || ngrokPhase === 'starting') return;
  if (!domain) {
    ngrokPhase = 'stopped';
    routeVerified = false;
    publishState();
    return;
  }
  ngrokPhase = 'starting';
  ngrokError = '';
  routeVerified = false;
  const generation = ++ngrokGeneration;
  debug(`ngrok start requested (generation=${generation}, domain=${domain}, port=${PORT})`);
  publishState();
  try {
    // An app crash may leave its ngrok subprocess running. The new app must
    // not start a competing tunnel for the same dedicated domain. Match BOTH
    // exact public origin and loopback target port via the local ngrok API.
    const existing = await findReusableNgrokTunnel(domain,PORT);
    if (generation !== ngrokGeneration) return;
    if (existing) {
      ngrokReused=existing;
      debug('ngrok: using matching existing local tunnel; ownership remains external');
      diagnostics.info('ngrok.reused',{port:PORT,reused:true});
      publishState();
      void pollNgrok();
      return;
    }
    if (!fs.existsSync(ngrokAuthFile())) {
      ngrokPhase='stopped';
      ngrokError='Save your ngrok authtoken to start a new tunnel.';
      publishState();
      return;
    }
    const auth = await loadNgrokAuth();
    if (generation !== ngrokGeneration) return;
    const configPath = ensureIsolatedNgrokConfig();
    debug('ngrok using app-isolated config and encrypted app credential (token value hidden)');
    // The isolated config contains no authtoken. NGROK_AUTHTOKEN in the child
    // environment is the sole credential source; AgentBridge is untouched.
    const owned = spawn('ngrok', ['http', String(PORT), '--url', domain, '--config', configPath, '--log', 'stdout', '--log-format', 'json'], {
      cwd: app.isPackaged ? process.resourcesPath : appDir,
      env: { ...process.env, NGROK_AUTHTOKEN: auth },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    ngrokChild = owned;
    let ngrokErrorCode = '';
    const onRecord = ({ code, diagnostic }) => {
      if (code) ngrokErrorCode = code;
      debug(`ngrok: ${diagnostic}`);
    };
    // Parse selected ngrok JSON fields; never print its raw output or auth data.
    const stdout = createNgrokLogReader(onRecord, [auth]);
    const stderr = createNgrokLogReader(onRecord, [auth]);
    owned.stdout?.on('data', (chunk) => stdout.write(chunk));
    owned.stderr?.on('data', (chunk) => stderr.write(chunk));
    owned.on('error', (error) => {
      if (ngrokChild !== owned || generation !== ngrokGeneration) return;
      ngrokPhase = 'error';
      diagnostics.error('ngrok.start_failed',{errorClass:'process_launch'});
      ngrokError = error.code === 'ENOENT'
        ? 'ngrok is not installed or not on PATH. Install ngrok CLI and reopen the app.'
        : 'The ngrok agent could not start.';
      routeVerified = false;
      debug(`ngrok process launch failed (code=${error.code || 'unknown'})`);
      publishState();
    });
    owned.on('close', (code, signal) => {
      stdout.flush();
      stderr.flush();
      debug(`ngrok exited (code=${Number.isInteger(code) ? code : 'none'}, signal=${signal || 'none'}, error=${ngrokErrorCode || 'none'})`);
      diagnostics.warn('ngrok.exited',{exitCode:Number.isInteger(code)?code:undefined,
        reason:ngrokErrorCode || 'process_closed'});
      if (ngrokChild !== owned || generation !== ngrokGeneration) return;
      ngrokChild = null;
      routeVerified = false;
      if (ngrokPhase === 'stopping') {
        ngrokPhase='stopped';
        publishState();
        return;
      }
      // Resolve a race where the previous agent becomes discoverable just
      // after our attempted launch reports ERR_NGROK_334.
      void (async () => {
        if (ngrokErrorCode === 'ERR_NGROK_334') {
          const matching = await findReusableNgrokTunnel(domain,PORT);
          if (generation !== ngrokGeneration || ngrokChild || ngrokReused) return;
          if (matching) {
            ngrokReused=matching;
            ngrokPhase='starting';
            ngrokError='';
            diagnostics.info('ngrok.reused_after_conflict',{port:PORT,reused:true});
            publishState();
            void pollNgrok();
            return;
          }
        }
        if (generation !== ngrokGeneration || ngrokChild || ngrokReused) return;
        ngrokPhase='error';
        ngrokError=describeNgrokExit(ngrokErrorCode);
        publishState();
      })().catch(() => {
        if (generation !== ngrokGeneration) return;
        ngrokPhase='error';
        ngrokError=describeNgrokExit(ngrokErrorCode);
        publishState();
      });
    });
  } catch (error) {
    if (generation !== ngrokGeneration) return;
    ngrokPhase = 'error';
    ngrokError = error.message;
    routeVerified = false;
    publishState();
  }
}

async function stopNgrok() {
  debug('ngrok stop requested');
  ++ngrokGeneration;
  const owned = ngrokChild;
  ngrokChild = null;
  // A reused tunnel belongs to another process. The app may detach, but may
  // never terminate that process, stop its endpoint, or rewrite its config.
  ngrokReused = null;
  ngrokPhase = 'stopping';
  routeVerified = false;
  publishState();
  if (owned) {
    await new Promise((resolve) => {
      if (owned.exitCode !== null) return resolve();
      const timer = setTimeout(resolve, 3500);
      owned.once('close', () => { clearTimeout(timer); resolve(); });
      owned.kill();
    });
  }
  ngrokPhase = 'stopped';
  ngrokError = '';
  publishState();
}

async function pollNgrok() {
  if ((!ngrokChild && !ngrokReused) || !domain || ngrokPhase === 'stopping') return;
  const owned = ngrokChild;
  const reused = ngrokReused;
  const checkedDomain = domain;
  let verified = false;
  try {
    if (reused) {
      const stillPresent = await findReusableNgrokTunnel(checkedDomain,PORT,{
        ports:[reused.apiPort],
      });
      if (!stillPresent) throw new Error('Existing ngrok tunnel is no longer present');
    }
    const response = await fetch(`${checkedDomain}/health`, {
      headers: { 'ngrok-skip-browser-warning': '1' },
      signal: AbortSignal.timeout(3500),
    });
    if (!response.ok || !(await response.json()).ok) throw new Error('Tunnel is not ready');
    verified = true;
  } catch {}
  if (ngrokChild !== owned || ngrokReused !== reused ||
      domain !== checkedDomain || ngrokPhase === 'stopping') return;
  if (verified) {
    if (!routeVerified) debug('ngrok public health endpoint verified');
    routeVerified = true;
    ngrokPhase = 'running';
    ngrokError = '';
  } else {
    if (routeVerified) debug('ngrok public health endpoint is no longer reachable');
    routeVerified = false;
    if (ngrokPhase === 'running') ngrokPhase = 'starting';
  }
  publishState();
}

function startProxy() {
  if (child || phase === 'starting') return;
  phase = 'starting';
  errorMessage = '';
  extensionConnected = false;
  agentSettingsSyncRevision = 0;
  publishState();

  try {
    if (privateCoordinationOptIn) preparePrivateCoordinationJournal();
    debug(`starting local MCP proxy at 127.0.0.1:${PORT}`);
    diagnostics.info('proxy.start_requested',{port:PORT});
    const processForThisStart = utilityProcess.fork(path.join(appDir, 'server.js'), [], {
      serviceName: 'Chat Orchestrator MCP',
      cwd: app.isPackaged ? process.resourcesPath : appDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        CHAT_ORCH_PROFILE_DIR: dataDir(),
        CHAT_ORCH_PRIVATE_COORDINATION: privateCoordinationOptIn ? '1' : '0',
      },
    });
    child = processForThisStart;
    runningPrivateCoordination = privateCoordinationOptIn;
    // Keep child output out of UI and routine logs: it may contain diagnostic data.
    processForThisStart.stdout?.resume();
    processForThisStart.stderr?.resume();
    processForThisStart.on('message', (message) => {
      if (child !== processForThisStart) return;
      if (message?.type === 'ready') {
        debug('local MCP proxy ready');
        diagnostics.info('proxy.ready',{port:PORT,success:true});
        phase = 'running';
        errorMessage = '';
      } else if (message?.type === 'desktop_extension_action_result') {
        const pending = desktopExtensionActions.get(message.request_id);
        if (pending) {
          clearTimeout(pending.timer);
          desktopExtensionActions.delete(message.request_id);
          if (message.ok) pending.resolve(message.result);
          else pending.reject(new Error(message.error || 'Desktop extension action failed'));
        }
      } else if (message?.type === 'agent_settings_synced') {
        agentSettingsSyncRevision = Number(message.revision) || 0;
      } else if (message?.type === 'agent_settings_reloaded') {
        agentSettingsSyncRevision = Number(message.revision) || 0;
      } else if (message?.type === 'coordination_snapshot') {
        if (message.snapshot && typeof message.snapshot === 'object') {
          coordinationSnapshot = message.snapshot;
        }
      } else if (message?.type === 'error') {
        debug('local MCP proxy reported an error');
        diagnostics.error('proxy.start_failed',{reason:'startup_error'});
        phase = 'error';
        errorMessage = String(message.message || 'Proxy startup failed');
        // A failed listener cannot be reused; release only the process we own.
        processForThisStart.kill();
      } else if (message?.type === 'stopped') {
        diagnostics.info('proxy.stop_acknowledged',{acknowledged:true});
        // The utility process keeps its parentPort open after closing HTTP.
        processForThisStart.kill();
      }
      publishState();
    });
    processForThisStart.on('exit', (code) => {
      debug(`local MCP proxy exited (code=${code})`);
      diagnostics.info('proxy.exited',{exitCode:Number.isInteger(code)?code:undefined});
      if (child !== processForThisStart) return;
      child = null;
      for (const [id, pending] of desktopExtensionActions) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Proxy stopped during extension action'));
        desktopExtensionActions.delete(id);
      }
      runningPrivateCoordination = null;
      extensionConnected = false;
      coordinationSnapshot = null;
      if (stopping) {
        phase = 'stopped';
      } else if (phase !== 'error') {
        phase = 'error';
        errorMessage = `Proxy exited unexpectedly (code ${code}). Check whether port ${PORT} is occupied.`;
      }
      publishState();
    });
    processForThisStart.on('error', () => {
      if (child !== processForThisStart) return;
      phase = 'error';
      errorMessage = 'The backend process could not start.';
      processForThisStart.kill();
      publishState();
    });
  } catch (error) {
    child = null;
    phase = 'error';
    errorMessage = error.message;
    debug(`proxy launch failed: ${error.message}`);
    publishState();
  }
}

function stopProxy() {
  if (stopProxyPromise) return stopProxyPromise;
  diagnostics.info('proxy.stop_requested',{port:PORT});
  stopProxyPromise = stopProxyOnce().finally(() => { stopProxyPromise = null; });
  return stopProxyPromise;
}

async function stopProxyOnce() {
  if (!child) {
    phase = 'stopped';
    publishState();
    return;
  }
  const ownedChild = child;
  stopping = true;
  phase = 'stopping';
  publishState();
  const result = await new Promise((resolve) => {
    let finished = false;
    let acknowledged = false;
    const complete = (forced) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ownedChild.off('exit', onExit);
      ownedChild.off('message', onMessage);
      resolve({ forced, acknowledged });
    };
    const onMessage = (message) => {
      if (message?.type === 'stopped') acknowledged = true;
    };
    const onExit = () => complete(false);
    const timer = setTimeout(() => {
      debug('Proxy did not finish graceful shutdown within 15 seconds; owner lock may need inspection');
      ownedChild.kill();
      complete(true);
    }, 15000);
    ownedChild.on('message', onMessage);
    ownedChild.once('exit', onExit);
    try { ownedChild.postMessage({ type: 'stop' }); }
    catch (error) {
      debug('Proxy stop message delivery failed: ' + error.message);
      ownedChild.kill();
      complete(true);
    }
  });
  if (child === ownedChild) child = null;
  stopping = false;
  extensionConnected = false;
  phase = !result.forced && result.acknowledged ? 'stopped' : 'error';
  if (phase === 'error') {
    errorMessage = 'Proxy did not confirm journal lock release. Verify journal ownership before restart.';
    debug('Proxy exit lacked verified graceful completion; no stale lock was removed');
  }
  publishState();
}

async function pollHealth() {
  if (phase !== 'running') return;
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error('Health request failed');
    const health = await response.json();
    extensionConnected = Boolean(health.extensionConnected);
    coordinationState = health.coordination?.enabled === true ? 'active'
      : health.coordination?.storageReady === true ? 'private_ready'
      : health.coordination?.enabled === false ? 'disabled' : 'unknown';
  } catch {
    extensionConnected = false;
    coordinationState = 'unknown';
  }
  publishState();
}

function requireTrustedWindow(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Unauthorized desktop request');
  }
}

function desktopExtensionAction(action, tabId, nonce) {
  if (!child || phase !== 'running') return Promise.reject(new Error('Start proxy and connect extension first'));
  if (!['set_orchestrator','diagnose','close_legacy_workers','inspect_root_repair','confirm_root_repair'].includes(action)) {
    return Promise.reject(new Error('Unsupported desktop action'));
  }
  if (action !== 'close_legacy_workers' && (!Number.isSafeInteger(tabId) || tabId <= 0)) {
    return Promise.reject(new Error('Enter an actual positive tab ID'));
  }
  if (action === 'confirm_root_repair' && (typeof nonce !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(nonce))) {
    return Promise.reject(new Error('Root recovery requires its one-use confirmation nonce'));
  }
  const owned = child;
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {desktopExtensionActions.delete(id);
      reject(new Error('Extension action timed out; outcome unknown'));}, 15000);
    desktopExtensionActions.set(id, {resolve,reject,timer});
    try {owned.postMessage({type:'desktop_extension_action', request_id:id, action, tab_id:tabId, confirmation_nonce:nonce});}
    catch (error) {clearTimeout(timer); desktopExtensionActions.delete(id); reject(error);}
  });
}

function registerActions() {
  ipcMain.handle('bridge:extensionAction', (event, action, tabId, nonce) => {
    requireTrustedWindow(event);
    return desktopExtensionAction(action, tabId, nonce);
  });
  ipcMain.handle('bridge:previewPrompt', (event, input) => {
    requireTrustedWindow(event);
    return composeAgentPrompt(agentSettings, input);
  });
  ipcMain.handle('bridge:getAgentSettings', (event) => {
    requireTrustedWindow(event);
    return structuredClone(agentSettings);
  });
  ipcMain.handle('bridge:getDefaultAgentSettings', (event) => {
    requireTrustedWindow(event);
    return structuredClone(DEFAULT_AGENT_SETTINGS);
  });
  ipcMain.handle('bridge:saveAgentSettings', (event, next) => {
    requireTrustedWindow(event);
    agentSettings = normalizeAgentSettings(next);
    writeSettings();
    agentSettingsSyncRevision = 0;
    if (child && phase === 'running') child.postMessage({ type: 'reload_agent_settings' });
    publishState();
    return structuredClone(agentSettings);
  });
  ipcMain.handle('bridge:status', (event) => { requireTrustedWindow(event); return state(); });
  ipcMain.handle('bridge:setMinimizeToTray', (event, enabled) => {
    requireTrustedWindow(event);
    if (typeof enabled !== 'boolean') throw new Error('Invalid tray preference');
    minimizeToTray = enabled;
    writeSettings();
    publishState();
    return state();
  });
  ipcMain.handle('bridge:copyUrl', (event) => {
    requireTrustedWindow(event);
    if (!domain) throw new Error('Save your ngrok domain first');
    clipboard.writeText(connectorUrl(domain));
  });
  ipcMain.handle('bridge:configureNgrok', async (event, value, authValue) => {
    requireTrustedWindow(event);
    const nextDomain = normalizeNgrokDomain(value);
    const nextAuth = typeof authValue === 'string' ? authValue.trim() : '';
    if (nextAuth) await saveNgrokAuth(nextAuth);
    if (!fs.existsSync(ngrokAuthFile())) throw new Error('Enter your ngrok authtoken to connect.');
    await stopNgrok();
    domain = nextDomain;
    writeSettings();
    await startNgrok();
    publishState();
    return state();
  });
  ipcMain.handle('bridge:configurePort', (event, value) => {
    requireTrustedWindow(event);
    if (E2E_MODE) throw new Error('Isolated test port is fixed by its test profile');
    const next = normalizeProxyPort(value);
    if (next === PORT) return state();
    if (child || ngrokChild || ngrokReused || phase === 'starting' || phase === 'stopping' ||
        ngrokPhase === 'starting' || ngrokPhase === 'stopping') {
      throw new Error('Stop the local proxy and Ngrok before changing this profile port');
    }
    PORT = next;
    writeSettings();
    publishState();
    return state();
  });
  ipcMain.handle('bridge:start', (event) => {
    requireTrustedWindow(event);
    startProxy();
    void startNgrok();
    return state();
  });
  ipcMain.handle('bridge:stop', async (event) => {
    requireTrustedWindow(event);
    await Promise.all([stopProxy(), stopNgrok()]);
    return state();
  });
  ipcMain.handle('bridge:configurePrivateCoordination', (event, enabled) => {
    requireTrustedWindow(event);
    if (typeof enabled !== 'boolean') throw new Error('Invalid private coordination setting');
    if (enabled) preparePrivateCoordinationJournal();
    privateCoordinationOptIn = enabled;
    writeSettings();
    publishState();
    return state();
  });
}

function createWindow() {
  debug('creating window');
  window = new BrowserWindow({
    title: 'Chat Orchestrator',
    width: 1080,
    height: 790,
    minWidth: 820,
    minHeight: 620,
    icon: path.join(appDir, 'desktop', 'assets', 'app.ico'),
    backgroundColor: '#0c111a',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(appDir, 'desktop', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'https://icons8.com/') void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.loadFile(path.join(appDir, 'desktop', 'index.html'));
  window.webContents.on('render-process-gone', (_event, details) => debug(`renderer gone: ${details.reason}`));
  installWindowCloseBehavior(window, {
    shouldMinimize: () => minimizeToTray,
    trayAvailable: () => Boolean(tray && !tray.isDestroyed()),
    isExiting: () => exitStarted || exitReady,
  });
  window.on('closed', () => debug('window closed'));
  window.once('ready-to-show', () => window.show());
}

function restoreWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createTray() {
  // Tray is created before the browser window so X never hides without a restore path.
  try {
    const image = nativeImage.createFromPath(path.join(appDir, 'desktop', 'assets', 'app.ico'));
    if (image.isEmpty()) throw new Error('Application icon is missing');
    tray = createDesktopTray({
      Tray, Menu, icon: image,
      restore: restoreWindow,
      exit: () => app.quit(),
    });
  } catch (error) {
    // Without a usable tray, X closes the app rather than leaving it invisible.
    debug(`tray unavailable: ${error.message}`);
    tray = null;
  }
}

async function shutdownOwnedServices() {
  if (exitStarted) return;
  exitStarted = true;
  try {
    await Promise.allSettled([stopNgrok(), stopProxy()]);
  } finally {
    tray?.destroy();
    tray = null;
    exitReady = true;
    app.quit();
  }
}

if (E2E_MODE) {
  // Main-process only; not packaged and never bridged into the renderer.
  globalThis.__chatOrchE2E = Object.freeze({
    getWindow: () => window,
    getTray: () => tray,
    state,
  });
}

if (hasInstanceLock) {
  // npm run desktop on Windows can deliver Ctrl+C directly to Electron. Route
  // that signal through app.quit() so before-quit stops our ngrok subprocess.
  let exitingFromSignal = false;
  for (const signal of ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])]) {
    process.on(signal, () => {
      if (exitingFromSignal) return;
      exitingFromSignal = true;
      debug(`received ${signal}; requesting graceful shutdown`);
      app.quit();
    });
  }
  app.on('second-instance', restoreWindow);
  app.whenReady().then(() => {
    debug('app ready');
    loadSettings();
    registerActions();
    createTray();
    createWindow();
    startProxy();
    void startNgrok();
    setInterval(pollHealth, 2000);
    setInterval(pollNgrok, 5000);
    if (PACKAGED_SMOKE_MODE) {
      setTimeout(() => { debug('isolated packaged smoke auto-exit'); app.quit(); },
        PACKAGED_SMOKE_EXIT_MS);
    }
  }).catch((error) => debug(`app ready failed: ${error.message}`));
  app.on('window-all-closed', () => { debug('all windows closed'); app.quit(); });
  app.on('before-quit', (event) => {
    if (exitReady) return;
    event.preventDefault();
    void shutdownOwnedServices();
  });
  app.on('will-quit', () => {
    child?.kill();
    ngrokChild?.kill();
  });
}