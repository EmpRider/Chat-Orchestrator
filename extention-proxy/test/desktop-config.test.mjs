import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeNgrokDomain, normalizeNgrokAuthtoken, connectorUrl, ISOLATED_NGROK_CONFIG, normalizeProxyPort, normalizeProfileName, PRIVATE_QUEUE_PREFERENCE_SCHEMA, resolvePrivateQueuePreference } from '../desktop/config.mjs';

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

test('private FIFO is on by default, migrates legacy off once, and respects new opt-out', () => {
  assert.equal(resolvePrivateQueuePreference(), true);
  assert.equal(resolvePrivateQueuePreference({}), true);
  assert.equal(resolvePrivateQueuePreference({privateCoordinationOptIn: false}), true);
  assert.equal(resolvePrivateQueuePreference({privateCoordinationOptIn: true}), true);
  assert.equal(resolvePrivateQueuePreference({
    privateQueuePreferenceSchema: PRIVATE_QUEUE_PREFERENCE_SCHEMA, privateCoordinationOptIn: true,
  }), true);
  assert.equal(resolvePrivateQueuePreference({
    privateQueuePreferenceSchema: PRIVATE_QUEUE_PREFERENCE_SCHEMA, privateCoordinationOptIn: false,
  }), false);
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

test('connector URL has no proxy-managed credential and Ngrok auth remains separate', () => {
  assert.equal(connectorUrl('https://example.ngrok.app'), 'https://example.ngrok.app/mcp');
  assert.equal(connectorUrl(''), '');
});

test('ngrok authtoken input refuses empty, short, and whitespace-containing values', () => {
  assert.equal(normalizeNgrokAuthtoken('  aBc123456789  '), 'aBc123456789');
  for (const value of ['', 'abc', 'invalid token', 'foo\nbarbazqux']) {
    assert.throws(() => normalizeNgrokAuthtoken(value));
  }
});
