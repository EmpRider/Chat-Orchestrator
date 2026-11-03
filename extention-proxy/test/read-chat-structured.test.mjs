import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const read = (path) => readFileSync(new URL(`../../extention/${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

function harness(site, turns, { fail = false } = {}) {
  const hostname = { chatgpt: 'chatgpt.com', claude: 'claude.ai', gemini: 'gemini.google.com' }[site];
  const url = {
    chatgpt: 'https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc',
    claude: 'https://claude.ai/chat/12345678-1234-1234-1234-123456789abc',
    gemini: 'https://gemini.google.com/app/abcdef1234567890',
  }[site];
  let listener;
  const self = { __exporter: {} };
  const ns = self.__exporter;
  const fakeResponse = { conversation: { title: 'Synthetic conversation', turns } };
  const failed = () => { throw new Error('do not expose internal-token=secret'); };
  ns.chatgptApi = {
    parseConvIdFromUrl: () => 'fake-id',
    getAccessToken: async () => 'secret',
    fetchConversation: fail ? failed : async () => fakeResponse,
  };
  ns.claudeApi = {
    parseConvIdFromUrl: () => 'fake-id',
    getOrgId: async () => 'org',
    fetchConversation: fail ? failed : async () => fakeResponse,
  };
  ns.geminiApi = {
    parseConvLocator: () => ({ convId: 'id', userScope: '' }),
    getAtToken: async () => 'secret',
    fetchConversation: fail ? failed : async () => fakeResponse,
  };
  for (const adapter of ['chatgpt', 'claude', 'gemini']) {
    ns[`${adapter}Normalize`] = { normalize: (raw) => raw };
  }
  const context = createContext({
    self,
    window: {},
    setTimeout, clearTimeout,
    location: { hostname, href: url },
    document: {
      title: 'Synthetic page',
      querySelectorAll: () => [],
    },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; }, removeListener() {} } } },
  });
  runInContext(read('structured-reader.js'), context);
  runInContext(read('content.js'), context);
  assert.equal(typeof listener, 'function');
  return async (options = {}) => {
    let respond;
    const result = new Promise((resolve) => { respond = resolve; });
    const asyncChannel = listener({ cmd: 'read_chat', ...options }, {}, respond);
    assert.equal(asyncChannel, true, 'structured API read must use async channel');
    return JSON.parse(JSON.stringify(await result));
  };
}

const sampleTurns = [
  { role: 'human', blocks: [{ kind: 'text', text: 'Question' }], attachments: [{ fileName: 'report.pdf' }] },
  { role: 'assistant', blocks: [
    { kind: 'thinking', text: 'Internal notes' },
    { kind: 'tool_result', text: 'RAW_TOOL_RESULT' },
    { kind: 'text', text: 'Answer' },
    { kind: 'image', name: 'chart.png' },
  ] },
];

for (const site of ['chatgpt', 'claude', 'gemini']) {
  test(`${site}: structured API read succeeds even with zero DOM matches`, async () => {
    const readChat = harness(site, sampleTurns);
    const result = await readChat();
    assert.equal(result.ok, true);
    assert.equal(result.source, 'conversation_api');
    assert.equal(result.message_count, 2);
    assert.match(result.transcript, /User: Question/);
    assert.match(result.transcript, /Assistant: Answer/);
    assert.match(result.transcript, /\[Attachment: report.pdf\]/);
    assert.match(result.transcript, /\[Image: chart.png\]/);
    assert.doesNotMatch(result.transcript, /RAW_TOOL_RESULT|Internal notes/);
    assert.equal((await readChat({ lastN: 1 })).message_count, 1);
    const optIn = await readChat({ includeReasoning: true, includeAttachments: false });
    assert.match(optIn.transcript, /Internal notes|Tool result/);
    assert.doesNotMatch(optIn.transcript, /report.pdf/);
    assert.doesNotMatch(JSON.stringify(optIn), /secret/);
  });

  test(`${site}: failed API plus empty DOM reports failure instead of success with zero messages`, async () => {
    const response = await harness(site, sampleTurns, { fail: true })();
    assert.equal(response.ok, false);
    assert.equal(response.message_count, 0);
    assert.equal(response.error_code, 'EXTRACTION_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(response), /internal-token|secret/);
  });
}

test('manifest loads adapter dependencies and hooks before content.js', () => {
  for (const [site, hostname] of [['chatgpt', 'chatgpt.com'], ['claude', 'claude.ai'], ['gemini', 'gemini.google.com']]) {
    const group = manifest.content_scripts.find((c) =>
      c.matches.includes(`https://${hostname}/*`) && c.js?.includes('structured-reader.js'));
    assert.ok(group, `${site} must have structured reader`);
    assert.equal(group.js.at(-1), 'content.js');
    assert.ok(group.js.indexOf('structured-reader.js') < group.js.indexOf('content.js'));
    for (const path of group.js) {
      assert.ok(existsSync(new URL(`../../extention/${path}`, import.meta.url)), `${path} exists`);
    }
  }
  for (const site of ['chatgpt', 'gemini']) {
    assert.ok(manifest.content_scripts.some((c) =>
      c.world === 'MAIN' && c.run_at === 'document_start' &&
      c.js?.includes(`reference-exporter/adapters/${site}/hook-main.js`)));
  }
});

test('upstream ChatGPT normalizer parses synthetic conversation graph', async () => {
  const self = { __exporter: {} };
  const context = createContext({ self, chrome: { runtime: {} }, console });
  for (const path of [
    'reference-exporter/core/utils.js',
    'reference-exporter/adapters/chatgpt/genui.js',
    'reference-exporter/adapters/chatgpt/normalize.js',
    'structured-reader.js',
  ]) runInContext(read(path), context);
  const m = (role, body) => ({ author: { role }, content: { content_type: 'text', parts: [body] }, metadata: {} });
  const raw = {
    title: 'Synthetic graph', current_node: 'a',
    mapping: {
      u: { id: 'u', parent: null, message: m('user', 'Hello') },
      a: { id: 'a', parent: 'u', message: m('assistant', 'Goodbye') },
    },
  };
  const normalized = self.__exporter.chatgptNormalize.normalize(raw, { inlineTextFiles: false });
  assert.equal(normalized.conversation.turns.length, 2);
  const rendered = self.__chatOrchStructuredReader.makeResult(normalized.conversation, 'chatgpt');
  assert.equal(rendered.message_count, 2);
  assert.match(rendered.transcript, /User: Hello/);
  assert.match(rendered.transcript, /Assistant: Goodbye/);
});

for (const site of ['chatgpt', 'claude']) {
  test(`${site}: real reference API and normalizer load public fixture through read_chat`, async () => {
    const fixture = JSON.parse(readFileSync(new URL(`./fixtures/reference-exporter/${site}.json`, import.meta.url), 'utf8'));
    let listener;
    const calls = [];
    const self = { __exporter: {}, __exporterChatGPT: { token: 'fixture-token' } };
    const hostname = site === 'chatgpt' ? 'chatgpt.com' : 'claude.ai';
    const convId = site === 'chatgpt'
      ? '00000000-0000-0000-0000-000000000001'
      : '00000000-0000-0000-0000-000000000003';
    const context = createContext({
      self, console, TextDecoder, TextEncoder, URL, URLSearchParams,
      setTimeout, clearTimeout,
      location: { href: `https://${hostname}/${site === 'chatgpt' ? 'c' : 'chat'}/${convId}`, hostname },
      document: { title: 'Fixture document', querySelectorAll: () => [] },
      window: {},
      chrome: { runtime: { getManifest: () => ({ version: 'test' }), onMessage: {
        addListener(fn) { listener = fn; }, removeListener() {},
      } } },
      fetch: async (url, init) => {
        calls.push({ url, init });
        let body;
        if (url.endsWith('/api/organizations')) {
          body = [{ uuid: '00000000-0000-0000-0000-0000000000aa' }];
        } else {
          body = fixture;
        }
        return { ok: true, json: async () => body };
      },
    });
    const base = `reference-exporter/adapters/${site}/`;
    const scripts = [
      'reference-exporter/core/utils.js',
      `${base}api.js`,
      ...(site === 'chatgpt' ? [`${base}genui.js`] : [`${base}widgets.js`]),
      `${base}normalize.js`, 'structured-reader.js', 'content.js',
    ];
    for (const path of scripts) runInContext(read(path), context);
    const result = await new Promise((resolve) => {
      assert.equal(listener({ cmd: 'read_chat' }, {}, resolve), true);
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'conversation_api');
    assert.ok(result.message_count >= 2, 'should extract multiple real normalized turns');
    assert.ok(result.transcript.includes('User:'));
    assert.ok(result.transcript.includes('Assistant:'));
    assert.ok(calls.length >= 1);
    assert.doesNotMatch(JSON.stringify(result), /fixture-token/);
    if (site === 'chatgpt') {
      assert.ok(calls[0].url.endsWith(`/backend-api/conversation/${convId}`));
      assert.equal(calls[0].init.headers.authorization, 'Bearer fixture-token');
    }
  });
}

test('upstream Gemini normalizer reads sparse batchexecute-shaped turns', () => {
  const self = { __exporter: {} };
  const context = createContext({ self, chrome: { runtime: {} }, console });
  for (const path of [
    'reference-exporter/core/utils.js',
    'reference-exporter/adapters/gemini/normalize.js',
    'structured-reader.js',
  ]) runInContext(read(path), context);
  const round = [
    ['c_fixture', 'r_1'],
    null,
    [['Gemini question', 1, null, null, null], 1, null, 0, 'turn-1'],
    [[['rc_1', ['Gemini response']]]],
  ];
  const normalized = self.__exporter.geminiNormalize.normalize([round], { title: 'Gemini fixture' });
  const result = self.__chatOrchStructuredReader.makeResult(normalized.conversation, 'gemini');
  assert.equal(result.message_count, 2);
  assert.match(result.transcript, /User: Gemini question/);
  assert.match(result.transcript, /Assistant: Gemini response/);
});
