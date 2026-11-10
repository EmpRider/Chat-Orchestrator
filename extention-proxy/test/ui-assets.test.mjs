import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, 'desktop', p));

test('dark UI has visible icon assets, setting checkbox and accessible controls', () => {
  const html = read('index.html').toString('utf8');
  const css = read('style.css').toString('utf8');
  const matches = [...html.matchAll(/(?:src)="(assets\/[^"]+)"/g)].map((x) => x[1]);
  assert.ok(matches.length >= 10, 'icons shown throughout UI');
  for (const asset of matches) {
    const file = path.join(root, 'desktop', asset);
    assert.ok(existsSync(file), `${asset} must exist`);
    const b = readFileSync(file);
    assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${asset} must be a PNG`);
    assert.ok(b.length >= 200, `${asset} cannot be empty`);
  }
  const ico = read('assets/app.ico');
  assert.equal(ico.readUInt16LE(2), 1);
  // Electron Builder rejects anything below 256px for Windows icons.
  assert.equal(ico.readUInt8(6), 0, 'ICO width byte 0 means 256px');
  assert.equal(ico.readUInt8(7), 0, 'ICO height byte 0 means 256px');
  const appPng = read('assets/app.png');
  assert.equal(appPng.readUInt32BE(16), 256);
  assert.equal(appPng.readUInt32BE(20), 256);
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.build.win.icon, 'desktop/assets/app.ico');
  assert.match(css, /background:\s*#070708/);
  assert.match(css, /grid-template-columns:\s*repeat\(3/);
  assert.match(css, /\.coordination-control\s*\{[^}]*display:\s*flex;[^}]*column-gap:\s*10px;/,
    'Private queue action/status must not visually run together');
  assert.match(html, /id="minimize-to-tray" type="checkbox" checked/);
  assert.match(html, /Minimize to system tray when closing/);
  for (const name of ['proxy-port-label', 'proxy-port', 'save-proxy-port', 'profile-description',
    'extension-local-url', 'domain', 'ngrok-token', 'configure-ngrok', 'connector-url', 'copy-url', 'start', 'stop']) {
    assert.ok(html.includes(`id="${name}"`), `existing control ${name} must remain`);
  }
  for (const obsolete of ['token-value', 'copy-token', 'import-token', 'copy-extension-token']) {
    assert.ok(!html.includes(`id="${obsolete}"`), `obsolete proxy auth control ${obsolete} must be absent`);
  }
  assert.match(html, /Icons by Icons8/);
});
