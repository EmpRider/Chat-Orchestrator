import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

test('status refresh never erases an unsaved ngrok domain while the authtoken field is focused', async () => {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      const listeners = new Map();
      elements.set(id, {
        value: '', textContent: '', className: '', disabled: false, style: {},
        addEventListener(type, callback) { listeners.set(type, callback); },
        dispatch(type) { return listeners.get(type)?.(); },
      });
    }
    return elements.get(id);
  };
  const state = {
    phase: 'running', ngrokPhase: 'stopped', ngrokAuthConfigured: false,
    ngrokError: '', error: '', extensionConnected: false, routeVerified: false,
    domain: '', publicPath: '/mcp', port: 8787, profile: 'default',
    localWebSocketUrl: 'ws://127.0.0.1:8787/bridge',
  };
  let stateListener;
  let submitted;
  let configuredPort;
  const bridge = {
    status: async () => state,
    onState(callback) { stateListener = callback; },
    async setMinimizeToTray(enabled) {
      state.minimizeToTray = enabled;
      return { ...state };
    },
    async configurePrivateCoordination(enabled) {
      state.privateCoordinationOptIn = enabled;
      state.privateCoordinationRestartRequired = true;
      return { ...state };
    },
    async configurePort(port) {
      configuredPort = port;
      state.port = Number(port);
      state.localWebSocketUrl = `ws://127.0.0.1:${port}/bridge`;
      return { ...state, phase: 'stopped', ngrokPhase: 'stopped' };
    },
    async configureNgrok(domain, authToken) {
      submitted = { domain, authToken };
      return { ...state, domain: `https://${domain}`, ngrokAuthConfigured: true, ngrokPhase: 'starting' };
    },
  };
  const document = { activeElement: null, getElementById: element };
  const window = { bridge, addEventListener() {} };
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'renderer.js'), 'utf8');
  runInNewContext(source, { document, window });
  await new Promise((resolve) => setImmediate(resolve));

  const domainInput = element('domain');
  domainInput.value = 'unheated-detached-jokester.ngrok-free.dev';
  domainInput.dispatch('input');
  element('ngrok-token').value = 'test-only-ngrok-authtoken';
  document.activeElement = element('ngrok-token');
  stateListener({ ...state, extensionConnected: true });

  assert.equal(domainInput.value, 'unheated-detached-jokester.ngrok-free.dev');
  await element('configure-ngrok').dispatch('click');
  assert.deepEqual(submitted, {
    domain: 'unheated-detached-jokester.ngrok-free.dev',
    authToken: 'test-only-ngrok-authtoken',
  });
  assert.equal(domainInput.value, 'https://unheated-detached-jokester.ngrok-free.dev');
  assert.equal(element('minimize-to-tray').checked, true, 'default checked');
  element('minimize-to-tray').checked = false;
  await element('minimize-to-tray').dispatch('change');
  assert.equal(state.minimizeToTray, false);
  stateListener({ ...state, phase: 'running' });
  assert.equal(element('minimize-to-tray').checked, false, 'poll updates preserve preference');
  element('minimize-to-tray').checked = true;
  await element('minimize-to-tray').dispatch('change');
  assert.equal(state.minimizeToTray, true);
  assert.match(element('configure-private-coordination').textContent, /enable queue/i);
  await element('configure-private-coordination').dispatch('click');
  assert.equal(state.privateCoordinationOptIn, true);
  assert.match(element('private-coordination-state').textContent, /Restart the local proxy/);
  assert.match(element('configure-private-coordination').textContent, /Disable private queue/);
  await element('configure-private-coordination').dispatch('click');
  assert.equal(state.privateCoordinationOptIn, false);
  assert.equal(element('proxy-port').disabled, true, 'running proxy port is locked');
  stateListener({ ...state, phase: 'stopped', ngrokPhase: 'stopped' });
  assert.equal(element('proxy-port').disabled, false);
  element('proxy-port').value = '8899';
  element('proxy-port').dispatch('input');
  stateListener({ ...state, phase: 'stopped', ngrokPhase: 'stopped' });
  assert.equal(element('proxy-port').value, '8899', 'status polling preserves unsaved port edits');
  await element('save-proxy-port').dispatch('click');
  assert.equal(configuredPort, '8899');
  assert.equal(element('proxy-port-label').textContent, 'localhost:8899');
  assert.match(element('extension-local-url').textContent, /8899\/bridge/);
  assert.match(element('profile-description').textContent, /default/);
});
