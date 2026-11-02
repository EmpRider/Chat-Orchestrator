import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNgrokLogReader, inspectNgrokLogLine } from '../desktop/ngrok-diagnostics.mjs';

test('ngrok diagnostics keep the useful failure reason and error code', () => {
  const line = JSON.stringify({
    lvl: 'eror',
    msg: 'failed to start tunnel',
    err: 'The endpoint is offline (ERR_NGROK_320)',
    headers: { Authorization: 'Bearer must-not-log' },
  });
  const result = inspectNgrokLogLine(line);
  assert.match(result.diagnostic, /failed to start tunnel/);
  assert.match(result.diagnostic, /endpoint is offline/);
  assert.equal(result.code, 'ERR_NGROK_320');
  assert.doesNotMatch(result.diagnostic, /must-not-log/);
});

test('ngrok diagnostics redact exact tokens, auth headers, and URL queries', () => {
  const ngrokToken = 'secret-ngrok-credential';
  const bridgeToken = 'secret-bridge-credential';
  const result = inspectNgrokLogLine(JSON.stringify({
    lvl: 'error', msg: 'authentication failed',
    err: `token=${ngrokToken} Authorization: Bearer ${bridgeToken} https://example.dev/mcp?token=${bridgeToken}`,
  }), [ngrokToken, bridgeToken]);
  assert.ok(result);
  assert.doesNotMatch(result.diagnostic, /secret-/);
  assert.doesNotMatch(result.diagnostic, /Bearer secret/);
  assert.doesNotMatch(result.diagnostic, /\?token=/);
  assert.match(result.diagnostic, /\[redacted\]/);
});

test('ngrok diagnostics suppress unrelated log fields and unstructured output', () => {
  assert.equal(inspectNgrokLogLine('raw secrets without structure'), null);
  assert.equal(inspectNgrokLogLine(JSON.stringify({
    lvl: 'info', msg: 'http request', uri: '/mcp?token=hidden',
  })), null);
  assert.equal(inspectNgrokLogLine(JSON.stringify({
    lvl: 'info', msg: 'worker established session', request: 'secret',
  })).diagnostic.includes('secret'), false);
  assert.equal(inspectNgrokLogLine(JSON.stringify({
    lvl: 'info', msg: 'join connections',
  })), null);
});

test('ngrok diagnostics decode JSON across chunks and retain codes without raw text', () => {
  const seen = [];
  const reader = createNgrokLogReader((record) => seen.push(record));
  const line = JSON.stringify({ lvl: 'eror', msg: 'failed to start tunnel', err: 'ERR_NGROK_334' });
  reader.write(line.slice(0, 12));
  reader.write(line.slice(12) + '\nnoise ERR_NGROK_320');
  reader.flush();
  assert.equal(seen.length, 2);
  assert.equal(seen[0].code, 'ERR_NGROK_334');
  assert.equal(seen[1].diagnostic, 'error code ERR_NGROK_320');
});
