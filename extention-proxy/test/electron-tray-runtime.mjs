// Optional real-Windows-Electron smoke test. Run via:
//   $env:CHAT_ORCH_E2E_MODE='1'; $env:CHAT_ORCH_E2E_DIR='<temp>';
//   .\node_modules\.bin\electron.cmd test/electron-tray-runtime.mjs first
// Repeat with "second" and "tray-exit" using the same temporary user-data dir.
// Never accesses the user's real credentials or the production MCP listener.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const dir = process.env.CHAT_ORCH_E2E_DIR ||
  path.join(os.tmpdir(), 'chat-orchestrator-ui-e2e');
const mode = process.argv.find((value) => ['first', 'second', 'tray-exit', 'duplicate'].includes(value)) || 'first';
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', dir);
const outFile = path.join(dir, `result-${mode}.json`);
let report = { mode, passed: false };

async function waitUntil(check, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('E2E wait timeout');
}
function ensure(condition, description) {
  if (!condition) throw new Error(description);
}

await import('../desktop/main.mjs');
app.on('will-quit', () => {
  const value = globalThis.__chatOrchE2E?.state();
  const lockPath = path.join(app.getPath('userData'),'coordination.events.journal.lock');
  const lockReleased = !fs.existsSync(lockPath);
  report.shutdown = {
    proxyPhase: value?.phase,
    ngrokPhase: value?.ngrokPhase,
    trayAvailable: value?.trayAvailable,
    journalLockReleased: lockReleased,
  };
  report.passed = !report.error && value?.phase === 'stopped' &&
    value?.ngrokPhase === 'stopped' && lockReleased;
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
});

if (mode === 'duplicate') {
  app.whenReady().then(() => {
    // A real duplicate should have quit at requestSingleInstanceLock().
    process.exitCode = 3;
    app.quit();
  });
} else app.whenReady().then(async () => {
  try {
    const test = globalThis.__chatOrchE2E;
    ensure(test, 'E2E diagnostics are missing');
    const win = await waitUntil(() => {
      const item = test.getWindow();
      return item && !item.isDestroyed() && item.webContents && !item.webContents.isLoading() ? item : null;
    });
    await waitUntil(() => win.isVisible());
    const tray = test.getTray();
    ensure(tray && !tray.isDestroyed(), 'Real Windows system tray could not be created');
    await waitUntil(() => test.state().phase === 'running');

    const ui = await win.webContents.executeJavaScript(`(() => ({
      background: getComputedStyle(document.body).backgroundColor,
      images: [...document.images].length,
      missingImages: [...document.images].filter(i => !i.complete || i.naturalWidth === 0).map(i => i.src),
      contentWidth: document.documentElement.scrollWidth,
      contentHeight: document.documentElement.scrollHeight,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      hasCheckbox: Boolean(document.querySelector('#minimize-to-tray')),
      checkboxChecked: document.querySelector('#minimize-to-tray')?.checked,
    }))()`);
    ensure(['rgb(7, 7, 8)','rgb(11, 16, 24)'].includes(ui.background),
      'Configured dark desktop theme did not render');
    ensure(ui.images >= 10 && ui.missingImages.length === 0,
      'Desktop navigation/status icons failed to render');
    ensure(ui.contentWidth <= ui.viewportWidth, 'UI overflows horizontally');
    ensure(ui.hasCheckbox, 'Tray checkbox missing from UI');
    report.ui = ui;
    if (mode === 'first') {
      ensure(ui.checkboxChecked, 'Tray preference must default to checked');
      const screenshot = await win.webContents.capturePage();
      fs.writeFileSync(path.join(dir, 'dark-ui.png'), screenshot.toPNG());
      const port = test.state().port;
      ensure((await fetch(`http://127.0.0.1:${port}/health`)).ok, 'Proxy health unavailable before hide');
      const connection = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
      await new Promise((resolve, reject) => {
        connection.once('open', resolve);
        connection.once('error', reject);
      });
      win.close();
      await waitUntil(() => !win.isVisible());
      ensure((await fetch(`http://127.0.0.1:${port}/health`)).ok, 'Proxy health lost after tray hide');
      ensure(connection.readyState === WebSocket.OPEN, 'Active WebSocket disconnected when hidden');
      const liveHealth = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      ensure(liveHealth.extensionConnected === true, 'Existing extension connection lost when hidden');
      report.activeWebSocketPreserved = true;
      // A second launch must only restore the existing instance, never start a
      // duplicate proxy. The second process should exit promptly.
      const duplicate = spawn(process.execPath,
        [fileURLToPath(import.meta.url), 'duplicate'],
        { env: { ...process.env }, windowsHide: true, stdio: 'ignore' });
      const duplicateCode = await Promise.race([
        new Promise((resolve) => duplicate.once('exit', resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Second Electron instance did not exit')), 6000)),
      ]);
      ensure(duplicateCode === 0, 'Second-instance launch did not exit normally');
      await waitUntil(() => win.isVisible());
      report.singleInstanceRestored = true;
      report.hiddenProxyContinues = true;
      win.close();
      await waitUntil(() => !win.isVisible());
      tray.emit('click');
      await waitUntil(() => win.isVisible());
      report.trayRestore = true;
      connection.close();
      await win.webContents.executeJavaScript(`document.querySelector('#minimize-to-tray').click()`);
      await waitUntil(() => test.state().minimizeToTray === false);
      report.changedImmediately = true;
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
      ensure(saved.minimizeToTray === false, 'Tray preference was not persisted');
      win.close();
    } else if (mode === 'second') {
      ensure(!ui.checkboxChecked, 'Unchecked tray preference did not survive restart');
      ensure(test.state().minimizeToTray === false, 'Saved tray preference not restored');
      report.persistedAcrossRestart = true;
      // Turn on immediately to verify the state no longer exits when X is clicked.
      await win.webContents.executeJavaScript(`document.querySelector('#minimize-to-tray').click()`);
      await waitUntil(() => test.state().minimizeToTray === true);
      win.close();
      await waitUntil(() => !win.isVisible());
      ensure((await fetch(`http://127.0.0.1:${test.state().port}/health`)).ok, 'Proxy unavailable in tray on restart');
      report.hiddenAfterReenable = true;
      app.quit(); // same exit path as tray menu's Exit command
    } else {
      ensure(ui.checkboxChecked, 'Tray must remain enabled for tray-exit test');
      win.close();
      await waitUntil(() => !win.isVisible());
      const health = await fetch(`http://127.0.0.1:${test.state().port}/health`);
      ensure(health.ok, 'Proxy failed while hidden');
      app.quit(); // same callback as context-menu Exit
      report.exitedFromTray = true;
    }
  } catch (error) {
    report.error = String(error?.message || error);
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    app.quit();
  }
});
