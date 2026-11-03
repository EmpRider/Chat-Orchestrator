import { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, safeStorage, shell, utilityProcess } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectorUrl, ensureDesktopToken, ISOLATED_NGROK_CONFIG, normalizeNgrokAuthtoken, normalizeNgrokDomain } from './config.mjs';
import { createNgrokLogReader } from './ngrok-diagnostics.mjs';
import { createDesktopTray, installWindowCloseBehavior, minimizeToTrayPreference } from './tray-lifecycle.mjs';

// Set CHAT_ORCH_DIAGNOSTICS=1 for lifecycle messages (never credentials).
const debug = (message) => {
  if (process.env.CHAT_ORCH_DIAGNOSTICS === '1') console.error(`[desktop] ${message}`);
};

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Test mode uses an isolated port; normal application behavior stays on 8787.
const E2E_MODE = !app.isPackaged && process.env.CHAT_ORCH_E2E_MODE === '1';
const PORT = E2E_MODE ? Number(process.env.CHAT_ORCH_E2E_PORT || 8897) : 8787;
let window;
let tray;
let minimizeToTray = true;
let exitStarted = false;
let exitReady = false;
let child;
let ngrokChild;
let ngrokGeneration = 0;
let token = '';
let domain = '';
let phase = 'stopped';
let ngrokPhase = 'stopped';
let errorMessage = '';
let ngrokError = '';
let routeVerified = false;
let extensionConnected = false;
let stopping = false;

app.setName('Chat Orchestrator');
if (process.platform === 'win32') app.setAppUserModelId('com.empirerider.chat-orchestrator');
const hasInstanceLock = app.requestSingleInstanceLock();
debug(`single-instance lock=${hasInstanceLock}`);
if (!hasInstanceLock) app.quit();

const dataDir = () => app.getPath('userData');
const tokenFile = () => path.join(dataDir(), 'bridge.token');
const settingsFile = () => path.join(dataDir(), 'settings.json');
const ngrokAuthFile = () => path.join(dataDir(), 'ngrok-auth.bin');
const ngrokConfigFile = () => path.join(dataDir(), 'ngrok-isolated.yml');

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
    ngrokError,
    ngrokAuthConfigured: fs.existsSync(ngrokAuthFile()),
    error: errorMessage,
    extensionConnected,
    domain,
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
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    domain = saved.domain ? normalizeNgrokDomain(saved.domain) : '';
    minimizeToTray = minimizeToTrayPreference(saved.minimizeToTray);
  } catch {
    domain = '';
    minimizeToTray = true;
  }
}

function writeSettings() {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify({ domain, minimizeToTray }, null, 2), 'utf8');
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
  if (ngrokChild || ngrokPhase === 'starting') return;
  if (!domain || !fs.existsSync(ngrokAuthFile())) {
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
    const stdout = createNgrokLogReader(onRecord, [auth, token]);
    const stderr = createNgrokLogReader(onRecord, [auth, token]);
    owned.stdout?.on('data', (chunk) => stdout.write(chunk));
    owned.stderr?.on('data', (chunk) => stderr.write(chunk));
    owned.on('error', (error) => {
      if (ngrokChild !== owned || generation !== ngrokGeneration) return;
      ngrokPhase = 'error';
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
      if (ngrokChild !== owned || generation !== ngrokGeneration) return;
      ngrokChild = null;
      routeVerified = false;
      if (ngrokPhase !== 'stopping' && ngrokPhase !== 'error') {
        ngrokPhase = 'error';
        ngrokError = ngrokErrorCode === 'ERR_NGROK_320'
          ? 'ngrok says this domain belongs to another account (ERR_NGROK_320). Check the authtoken for the account that owns this domain.'
          : `ngrok stopped. Check the dedicated domain and authtoken${ngrokErrorCode ? ` (${ngrokErrorCode})` : ''}.`;
      } else if (ngrokPhase === 'stopping') ngrokPhase = 'stopped';
      publishState();
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
  if (!ngrokChild || !domain || ngrokPhase === 'stopping') return;
  const owned = ngrokChild;
  const checkedDomain = domain;
  let verified = false;
  try {
    const response = await fetch(`${checkedDomain}/health`, {
      headers: { 'ngrok-skip-browser-warning': '1' },
      signal: AbortSignal.timeout(3500),
    });
    if (!response.ok || !(await response.json()).ok) throw new Error('Tunnel is not ready');
    verified = true;
  } catch {}
  if (ngrokChild !== owned || domain !== checkedDomain || ngrokPhase === 'stopping') return;
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
  publishState();

  try {
    token = ensureDesktopToken(tokenFile(), app.isPackaged ? undefined : path.join(appDir, '.token'), process.env.BRIDGE_TOKEN);
    debug(`starting local MCP proxy at 127.0.0.1:${PORT}`);
    const processForThisStart = utilityProcess.fork(path.join(appDir, 'server.js'), [], {
      serviceName: 'Chat Orchestrator MCP',
      cwd: app.isPackaged ? process.resourcesPath : appDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        BRIDGE_TOKEN_FILE: tokenFile(),
      },
    });
    child = processForThisStart;
    // Keep child output out of UI and routine logs: it may contain diagnostic data.
    processForThisStart.stdout?.resume();
    processForThisStart.stderr?.resume();
    processForThisStart.on('message', (message) => {
      if (child !== processForThisStart) return;
      if (message?.type === 'ready') {
        debug('local MCP proxy ready');
        phase = 'running';
        errorMessage = '';
      } else if (message?.type === 'error') {
        debug('local MCP proxy reported an error');
        phase = 'error';
        errorMessage = String(message.message || 'Proxy startup failed');
        // A failed listener cannot be reused; release only the process we own.
        processForThisStart.kill();
      } else if (message?.type === 'stopped') {
        // The utility process keeps its parentPort open after closing HTTP.
        processForThisStart.kill();
      }
      publishState();
    });
    processForThisStart.on('exit', (code) => {
      debug(`local MCP proxy exited (code=${code})`);
      if (child !== processForThisStart) return;
      child = null;
      extensionConnected = false;
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

async function stopProxy() {
  if (!child) {
    phase = 'stopped';
    publishState();
    return;
  }
  const ownedChild = child;
  stopping = true;
  phase = 'stopping';
  publishState();
  await new Promise((resolve) => {
    const timer = setTimeout(() => { ownedChild.kill(); resolve(); }, 3500);
    ownedChild.once('exit', () => { clearTimeout(timer); resolve(); });
    try { ownedChild.postMessage({ type: 'stop' }); } catch { ownedChild.kill(); }
  });
  if (child === ownedChild) child = null;
  stopping = false;
  extensionConnected = false;
  phase = 'stopped';
  publishState();
}

async function pollHealth() {
  if (phase !== 'running') return;
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error('Health request failed');
    const health = await response.json();
    extensionConnected = Boolean(health.extensionConnected);
  } catch {
    extensionConnected = false;
  }
  publishState();
}

function requireTrustedWindow(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Unauthorized desktop request');
  }
}

function registerActions() {
  ipcMain.handle('bridge:status', (event) => { requireTrustedWindow(event); return state(); });
  ipcMain.handle('bridge:setMinimizeToTray', (event, enabled) => {
    requireTrustedWindow(event);
    if (typeof enabled !== 'boolean') throw new Error('Invalid tray preference');
    minimizeToTray = enabled;
    writeSettings();
    publishState();
    return state();
  });
  ipcMain.handle('bridge:showToken', (event) => { requireTrustedWindow(event); return token; });
  ipcMain.handle('bridge:copyToken', (event) => {
    requireTrustedWindow(event);
    clipboard.writeText(token);
  });
  ipcMain.handle('bridge:copyUrl', (event) => {
    requireTrustedWindow(event);
    if (!domain) throw new Error('Save your ngrok domain first');
    clipboard.writeText(connectorUrl(domain, token));
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
  ipcMain.handle('bridge:importToken', async (event) => {
    requireTrustedWindow(event);
    if (process.env.BRIDGE_TOKEN) throw new Error('BRIDGE_TOKEN environment override is active');
    const result = await dialog.showOpenDialog(window, {
      title: 'Import existing bridge token',
      properties: ['openFile'],
      filters: [{ name: 'Token files', extensions: ['token', 'txt'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePaths[0]) return false;
    const imported = fs.readFileSync(result.filePaths[0], 'utf8').trim();
    if (!imported || imported.length > 1024) throw new Error('Invalid token file');
    await stopProxy();
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(tokenFile(), imported, { encoding: 'utf8', mode: 0o600 });
    token = imported;
    startProxy();
    return true;
  });
}

function createWindow() {
  debug('creating window');
  window = new BrowserWindow({
    title: 'Chat Orchestrator',
    width: 780,
    height: 710,
    minWidth: 650,
    minHeight: 600,
    icon: path.join(appDir, 'desktop', 'assets', 'app.ico'),
    backgroundColor: '#070708',
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
