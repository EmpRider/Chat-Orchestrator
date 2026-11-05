import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { normalizeNgrokDomain, normalizeNgrokAuthtoken, connectorUrl, ensureDesktopToken, ISOLATED_NGROK_CONFIG, normalizeProxyPort, normalizeProfileName } from '../desktop/config.mjs';

test('named profiles and per-profile proxy ports validate before filesystem or socket use', () => {
  assert.equal(normalizeProfileName('default'), 'default');
  assert.equal(normalizeProfileName(' Work_1 '), 'work_1');
  for (const value of ['../work', '', '.hidden', 'space name', '/root', 'ümlaut', 'a'.repeat(33)]) {
    assert.throws(() => normalizeProfileName(value), /Profile must begin/);
  }
  for (const value of ['1024', '8787', '65535', ' 8899 ']) {
    assert.equal(normalizeProxyPort(value), Number(value));
  }
  for (const value of ['', '0', '80', '65536', '8888.5', 'NaN', '-8787', undefined]) {
    assert.throws(() => normalizeProxyPort(value), /port from 1024 to 65535/);
  }
});

test('isolated ngrok configuration contains no credentials', () => {
  assert.equal(ISOLATED_NGROK_CONFIG, 'version: 3\nagent: {}\n');
  assert.doesNotMatch(ISOLATED_NGROK_CONFIG, /authtoken|secret|token=/i);
});

test('ngrok domain accepts only a clean HTTPS origin', () => {
  assert.equal(normalizeNgrokDomain('https://example.ngrok.app/'), 'https://example.ngrok.app');
  assert.equal(normalizeNgrokDomain('unheated-detached-jokester.ngrok-free.dev'),
    'https://unheated-detached-jokester.ngrok-free.dev');
  assert.equal(normalizeNgrokDomain('  example.ngrok.app  '), 'https://example.ngrok.app');
  for (const value of ['http://example.ngrok.app', 'https://user:pass@example.ngrok.app',
    'https://example.ngrok.app/agentbridge', 'https://example.ngrok.app?token=secret',
    'example.ngrok.app/agentbridge', 'example.ngrok.app?token=secret', 'file:///C:/temp']) {
    assert.throws(() => normalizeNgrokDomain(value));
  }
});

test('connector URL uses the dedicated domain root MCP path and encodes bridge token', () => {
  assert.equal(connectorUrl('https://example.ngrok.app', 'a+b &?'),
    'https://example.ngrok.app/mcp?token=a%2Bb+%26%3F');
  assert.equal(connectorUrl('', 'secret'), '');
});

test('ngrok authtoken input refuses empty, short, and whitespace-containing values', () => {
  assert.equal(normalizeNgrokAuthtoken('  aBc123456789  '), 'aBc123456789');
  for (const value of ['', 'abc', 'invalid token', 'foo\nbarbazqux']) {
    assert.throws(() => normalizeNgrokAuthtoken(value));
  }
});

test('desktop token imports existing token once, then stays stable', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chat-orch-test-'));
  const legacy = path.join(dir, 'legacy.token');
  const target = path.join(dir, 'data', 'bridge.token');
  writeFileSync(legacy, 'legacy-secret\n');
  assert.equal(ensureDesktopToken(target, legacy), 'legacy-secret');
  assert.equal(readFileSync(target, 'utf8'), 'legacy-secret');
  writeFileSync(legacy, 'changed');
  assert.equal(ensureDesktopToken(target, legacy), 'legacy-secret');
  assert.equal(existsSync(legacy), true);
});

test('explicit environment token takes precedence without rewriting stored token', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chat-orch-env-'));
  const target = path.join(dir, 'bridge.token');
  writeFileSync(target, 'stored');
  assert.equal(ensureDesktopToken(target, undefined, 'override'), 'override');
  assert.equal(readFileSync(target, 'utf8'), 'stored');
});
