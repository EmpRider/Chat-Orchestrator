import { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, safeStorage, shell, utilityProcess } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { agentConnectorUrl, ISOLATED_NGROK_CONFIG, normalizeNgrokAuthtoken, normalizeNgrokDomain, normalizeProxyPort, normalizeProfileName, PRIVATE_QUEUE_PREFERENCE_SCHEMA, resolvePrivateQueuePreference } from './config.mjs';
import { createNgrokLogReader } from './ngrok-diagnostics.mjs';
import { findReusableNgrokTunnel, describeNgrokExit } from './ngrok-reuse.mjs';
import { inspectPrivateJournal, preparePrivateJournal } from './coordination-storage.mjs';
import { createDesktopTray, installWindowCloseBehavior, minimizeToTrayPreference } from './tray-lifecycle.mjs';
import { DEFAULT_AGENT_SETTINGS, normalizeAgentSettings, replaceObsoletePromptSettings, disabledAgentSettings, composeAgentPrompt } from '../agent-settings.mjs';
import { createDiagnostics } from '../diagnostics.mjs';
import { findInstalledBrowser,managedBrowserLaunchArgs,managedProfilePath,
  normalizeManagedBrowser,matchesManagedEnrollment } from './managed-browser.mjs';
import {checkLatestRelease,evaluateUpdateReadiness,versionParts,stillApprovedRelease} from './update-policy.mjs';

// Set CHAT_ORCH_DIAGNOSTICS=1 for lifecycle messages (never credentials).
const debug = (message) => {
  if (process.env.CHAT_ORCH_DIAGNOSTICS === '1') console.error(`[desktop] ${message}`);
};

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unpackedExtensionDir=()=>app.isPackaged
  ? path.join(process.resourcesPath,'extension')
  : path.resolve(appDir,'..','extention');
// A two-key, test-only packaged smoke mode preserves the production port/profile.
// It is never enabled in ordinary packaged app launches.
const PACKAGED_SMOKE_MODE = app.isPackaged && process.env.CHAT_ORCH_PACKAGED_SMOKE === '1';
const E2E_MODE = process.env.CHAT_ORCH_E2E_MODE === '1' &&
  (!app.isPackaged || PACKAGED_SMOKE_MODE);
let PORT = E2E_MODE ? Number(process.env.CHAT_ORCH_E2E_PORT || 8897) : 8787;
const publicUpstreamPort=()=>PORT===65535?65534:PORT+1;
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
let managedBrowserSelection='none';
let managedBrowserPhase='not_configured';
let managedBrowserError='';
let managedBrowserLaunchAttempted=false;
let managedBrowserEnrollment=null; // User-verified stable extension installation for selected browser
let liveBrowserEnrollment=null; // Live socket proof, never persisted as user approval
let browserVerificationGeneration=0;
let browserRecheckInFlight=false;
let browserRecheckAttempted=false;
let browserRecheckNextAt=0; // retry transient inspection failures without reapproving
let onboardingComplete=false;
let autoStartWindows=false; // explicit opt-in only; never create a login entry on fresh install
const currentVersion=JSON.parse(fs.readFileSync(path.join(appDir,'package.json'),'utf8')).version;
let updateRelease=null;
let updatePhase='not_checked';
let updateMessage='';
let pendingUpdateVersion=null;
let lastUpdateGateCheck=0;
let updateGateBusy=false;
let releaseCheckBusy=false;
const sessionDir = path.join(os.tmpdir(), `chat-orchestrator-session-${crypto.randomUUID()}`);

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
const extensionProfileTokenFile=()=>path.join(dataDir(),'extension-profile-token.txt');
const publicMcpTokenFile=()=>path.join(dataDir(),'public-mcp-token.txt');
function publicMcpToken(){
  const file=publicMcpTokenFile();
  if(!fs.existsSync(file)){
    fs.mkdirSync(dataDir(),{recursive:true});
    try{fs.writeFileSync(file,crypto.randomBytes(32).toString('hex'),
      {flag:'wx',encoding:'utf8',mode:0o600});}
    catch(error){if(error.code!=='EEXIST')throw error;}
  }
  const token=fs.readFileSync(file,'utf8').trim();
  if(!/^[a-f0-9]{64}$/i.test(token))
    throw new Error('Invalid public MCP transport credential');
  return token;
}
function extensionProfileToken() {
  const file=extensionProfileTokenFile();
  if(!fs.existsSync(file)) {
    fs.mkdirSync(dataDir(),{recursive:true});
    const generated=crypto.randomBytes(32).toString('hex');
    try {fs.writeFileSync(file,generated,{flag:'wx',encoding:'utf8',mode:0o600});}
    catch(error) {if(error.code!=='EEXIST')throw error;}
  }
  const token=fs.readFileSync(file,'utf8').trim();
  if(!/^[a-f0-9]{64}$/i.test(token))
    throw new Error('Local browser profile credential is corrupt; refusing an unauthenticated extension bridge');
  return token;
}
const ngrokAuthFile = () => path.join(dataDir(), 'ngrok-auth.bin');
const ngrokConfigFile = () => path.join(dataDir(), 'ngrok-isolated.yml');
// FIFO receipts must survive a complete Desktop/Proxy process restart.
// The temporary session directory is only for transient runtime state.
// Keep journal + owner lock in this profile's persistent user-data directory.
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
    managedBrowserSelection,
    managedBrowserVerified:matchesManagedEnrollment(managedBrowserEnrollment,
      managedBrowserSelection,liveBrowserEnrollment,extensionConnected),
    onboardingComplete,
    update:{currentVersion,phase:updatePhase,message:updateMessage,
      availableVersion:updateRelease?.version||null,
      pendingVersion:pendingUpdateVersion},
    managedBrowserPhase,
    managedBrowserError,
    unpackedExtensionPath:unpackedExtensionDir(),
    autoStartWindows,
    port: PORT,
    publicPort:publicUpstreamPort(),
    routeVerified,
    minimizeToTray,
    trayAvailable: Boolean(tray && !tray.isDestroyed()),
    localWebSocketUrl: `ws://127.0.0.1:${PORT}/bridge`,
    publicPath: '/mcp/agent', // Display only the safe path, never the secret query.
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
    managedBrowserSelection=normalizeManagedBrowser(saved.managedBrowserSelection??'none');
    managedBrowserEnrollment=saved.managedBrowserEnrollment?.browser===managedBrowserSelection &&
      /^[0-9a-f-]{36}$/i.test(saved.managedBrowserEnrollment?.profileInstallId||'')
      ? {browser:managedBrowserSelection,profileInstallId:saved.managedBrowserEnrollment.profileInstallId}
      : null;
    onboardingComplete=saved.onboardingComplete===true && Boolean(managedBrowserEnrollment);
    pendingUpdateVersion=versionParts(saved.pendingUpdateVersion)?saved.pendingUpdateVersion:null;
    autoStartWindows=saved.autoStartWindows===true;
    domain = saved.domain ? normalizeNgrokDomain(saved.domain) : '';
    minimizeToTray = minimizeToTrayPreference(saved.minimizeToTray);
    privateCoordinationOptIn = resolvePrivateQueuePreference(saved);
    agentSettings = replaceObsoletePromptSettings(saved.agentSettings || {});
    if (!E2E_MODE) PORT = normalizeProxyPort(saved.proxyPort ?? 8787);
    if (saved.privateQueuePreferenceSchema !== PRIVATE_QUEUE_PREFERENCE_SCHEMA ||
        saved.agentSettings?.systemPrompts !== undefined || saved.agentSettings?.useWorkerSystemPrompt !== undefined) writeSettings();
  } catch {
    domain = '';
    managedBrowserSelection='none';
    managedBrowserEnrollment=null;
    onboardingComplete=false;
    pendingUpdateVersion=null;
    autoStartWindows=false;
    minimizeToTray = true;
    privateCoordinationOptIn = false;
    agentSettings = disabledAgentSettings();
    if (!E2E_MODE) PORT = 8787;
  }
}

function writeSettings() {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify({ domain, minimizeToTray,
    managedBrowserSelection,managedBrowserEnrollment,onboardingComplete,
    pendingUpdateVersion,
    autoStartWindows, privateCoordinationOptIn,
    privateQueuePreferenceSchema: PRIVATE_QUEUE_PREFERENCE_SCHEMA,
    proxyPort: PORT, agentSettings }, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function openManagedBrowser({openExtensions=false}={}) {
  if (managedBrowserSelection==='none')
    throw new Error('Select Chrome or Edge before opening a managed browser');
  const executable=findInstalledBrowser(managedBrowserSelection);
  if (!executable)
    throw new Error('Selected browser was not found in standard Windows installation paths');
  const profileDir=managedProfilePath(dataDir(),managedBrowserSelection);
  fs.mkdirSync(profileDir,{recursive:true});
  const launched=spawn(executable,managedBrowserLaunchArgs(
    managedBrowserSelection,profileDir,{openExtensions}),{
    detached:true,windowsHide:true,stdio:'ignore',shell:false,
  });
  launched.unref();
  managedBrowserLaunchAttempted=true;
  managedBrowserPhase='launching';
  managedBrowserError='';
  launched.once('spawn',()=>{
    managedBrowserPhase='launched';
    publishState();
  });
  launched.once('error',(error)=>{
    managedBrowserPhase='error';
    managedBrowserError=error.code==='ENOENT'
      ? 'Selected browser executable could not be started'
      : 'Managed browser startup failed; inspect browser installation';
    publishState();
  });
  // Browser profiles persist across app restarts; exiting the tray never
  // terminates an unrelated/default-profile browser process.
  return state();
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
  debug(`ngrok start requested (generation=${generation}, domain=${domain}, publicPort=${publicUpstreamPort()})`);
  publishState();
  try {
    // An app crash may leave its ngrok subprocess running. The new app must
    // not start a competing tunnel for the same dedicated domain. Match BOTH
    // exact public origin and loopback target port via the local ngrok API.
    const existing = await findReusableNgrokTunnel(domain,publicUpstreamPort());
    if (generation !== ngrokGeneration) return;
    if (existing) {
      ngrokReused=existing;
      debug('ngrok: using matching existing local tunnel; ownership remains external');
      diagnostics.info('ngrok.reused',{port:publicUpstreamPort(),reused:true});
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
    const owned = spawn('ngrok', ['http', String(publicUpstreamPort()), '--url', domain, '--config', configPath, '--log', 'stdout', '--log-format', 'json'], {
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
          const matching = await findReusableNgrokTunnel(domain,publicUpstreamPort());
          if (generation !== ngrokGeneration || ngrokChild || ngrokReused) return;
          if (matching) {
            ngrokReused=matching;
            ngrokPhase='starting';
            ngrokError='';
            diagnostics.info('ngrok.reused_after_conflict',{port:publicUpstreamPort(),reused:true});
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
      const stillPresent = await findReusableNgrokTunnel(checkedDomain,publicUpstreamPort(),{
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
  invalidateLiveBrowserVerification();
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
        CHAT_ORCH_PUBLIC_PORT:String(publicUpstreamPort()),
        CHAT_ORCH_PUBLIC_MCP_TOKEN:publicMcpToken(),
        CHAT_ORCH_EXTENSION_PROFILE_TOKEN:extensionProfileToken(),
        HOST: '127.0.0.1',
        CHAT_ORCH_PROFILE_DIR: sessionDir,
        CHAT_ORCH_SETTINGS_DIR: dataDir(),
        CHAT_ORCH_JOURNAL_DIR: dataDir(),
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
      } else if (message?.type === 'extension_session_changed') {
        // A different authenticated socket may replace the same browser
        // session between two HTTP health polls. Saved approval is not live
        // proof until we inspect the new extension installation again.
        invalidateLiveBrowserVerification();
        extensionConnected=false;
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
      invalidateLiveBrowserVerification();
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
  const wasConnected=extensionConnected;
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
  if(!extensionConnected && wasConnected)
    invalidateLiveBrowserVerification();
  if(extensionConnected && managedBrowserEnrollment &&
      !browserRecheckInFlight &&
      (!browserRecheckAttempted || Date.now()>=browserRecheckNextAt)){
    browserRecheckAttempted=true;
    browserRecheckInFlight=true;
    browserRecheckNextAt=Date.now()+15000;
    const generation=browserVerificationGeneration;
    void (async()=>{
      try{
        const verified=await inspectCurrentManagedExtension();
        if(generation!==browserVerificationGeneration || !extensionConnected)return;
        liveBrowserEnrollment=matchesManagedEnrollment(
          managedBrowserEnrollment,managedBrowserSelection,verified)?verified:null;
        if(liveBrowserEnrollment)browserRecheckNextAt=Number.MAX_SAFE_INTEGER;
      }catch{
        if(generation===browserVerificationGeneration)liveBrowserEnrollment=null;
      }finally{
        browserRecheckInFlight=false;
        publishState();
      }
    })();
  }
  publishState();
}

function invalidateLiveBrowserVerification(){
  browserVerificationGeneration++;
  liveBrowserEnrollment=null;
  browserRecheckAttempted=false;
  browserRecheckNextAt=0;
}

async function checkForUpdates(){
  if(releaseCheckBusy||updateGateBusy)return state();
  releaseCheckBusy=true;
  updatePhase='checking';
  publishState();
  try{
    updateRelease=await checkLatestRelease(currentVersion);
    if(pendingUpdateVersion && updateRelease?.version!==pendingUpdateVersion){
      updatePhase='held';
      updateMessage='Approved release is unavailable. Cancel and review the new release manually.';
    }else if(pendingUpdateVersion){
      updatePhase='waiting';
      updateMessage='Waiting for tasks, Parent reviews and FIFO receipts.';
    }else{
      updatePhase=updateRelease?'available':'current';
      updateMessage=updateRelease
        ? 'New version '+updateRelease.version+' available. Installation requires your approval.'
        : 'Current version is the latest trusted published release.';
    }
  }catch{
    updatePhase=pendingUpdateVersion?'held':'offline';
    updateMessage='Cannot verify the official release feed. No update will run.';
  }finally{
    releaseCheckBusy=false;
    publishState();
  }
  return state();
}

async function attemptUpdateHandoff(){
  if(!pendingUpdateVersion||updateGateBusy||updatePhase==='held')return;
  updateGateBusy=true;
  lastUpdateGateCheck=Date.now();
  try{
    const approvedVersion=pendingUpdateVersion;
    if(!updateRelease || updateRelease.version!==approvedVersion)
      throw new Error('Approved release cannot be verified against publisher metadata');
    if(phase!=='running'||!extensionConnected)
      throw new Error('Connected Proxy and extension required before updating');
    const extension=await desktopExtensionAction('update_readiness');
    const gate=evaluateUpdateReadiness(extension,coordinationSnapshot,{
      queueEnabled:runningPrivateCoordination===true,
    });
    if(!gate.ready)throw new Error(gate.blockers.slice(0,2).join('; '));
    // A deferred approval might be hours or days old. Do not open an
    // unverified or superseded release after the last Child finishes.
    const latest=await checkLatestRelease(currentVersion);
    if(!stillApprovedRelease(approvedVersion,updateRelease,latest)){
      updatePhase='held';
      throw new Error('Approved release changed or was withdrawn; review the latest release before continuing');
    }
    // Never download or execute an unsigned installer: open the trusted
    // release page for deliberate human installation without stopping Proxy.
    await shell.openExternal(latest.url);
    pendingUpdateVersion=null;
    writeSettings();
    updatePhase='release_opened';
    updateMessage='Official release opened. Verify installer signature/checksum before manual installation; Proxy remains running.';
  }catch(error){
    if(updatePhase!=='held')
      updatePhase=updateRelease?.version!==pendingUpdateVersion?'held':'waiting';
    updateMessage=String(error?.message||'Unknown update blocker').slice(0,220);
  }finally{
    updateGateBusy=false;
    publishState();
  }
}

function requireTrustedWindow(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Unauthorized desktop request');
  }
}

function desktopExtensionAction(action, tabId, nonce, browserSessionId,decisionId=null,choice=null,
  expectedProfileInstallId=null,expectedBrowserProduct=null) {
  if (!child || phase !== 'running') return Promise.reject(new Error('Start proxy and connect extension first'));
  if (!['set_orchestrator','diagnose','close_legacy_workers','close_managed_browser','verify_managed_browser','update_readiness',
      'inspect_root_repair','confirm_root_repair','list_agent_closures','resolve_agent_closure',
      'list_completion_monitors','set_manual_completion'].includes(action)) {
    return Promise.reject(new Error('Unsupported desktop action'));
  }
  if (!['close_legacy_workers','close_managed_browser','verify_managed_browser','update_readiness',
      'list_agent_closures','resolve_agent_closure',
      'list_completion_monitors','set_manual_completion'].includes(action) &&
      (!Number.isSafeInteger(tabId) || tabId <= 0)) {
    return Promise.reject(new Error('Enter an actual positive tab ID'));
  }
  if (browserSessionId != null &&
      (typeof browserSessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(browserSessionId))) {
    return Promise.reject(new Error('Enter a valid browser session ID from list_tabs'));
  }
  if (action === 'confirm_root_repair' && (typeof nonce !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(nonce) ||
      !browserSessionId)) {
    return Promise.reject(new Error('Root recovery requires its one-use nonce and browser session ID'));
  }
  if(action==='resolve_agent_closure' &&
      (!/^[0-9a-f-]{36}$/i.test(decisionId||'') ||
       !['accident','yes','cancel'].includes(choice)))
    return Promise.reject(new Error('Valid closure decision and explicit user choice required'));
  if(action==='set_manual_completion' &&
      (!/^[0-9a-f-]{36}$/i.test(decisionId||'')||
       !['completed','in_progress'].includes(choice)))
    return Promise.reject(new Error('Explicit manual task status choice and task ID required'));
  const owned = child;
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    // Full Accident restoration may create and verify several nested tabs.
    // A short UI IPC timeout would orphan a partially restored subtree.
    const deadlineMs=action==='resolve_agent_closure'&&choice==='accident'
      ? 180000 : 15000;
    const timer = setTimeout(() => {desktopExtensionActions.delete(id);
      reject(new Error('Extension action timed out; outcome unknown'));}, deadlineMs);
    desktopExtensionActions.set(id, {resolve,reject,timer});
    try {owned.postMessage({type:'desktop_extension_action', request_id:id, action, tab_id:tabId,
      confirmation_nonce:nonce,browser_session_id:browserSessionId,
      decision_id:decisionId,choice,expected_profile_install_id:expectedProfileInstallId,
      expected_browser_product:expectedBrowserProduct});}
    catch (error) {clearTimeout(timer); desktopExtensionActions.delete(id); reject(error);}
  });
}

async function inspectCurrentManagedExtension(){
  if(managedBrowserSelection==='none')
    throw new Error('Select and open your dedicated Chrome or Edge profile first');
  if(!extensionConnected)
    throw new Error('Connect the extension inside the selected dedicated profile');
  const verified=await desktopExtensionAction('verify_managed_browser');
  if(!/^[0-9a-f-]{36}$/i.test(verified?.profile_install_id||''))
    throw new Error('Connected extension has no stable enrollment identity');
  if(verified.browser_product!==managedBrowserSelection)
    throw new Error('Connected extension is not running in your selected browser');
  const bundledManifest=JSON.parse(fs.readFileSync(
    path.join(unpackedExtensionDir(),'manifest.json'),'utf8'));
  if(verified.extension_version!==bundledManifest.version)
    throw new Error('Extension version differs from this app build. Install/reload the bundled extension first');
  return verified;
}

function registerActions() {
  ipcMain.handle('bridge:checkUpdates',(event)=>{
    requireTrustedWindow(event);
    return checkForUpdates();
  });
  ipcMain.handle('bridge:requestUpdate',async(event)=>{
    requireTrustedWindow(event);
    if(!updateRelease || pendingUpdateVersion || updatePhase!=='available')
      throw new Error('Check for a release or cancel the previous update first');
    // A stale notification cannot authorize a release which the official
    // publisher no longer lists. No download/installer execution occurs.
    const latest=await checkLatestRelease(currentVersion);
    if(!latest || latest.version!==updateRelease.version)
      throw new Error('Available release changed; use Check for Updates again');
    pendingUpdateVersion=updateRelease.version;
    updatePhase='waiting';
    updateMessage='Update consent saved; verifying that Agent work will not be interrupted.';
    writeSettings();
    publishState();
    await attemptUpdateHandoff();
    return state();
  });
  ipcMain.handle('bridge:cancelUpdate',(event)=>{
    requireTrustedWindow(event);
    if(updateGateBusy)throw new Error('Update safety check in progress; retry cancellation');
    pendingUpdateVersion=null;
    updatePhase=updateRelease?'available':'not_checked';
    updateMessage='Pending update cancelled; no application changes made.';
    writeSettings();
    publishState();
    return state();
  });
  ipcMain.handle('bridge:copyPublicMcpToken',(event)=>{
    requireTrustedWindow(event);
    clipboard.writeText(publicMcpToken());
    return {copied:true};
  });
  ipcMain.handle('bridge:copyProfileToken',(event)=>{
    requireTrustedWindow(event);
    clipboard.writeText(extensionProfileToken());
    return {copied:true};
  });
  ipcMain.handle('bridge:listAgentClosures',(event)=>{
    requireTrustedWindow(event);
    return desktopExtensionAction('list_agent_closures');
  });
  ipcMain.handle('bridge:resolveAgentClosure',(event,id,choice)=>{
    requireTrustedWindow(event);
    return desktopExtensionAction('resolve_agent_closure',null,null,null,id,choice);
  });
  ipcMain.handle('bridge:setCompletionStatus',(event,taskId,status,browserSessionId)=>{
    requireTrustedWindow(event);
    return desktopExtensionAction('set_manual_completion',null,null,browserSessionId,taskId,status);
  });
  ipcMain.handle('bridge:copyExtensionPath',(event)=>{
    requireTrustedWindow(event);
    const extensionPath=unpackedExtensionDir();
    if (!fs.existsSync(path.join(extensionPath,'manifest.json')))
      throw new Error('Browser extension files are missing from this installation');
    clipboard.writeText(extensionPath);
    return {copied:true};
  });
  ipcMain.handle('bridge:setAutoStartWindows',(event,enabled)=>{
    requireTrustedWindow(event);
    if (typeof enabled!=='boolean') throw new Error('Invalid automatic startup choice');
    if (!app.isPackaged || process.platform!=='win32' || E2E_MODE)
      throw new Error('Automatic startup is configurable in the installed Windows app only');
    const args=PROFILE==='default'?[]:[`--profile=${PROFILE}`];
    app.setLoginItemSettings({openAtLogin:enabled,args});
    autoStartWindows=app.getLoginItemSettings({args}).openAtLogin===true;
    writeSettings();
    publishState();
    return state();
  });
  ipcMain.handle('bridge:configureManagedBrowser',(event,value)=>{
    requireTrustedWindow(event);
    const selected=normalizeManagedBrowser(value);
    if (selected!=='none' && !findInstalledBrowser(selected))
      throw new Error('Selected browser not found. Install Chrome or Edge first');
    if(managedBrowserSelection!==selected){
      managedBrowserEnrollment=null;
      onboardingComplete=false;
      invalidateLiveBrowserVerification();
    }
    managedBrowserSelection=selected;
    managedBrowserPhase=selected==='none'?'not_configured':'selected';
    managedBrowserLaunchAttempted=false;
    managedBrowserError='';
    writeSettings();
    if (selected!=='none') openManagedBrowser();
    publishState();
    return state();
  });
  ipcMain.handle('bridge:verifyManagedBrowser',async(event)=>{
    requireTrustedWindow(event);
    const selectedAtStart=managedBrowserSelection;
    const generation=browserVerificationGeneration;
    const verified=await inspectCurrentManagedExtension();
    if(generation!==browserVerificationGeneration ||
        selectedAtStart!==managedBrowserSelection || !extensionConnected)
      throw new Error('Browser selection or connection changed during verification; retry');
    if(managedBrowserEnrollment?.profileInstallId!==verified.profile_install_id)
      onboardingComplete=false;
    managedBrowserEnrollment={browser:managedBrowserSelection,profileInstallId:verified.profile_install_id};
    liveBrowserEnrollment=verified;
    browserRecheckAttempted=true;
    browserRecheckNextAt=Number.MAX_SAFE_INTEGER;
    writeSettings();
    publishState();
    return state();
  });
  ipcMain.handle('bridge:finishOnboarding',async(event)=>{
    requireTrustedWindow(event);
    if(!managedBrowserEnrollment || managedBrowserEnrollment.browser!==managedBrowserSelection ||
        !extensionConnected)
      throw new Error('Verify the dedicated browser extension before completing setup');
    const selectedAtStart=managedBrowserSelection;
    const generation=browserVerificationGeneration;
    const verified=await inspectCurrentManagedExtension();
    if(generation!==browserVerificationGeneration ||
        selectedAtStart!==managedBrowserSelection || !extensionConnected ||
        !matchesManagedEnrollment(managedBrowserEnrollment,selectedAtStart,verified))
      throw new Error('Connected extension changed since approval; verify the new installation again');
    liveBrowserEnrollment=verified;
    onboardingComplete=true;
    writeSettings();
    publishState();
    return state();
  });
  ipcMain.handle('bridge:openManagedBrowserExtensions',(event)=>{
    requireTrustedWindow(event);
    return openManagedBrowser({openExtensions:true});
  });
  ipcMain.handle('bridge:extensionAction', (event, action, tabId, nonce, browserSessionId) => {
    requireTrustedWindow(event);
    return desktopExtensionAction(action, tabId, nonce, browserSessionId);
  });
  ipcMain.handle('bridge:previewPrompt', (event, input) => {
    requireTrustedWindow(event);
    return composeAgentPrompt(input?.promptModules
      ? {...agentSettings, promptModules: input.promptModules} : agentSettings, input);
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
    clipboard.writeText(agentConnectorUrl(domain,publicMcpToken()));
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
    requestExit: () => void requestTrayQuit(),
    onTrayUnavailable: () => dialog.showErrorBox('System Tray unavailable',
      'Chat Orchestrator is still running. The window cannot be hidden without a tray icon.'),
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

function openConnectionSetupForBrowserVerification(){
  restoreWindow();
  if(window && !window.isDestroyed())
    window.webContents.send('bridge:openConnectionSetup');
}

function showBrowserVerificationRequired(reason){
  // A selected browser name alone cannot establish that the connected
  // extension belongs to the *dedicated* profile. Never auto-enroll or close
  // arbitrary normal Chrome/Edge windows from this Exit dialog.
  const options={
    type:'warning',title:'Verify managed browser before closing',
    message:'Your dedicated browser profile has not been verified.',
    detail:reason+
      '\n\nNothing was closed. In Connection Setup, verify the extension is running in the dedicated browser profile, then click Verify connected browser profile and Finish setup.',
    buttons:['Open Connection Setup','Cancel'],defaultId:0,cancelId:1,noLink:true,
  };
  const result=window && !window.isDestroyed()
    ? dialog.showMessageBoxSync(window,options) : dialog.showMessageBoxSync(options);
  if(result===0)openConnectionSetupForBrowserVerification();
}

function createTray() {
  // Tray is created before the browser window so X never hides without a restore path.
  try {
    const image = nativeImage.createFromPath(path.join(appDir, 'desktop', 'assets', 'app.ico'));
    if (image.isEmpty()) throw new Error('Application icon is missing');
    tray = createDesktopTray({
      Tray, Menu, icon: image,
      restore: restoreWindow,
      exit: () => void requestTrayQuit(),
    });
  } catch (error) {
    // Without a usable tray, X closes the app rather than leaving it invisible.
    debug(`tray unavailable: ${error.message}`);
    tray = null;
  }
}

async function requestTrayQuit() {
  if (exitStarted || exitReady) return;
  const options={
    type:'question',title:'Exit Chat Orchestrator',
    message:'What should happen to your managed browser?',
    detail:'Keeping the browser open preserves ChatGPT tabs. Close Managed Browser closes all normal windows in the single connected extension profile. Confirm the connected extension is in your selected dedicated profile before choosing Close.',
    buttons:['Keep Browser Open','Close Managed Browser','Cancel'],
    defaultId:2,cancelId:2,noLink:true,
  };
  const choice=window && !window.isDestroyed()
    ? dialog.showMessageBoxSync(window,options) : dialog.showMessageBoxSync(options);
  if (choice===2) return;
  if (choice===1) {
    if (managedBrowserSelection==='none') {
      showBrowserVerificationRequired('Select a dedicated Chrome or Edge browser first.');
      return;
    }
    if(!managedBrowserEnrollment || managedBrowserEnrollment.browser!==managedBrowserSelection){
      showBrowserVerificationRequired(
        'You selected '+(managedBrowserSelection==='edge'?'Microsoft Edge':'Google Chrome')+
        ', but this profile has no saved user-approved extension enrollment.');
      return;
    }
    let closureDispatched=false;
    try {
      const selection=managedBrowserSelection;
      const generation=browserVerificationGeneration;
      const verified=await inspectCurrentManagedExtension();
      if(generation!==browserVerificationGeneration ||
          selection!==managedBrowserSelection ||
          !matchesManagedEnrollment(managedBrowserEnrollment,selection,verified))
        throw new Error('Connected browser identity changed before quit');
      closureDispatched=true;
      const closure=await desktopExtensionAction('close_managed_browser',null,null,null,null,null,
        managedBrowserEnrollment.profileInstallId,managedBrowserSelection);
      if(!closure || !Number.isSafeInteger(closure.windows) || closure.windows<0 ||
          (closure.windows>0 && (closure.scheduled!==true ||
            closure.confirmed_closed!==closure.windows-1 ||
            closure.remaining_windows!==1)))
        throw new Error('Managed browser close could not confirm its pre-exit steps');
      // Let the authenticated extension attempt the final window removal
      // before stopping its Proxy. The last close may end the extension socket,
      // so this delay is not proof of OS-process termination.
      if(closure.scheduled)await new Promise((resolve)=>setTimeout(resolve,700));
    } catch(error) {
      if(closureDispatched){
        dialog.showErrorBox('Managed browser close not confirmed',
          'A close request may already have reached the extension. The app remains open. Inspect the browser windows before trying again; the result is uncertain.');
      } else {
        showBrowserVerificationRequired(
          'The live browser/extension could not be verified for this exit request. '+
          String(error?.message||'Check the extension connection.'));
      }
      return;
    }
  }
  app.quit();
}

async function shutdownOwnedServices() {
  if (exitStarted) return;
  exitStarted = true;
  try {
    await Promise.allSettled([stopNgrok(), stopProxy()]);
  } finally {
    // Never delete the persistent journal. Only temporary runtime files may
    // be cleaned after a confirmed stop with no owned journal lock.
    if (phase === 'stopped' && !fs.existsSync(privateCoordinationJournalPath() + '.lock')) {
      try { fs.rmSync(sessionDir, {recursive:true,force:true}); }
      catch (error) { console.error('[desktop] Session cleanup failed:', error.message); }
    } else console.error('[desktop] Session journal needs inspection; not removing it.');
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
    fs.mkdirSync(sessionDir, {mode:0o700});
    loadSettings();
    registerActions();
    createTray();
    createWindow();
    startProxy();
    void startNgrok();
    if (!E2E_MODE && managedBrowserSelection!=='none' &&
        !managedBrowserLaunchAttempted) {
      try {openManagedBrowser();}
      catch(error) {
        managedBrowserPhase='error';
        managedBrowserError=error.message;
        publishState();
      }
    }
    setInterval(pollHealth, 2000);
    setInterval(pollNgrok, 5000);
    if(!E2E_MODE){
      void checkForUpdates();
      setInterval(()=>void checkForUpdates(),6*60*60*1000);
      setInterval(()=>{
        if(pendingUpdateVersion && !updateGateBusy &&
            Date.now()-lastUpdateGateCheck>30000)
          void attemptUpdateHandoff();
      },10000);
    }
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