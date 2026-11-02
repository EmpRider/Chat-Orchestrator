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
    domain: '', publicPath: '/mcp',
  };
  let stateListener;
  let submitted;
  const bridge = {
    status: async () => state,
    onState(callback) { stateListener = callback; },
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
});
