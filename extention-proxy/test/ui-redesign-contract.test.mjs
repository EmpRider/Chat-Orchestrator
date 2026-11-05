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
    'server-state', 'extension-state', 'ngrok-state', 'copy-extension-token', 'copy-url',
    'connector-url', 'token-value', 'import-token', 'domain', 'ngrok-token',
    'configure-ngrok', 'proxy-port', 'save-proxy-port', 'minimize-to-tray',
    'start', 'stop', 'agent-settings-save', 'agent-prompt-role', 'agent-prompt-text',
    'pair-principal', 'principal-list', 'queue-items', 'agent-seats', 'tool-call-log',
  ]) assert.ok(ids.includes(id), 'trusted control missing: ' + id);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /navigation\.js/);
  assert.match(html, /redesign\.css/);
  assert.match(nav, /\.hidden = view !== name/);
  assert.match(nav, /quick-extension-token/);
  assert.match(nav, /copy-extension-token/);
  assert.match(css, /\.app-layout/);
  assert.match(css, /\.sidebar/);
  assert.match(css, /\.app-view\[hidden\]/);
});

test('extension popup gives explicit extension-only token recovery guidance', () => {
  const html = extension('popup.html');
  const js = extension('popup.js');
  const manifest = JSON.parse(extension('manifest.json'));
  assert.equal(manifest.version, '0.1.3');
  assert.match(html, /id="serverUrl"/);
  assert.match(html, /id="token"/);
  assert.match(html, /id="next-step"/);
  assert.match(html, /Extension-only credential/);
  assert.match(html, /MCP connector token is different/);
  assert.match(js, /settingsSynced/);
  assert.match(js, /chrome\.storage\.local\.set/);
  assert.match(js, /type: 'reconnect'/);
  assert.match(js, /Connected · Credential needs attention/);
});
