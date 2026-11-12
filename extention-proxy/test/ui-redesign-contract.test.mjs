import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = (name) => readFileSync(path.join(root, 'desktop', name), 'utf8');
const extension = (name) => readFileSync(path.join(root, '..', 'extention', name), 'utf8');

test('redesigned navigation keeps each trusted desktop control and one page per section', () => {
  const html = desktop('index.html');
  const nav = desktop('navigation.js');
  const css = desktop('redesign.css');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size, 'duplicate control IDs are forbidden');
  for (const page of ['overview', 'connections', 'agents', 'settings']) {
    assert.match(html, new RegExp('id="view-' + page + '"'));
    assert.match(html, new RegExp('data-view="' + page + '"'));
  }
  for (const id of [
    'server-state', 'extension-state', 'ngrok-state', 'copy-url',
    'connector-url', 'domain', 'ngrok-token',
    'configure-ngrok', 'proxy-port', 'save-proxy-port', 'minimize-to-tray',
    'start', 'stop', 'agent-settings-save', 'agent-prompt-module', 'agent-prompt-text',
    'queue-items', 'agent-seats', 'tool-call-log',
  ]) assert.ok(ids.includes(id), 'trusted control missing: ' + id);
  for (const obsolete of ['pair-principal', 'principal-panel', 'principal-list', 'show-identity-recovery', 'copy-principal-url',
    'token-value', 'import-token', 'copy-token', 'copy-extension-token', 'quick-extension-token'])
    assert.ok(!ids.includes(obsolete), 'obsolete auth control remains: ' + obsolete);
  assert.doesNotMatch(desktop('renderer.js'), /enrollPrincipal|copyScopedUrl|revokePrincipal|showToken|copyToken/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /navigation\.js/);
  assert.match(html, /redesign\.css/);
  assert.match(nav, /\.hidden = view !== name/);
  assert.doesNotMatch(nav, /quick-extension-token|copy-extension-token/);
  assert.match(css, /\.app-layout/);
  assert.match(css, /\.sidebar/);
  assert.match(css, /\.app-view\[hidden\]/);
});

test('extension popup accepts only the local WebSocket URL', () => {
  const html = extension('popup.html');
  const js = extension('popup.js');
  const manifest = JSON.parse(extension('manifest.json'));
  assert.equal(manifest.version, '0.1.3');
  assert.match(html, /id="serverUrl"/);
  assert.doesNotMatch(html, /id="token"/);
  assert.match(html, /id="next-step"/);
  assert.doesNotMatch(html, /Extension-only credential|MCP connector token is different/);
  assert.match(js, /settingsSynced/);
  assert.match(js, /chrome\.storage\.local\.set/);
  assert.match(js, /type: 'reconnect'/);
  assert.match(js, /Connected - Synchronizing settings/);
});
test('root recovery is exclusively a confirmed trusted Desktop workflow', () => {
  const html = desktop('index.html');
  const renderer = desktop('renderer.js');
  const preload = desktop('preload.cjs');
  const main = desktop('main.mjs');
  const server = readFileSync(path.join(root,'server.js'),'utf8');
  for (const id of ['agent-inspect-root','agent-confirm-root']) {
    assert.match(html,new RegExp('id="'+id+'"'));
    assert.match(renderer,new RegExp(id));
  }
  assert.match(html,/id="agent-confirm-root"[^>]*disabled/);
  assert.match(renderer,/window\.confirm\(/);
  assert.match(preload,/extensionAction: \(action, tabId, nonce, browserSessionId\)/);
  assert.match(renderer,/offer\.browserSessionId/);
  assert.match(main,/requireTrustedWindow\(event\)/);
  assert.match(main,/confirmation_nonce:nonce,browser_session_id:browserSessionId/);
  assert.match(server,/await desktopAction\(event\.data\)/);
  assert.match(server,/action === 'confirm_root_repair'\) return reconcileRootFromDesktop\(tab_id,confirmation_nonce,browser_session_id\)/);
  assert.match(server,/rootRepairOffers\.delete\(repairKey\)/);
  assert.match(server,/privateJournal\?\.unresolvedForTab\(tabId,browserSessionId\)/);
  assert.match(server,/tabRegistry\.hasChildren\(tabId,browserSessionId\)/);
  assert.match(server,/tabRegistry\.reconcileRoot\(/);
  assert.doesNotMatch(server,/registerTool\('(?:inspect_root_repair|confirm_root_repair)'/);
});
