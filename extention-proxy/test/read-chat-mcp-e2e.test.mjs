// End-to-end transport test with synthetic conversations:
// real MCP client -> server -> WebSocket -> real background -> real content script.
// The site APIs are fixture stubs; no private browser conversations are accessed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readExtension = (name) => readFileSync(path.join(ROOT, '..', 'extention', name), 'utf8');
const PORT = 8829;
const TOKEN = 'e2e-fixture-token';
const EXTENSION_TOKEN = 'fixture-extension-only-' + 'a'.repeat(40);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cases = [
  { tabId: 110, site: 'chatgpt', hostname: 'chatgpt.com', url: 'https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc' },
  { tabId: 111, site: 'claude', hostname: 'claude.ai', url: 'https://claude.ai/chat/12345678-1234-1234-1234-123456789abc' },
  { tabId: 112, site: 'gemini', hostname: 'gemini.google.com', url: 'https://gemini.google.com/app/0123456789abcdef' },
];
const turns = [
  {
    role: 'human',
    blocks: [{ kind: 'text', text: 'Synthetic user message' }],
    attachments: [{ fileName: 'uploaded-document.pdf', mime: 'application/pdf' }],
  },
  {
    role: 'assistant',
    blocks: [
      { kind: 'thinking', text: 'Synthetic visible thinking summary' },
      { kind: 'tool_call', name: 'test_tool', input: '{}' },
      { kind: 'tool_result', text: 'Synthetic tool result' },
      { kind: 'text', text: 'Synthetic final answer' },
      { kind: 'image', name: 'sample.png', mime: 'image/png' },
      { kind: 'artifact_ref', artifactId: 'artifact-1' },
    ],
  },
];

function createContent(siteInfo, apiFailures, domFallback) {
  let onMessage;
  const ns = {};
  const self = { __exporter: ns };
  const raw = { conversation: { title: 'E2E fixture', turns } };
  const failIfNeeded = async () => {
    if (apiFailures.has(siteInfo.tabId)) throw new Error('sensitive-api-error-token=DO_NOT_LEAK');
    return raw;
  };
  ns.chatgptApi = {
    parseConvIdFromUrl: () => 'fake-id',
    getAccessToken: async () => 'test-token',
    fetchConversation: failIfNeeded,
  };
  ns.claudeApi = {
    parseConvIdFromUrl: () => 'fake-id',
    getOrgId: async () => 'fake-org',
    fetchConversation: failIfNeeded,
  };
  ns.geminiApi = {
    parseConvLocator: () => ({ convId: 'fake-id', userScope: '' }),
    getAtToken: async () => 'fake-at',
    fetchConversation: failIfNeeded,
  };
  for (const prefix of ['chatgpt', 'claude', 'gemini']) {
    ns[`${prefix}Normalize`] = { normalize: (response) => response };
  }
  const fakeDomNodes = ['user', 'assistant'].map((role) => ({
    parentNode: null,
    textContent: `DOM fallback ${role} text`,
    innerText: `DOM fallback ${role} text`,
    getAttribute: (attr) => attr === 'data-message-role' ? role : null,
    matches: (selector) => siteInfo.site === 'chatgpt'
      ? selector === 'li[data-message-role]'
      : role === 'user'
        ? selector.includes(siteInfo.site === 'claude' ? '[data-testid="user-message"]' : 'user-query .query-text')
        : false,
    querySelector: () => null,
    contains(other) { return this === other; },
  }));
  const ctx = createContext({
    self, window: {}, setTimeout, clearTimeout,
    location: { hostname: siteInfo.hostname, href: siteInfo.url },
    document: {
      title: 'Fixture tab',
      querySelectorAll: () => domFallback.has(siteInfo.tabId) ? fakeDomNodes : [],
    },
    chrome: { runtime: { onMessage: {
      addListener: (callback) => { onMessage = callback; },
      removeListener() {},
    } } },
  });
  for (const name of ['structured-reader.js', 'content.js']) runInContext(readExtension(name), ctx);
  assert.equal(typeof onMessage, 'function');
  return (message) => new Promise((resolve) => {
    const asyncResponse = onMessage(message, {}, resolve);
    assert.equal(asyncResponse, true);
  });
}

test('MCP read_chat options survive HTTP, WebSocket, background and content scripts', { timeout: 30000 }, async () => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), BRIDGE_TOKEN: TOKEN, EXTENSION_BRIDGE_TOKEN: EXTENSION_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let client;
  const apiFailures = new Set();
  const domFallback = new Set();
  try {
    const tabReceivers = new Map(cases.map((site) => [site.tabId, createContent(site, apiFailures, domFallback)]));
    const tabById = new Map(cases.map((site) => [site.tabId, { id: site.tabId, url: site.url }]));
    const chrome = {
      storage: {
        local: { get: async () => ({
          enabled: true, token: EXTENSION_TOKEN, serverUrl: `ws://localhost:${PORT}/bridge`,
          orchestratorTabId: cases[0].tabId,
        }) },
        session: { get: async () => ({ workers: [111, 112], workerOwners: { 111: 'legacy', 112: 'legacy' } }), set: async () => {} },
        onChanged: { addListener() {} },
      },
      tabs: {
        get: async (tabId) => tabById.get(tabId) || null,
        query: async () => [...tabById.values()],
        sendMessage: async (tabId, msg) => {
          assert.ok(tabReceivers.has(tabId));
          return tabReceivers.get(tabId)(msg);
        },
        onRemoved: { addListener() {} },
      },
      runtime: {
        onInstalled: { addListener() {} }, onStartup: { addListener() {} },
        onMessage: { addListener() {} },
      },
      alarms: { onAlarm: { addListener() {} }, create() {} },
    };
    const bg = createContext({
      chrome, WebSocket, URL, crypto, console,
      setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; },
      clearTimeout,
      setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return t; },
      clearInterval,
    });
    runInContext(readExtension('background.js'), bg);
    await sleep(1200);
    client = new Client({ name: 'read-chat-e2e', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(
      new URL(`http://localhost:${PORT}/mcp?token=${TOKEN}`),
    ));
    const remoteTools = (await client.listTools()).tools;
    const schema = remoteTools.find((tool) => tool.name === 'read_chat')?.inputSchema?.properties;
    assert.ok(schema?.include_reasoning, 'MCP schema exposes include_reasoning');
    assert.ok(schema?.include_attachments, 'MCP schema exposes include_attachments');
    assert.ok(schema?.last_n, 'MCP schema exposes last_n');

    const callRead = async (args) => {
      const reply = await client.callTool({ name: 'read_chat', arguments: args });
      assert.equal(reply.isError, undefined, 'bridge call itself should succeed');
      return JSON.parse(reply.content[0].text);
    };

    for (const { tabId, site } of cases) {
      for (const include_reasoning of [false, true]) {
        for (const include_attachments of [false, true]) {
          const res = await callRead({ tab_id: tabId, include_reasoning, include_attachments });
          assert.equal(res.ok, true, `${site}: read returns success`);
          assert.equal(res.message_count, 2);
          assert.equal(res.source, 'conversation_api');
          assert.match(res.transcript, /Synthetic final answer/);
          assert.equal(res.transcript.includes('Synthetic visible thinking summary'), include_reasoning);
          assert.equal(res.transcript.includes('[Tool result]'), include_reasoning);
          assert.equal(res.transcript.includes('[Attachment: uploaded-document.pdf]'), include_attachments);
          assert.equal(res.transcript.includes('[Image: sample.png]'), include_attachments);
          assert.equal(res.transcript.includes('[Artifact: artifact-1]'), include_attachments);
          assert.doesNotMatch(JSON.stringify(res), /test-token|fake-at|DO_NOT_LEAK/);
        }
      }
      for (const [last_n, expected] of [[1, 1], [2, 2], [200, 2]]) {
        const res = await callRead({ tab_id: tabId, last_n });
        assert.equal(res.message_count, expected, `${site} last_n=${last_n}`);
      }
      apiFailures.add(tabId);
      const fail = await callRead({ tab_id: tabId });
      assert.equal(fail.ok, false);
      assert.equal(fail.error_code, 'EXTRACTION_UNAVAILABLE');
      assert.doesNotMatch(JSON.stringify(fail), /sensitive-api-error-token|DO_NOT_LEAK/);
      domFallback.add(tabId);
      const fallback = await callRead({ tab_id: tabId });
      assert.equal(fallback.ok, true);
      assert.equal(fallback.source, 'dom_fallback');
      assert.equal(fallback.message_count, 2);
      assert.match(fallback.transcript, /User: DOM fallback user text/);
      assert.match(fallback.transcript, /Assistant: DOM fallback assistant text/);
      domFallback.delete(tabId);
      apiFailures.delete(tabId);
    }
    const defaultTab = await callRead({});
    assert.equal(defaultTab.site, 'chatgpt');
    assert.equal(defaultTab.message_count, 2);
    for (const invalid of [
      { tab_id: cases[0].tabId, last_n: 0 },
      { tab_id: cases[0].tabId, last_n: 201 },
      { tab_id: cases[0].tabId, include_reasoning: 'yes' },
      { tab_id: cases[0].tabId, include_attachments: 'no' },
    ]) {
      const response = await client.callTool({ name: 'read_chat', arguments: invalid });
      assert.equal(response.isError, true, 'invalid MCP options must be rejected');
    }
  } finally {
    if (client) await client.close().catch(() => {});
    server.kill();
  }
});
