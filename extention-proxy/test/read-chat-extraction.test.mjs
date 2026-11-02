import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

// Exercise the unmodified extension content script, not a copied extractor.
const contentScript = readFileSync(new URL('../../extention/content.js', import.meta.url), 'utf8');

function matchesSimple(node, selector) {
  const match = /^([a-z][\w-]*)?(?:\[([\w-]+)(?:(\^?=)(?:"([^"]*)"|'([^']*)'|([\w-]+)))?\])?(?:\.([\w-]+))?$/i.exec(selector);
  if (!match || !(match[1] || match[2] || match[7])) {
    throw new Error(`Unsupported synthetic selector: ${selector}`);
  }
  const [, tag, attribute, operator, doubleQuoted, singleQuoted, unquoted, className] = match;
  if (tag && node.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  if (attribute) {
    const actual = node.getAttribute(attribute);
    if (actual === null) return false;
    const expected = doubleQuoted ?? singleQuoted ?? unquoted;
    if (operator === '=' && actual !== expected) return false;
    if (operator === '^=' && !actual.startsWith(expected)) return false;
  }
  return !className || (node.getAttribute('class') || '').split(/\s+/).includes(className);
}

function matchesSelector(node, selector) {
  const pieces = selector.trim().split(/\s+/);
  if (pieces.length > 2) throw new Error(`Unsupported synthetic selector: ${selector}`);
  if (!matchesSimple(node, pieces.at(-1))) return false;
  if (pieces.length === 1) return true;
  for (let ancestor = node.parentNode; ancestor; ancestor = ancestor.parentNode) {
    if (matchesSimple(ancestor, pieces[0])) return true;
  }
  return false;
}

function matchesGroup(node, selectors) {
  return selectors.split(',').some((selector) => matchesSelector(node, selector));
}

function* walk(node) {
  yield node;
  for (const child of node.children) yield* walk(child);
}

function element(tag, attributes = {}, children = [], text = '') {
  const node = {
    tagName: tag.toUpperCase(),
    attributes,
    children,
    parentNode: null,
    ownText: text,
    getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
    matches(selector) { return matchesGroup(this, selector); },
    contains(other) {
      for (let current = other; current; current = current.parentNode) {
        if (current === this) return true;
      }
      return false;
    },
    querySelector(selector) {
      for (const descendant of walk(this)) {
        if (descendant !== this && matchesGroup(descendant, selector)) return descendant;
      }
      return null;
    },
    get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(''); },
    get innerText() { return this.textContent; },
  };
  for (const child of children) child.parentNode = node;
  return node;
}

function loadReadChat(hostname, turns) {
  const root = element('main', {}, turns);
  const document = {
    title: 'Fixture',
    querySelectorAll(selectors) {
      return [...walk(root)].filter((node) => matchesGroup(node, selectors));
    },
  };
  let onMessage;
  const chrome = {
    runtime: {
      onMessage: {
        addListener(listener) { onMessage = listener; },
        removeListener() {},
      },
    },
  };
  runInNewContext(contentScript, { document, window: {}, location: { hostname }, chrome }, {
    filename: 'extention/content.js',
  });
  assert.equal(typeof onMessage, 'function', 'content script must register its real message handler');
  return (lastN) => {
    let response;
    onMessage({ cmd: 'read_chat', lastN }, {}, (value) => { response = value; });
    assert.ok(response, 'read_chat must send its response');
    return JSON.parse(JSON.stringify(response));
  };
}

test('ZIP-backed li user and assistant turns are extracted with explicit roles and clean text', () => {
  const readChat = loadReadChat('chatgpt.com', [
    element('li', { 'data-message-role': 'user' }, [
      element('div', { 'data-user-message-copy': '' }, [], 'U1'),
      element('button', {}, [], 'Copy'),
    ]),
    element('li', { 'data-message-role': 'assistant' }, [
      element('div', { 'data-assistant-markdown': '' }, [], 'A1'),
      element('button', {}, [], 'Copy'),
    ]),
  ]);

  assert.deepEqual(readChat(), {
    ok: true,
    site: 'chatgpt',
    title: 'Fixture',
    message_count: 2,
    transcript: 'User: U1\n\nAssistant: A1',
  });
});

test('synthetic selector semantics are explicit and unsupported selectors throw', () => {
  const child = element('span', { class: 'markdown', 'data-user-message-copy': '' }, [], 'U1');
  const parent = element('li', { 'data-message-role': 'user', 'data-testid': 'conversation-turn-1' }, [child]);
  assert.equal(matchesGroup(parent, 'li[data-message-role], [data-message-author-role="user"]'), true);
  assert.equal(matchesGroup(child, '[data-testid^="conversation-turn-"] .markdown'), true);
  assert.equal(matchesGroup(child, 'li[data-message-role]'), false);
  assert.throws(() => matchesGroup(child, 'div:first-child'), /Unsupported synthetic selector/);
});

test('legacy data-message-author-role turns retain roles and their envelope', () => {
  const readChat = loadReadChat('chatgpt.com', [
    element('div', { 'data-message-author-role': 'user' }, [], 'U1'),
    element('div', { 'data-message-author-role': 'assistant' }, [], 'A1'),
  ]);
  assert.deepEqual(readChat(), {
    ok: true, site: 'chatgpt', title: 'Fixture', message_count: 2,
    transcript: 'User: U1\n\nAssistant: A1',
  });
});

test('nested legacy and li containers do not duplicate a logical turn', () => {
  const readChat = loadReadChat('chatgpt.com', [
    element('div', { 'data-message-author-role': 'user' }, [
      element('li', { 'data-message-role': 'user' }, [
        element('span', { 'data-user-message-copy': '' }, [], 'U1'),
      ]),
    ]),
    element('li', { 'data-message-role': 'assistant' }, [
      element('article', { 'data-turn': 'assistant' }, [
        element('span', { 'data-assistant-markdown': '' }, [], 'A1'),
      ]),
    ]),
  ]);
  assert.equal(readChat().message_count, 2);
  assert.equal(readChat().transcript, 'User: U1\n\nAssistant: A1');
});

test('same-text sibling turns remain separate messages', () => {
  const readChat = loadReadChat('chatgpt.com', [
    element('li', { 'data-message-role': 'user' }, [
      element('span', { 'data-user-message-copy': '' }, [], 'U1'),
    ]),
    element('li', { 'data-message-role': 'user' }, [
      element('span', { 'data-user-message-copy': '' }, [], 'U1'),
    ]),
  ]);
  assert.equal(readChat().message_count, 2);
  assert.equal(readChat().transcript, 'User: U1\n\nUser: U1');
});

test('role on a li ancestor wins over a nested markdown assistant fallback', () => {
  const readChat = loadReadChat('chatgpt.com', [
    element('li', { 'data-message-role': 'user' }, [
      element('div', { 'data-testid': 'conversation-turn-1' }, [
        element('div', { class: 'markdown', 'data-user-message-copy': '' }, [], 'U1'),
      ]),
    ]),
  ]);
  assert.equal(readChat().message_count, 1);
  assert.equal(readChat().transcript, 'User: U1');
});

test('last_n=1/2/200 slices the final deduplicated chronological messages', () => {
  const readChat = loadReadChat('chatgpt.com', [
    element('div', { 'data-message-author-role': 'user' }, [], 'U1'),
    element('li', { 'data-message-role': 'assistant' }, [
      element('span', { 'data-assistant-markdown': '' }, [], 'A1'),
    ]),
    element('li', { 'data-message-role': 'user' }, [
      element('span', { 'data-user-message-copy': '' }, [], 'U2'),
    ]),
    element('li', { 'data-message-role': 'assistant' }, [
      element('span', { 'data-assistant-markdown': '' }, [], 'A2'),
    ]),
  ]);
  assert.deepEqual([readChat(1).message_count, readChat(1).transcript], [1, 'Assistant: A2']);
  assert.deepEqual([readChat(2).message_count, readChat(2).transcript], [2, 'User: U2\n\nAssistant: A2']);
  assert.deepEqual([readChat(200).message_count, readChat(200).transcript], [
    4, 'User: U1\n\nAssistant: A1\n\nUser: U2\n\nAssistant: A2',
  ]);
});

test('empty conversation keeps the successful empty envelope', () => {
  const readChat = loadReadChat('chatgpt.com', []);
  assert.deepEqual(readChat(), {
    ok: true, site: 'chatgpt', title: 'Fixture', message_count: 0, transcript: '',
  });
});

test('whitespace-only turns are omitted from count and transcript', () => {
  const readChat = loadReadChat('chatgpt.com', [
    element('article', { 'data-turn': 'assistant' }, [], '  '),
    element('article', { 'data-turn': 'user' }, [], 'U1'),
  ]);
  assert.equal(readChat().message_count, 1);
  assert.equal(readChat().transcript, 'User: U1');
});

test('read_chat sees a streaming turn update without duplicating its container', () => {
  const partial = element('span', { 'data-assistant-markdown': '' }, [], 'A');
  const readChat = loadReadChat('chatgpt.com', [
    element('li', { 'data-message-role': 'assistant' }, [partial]),
  ]);
  assert.equal(readChat().transcript, 'Assistant: A');
  partial.ownText = 'A1';
  assert.equal(readChat().message_count, 1);
  assert.equal(readChat().transcript, 'Assistant: A1');
});

test('legacy ChatGPT conversation-turn markdown without role attributes remains readable', () => {
  const readChat = loadReadChat('chatgpt.com', [
    element('div', { 'data-testid': 'conversation-turn-1' }, [
      element('div', { class: 'markdown' }, [], 'A1'),
    ]),
  ]);
  assert.deepEqual(readChat(), {
    ok: true, site: 'chatgpt', title: 'Fixture', message_count: 1,
    transcript: 'Assistant: A1',
  });
});

test('broad legacy role ancestor does not collapse two sibling li turns', () => {
  const readChat = loadReadChat('chatgpt.com', [
    element('div', { 'data-message-author-role': 'user' }, [
      element('li', { 'data-message-role': 'user' }, [
        element('span', { 'data-user-message-copy': '' }, [], 'U1'),
      ]),
      element('li', { 'data-message-role': 'assistant' }, [
        element('span', { 'data-assistant-markdown': '' }, [], 'A1'),
      ]),
    ]),
  ]);
  assert.deepEqual(readChat(), {
    ok: true, site: 'chatgpt', title: 'Fixture', message_count: 2,
    transcript: 'User: U1\n\nAssistant: A1',
  });
});

test('one nested li turn keeps its explicit assistant role over a contradictory user wrapper', () => {
  const readChat = loadReadChat('chatgpt.com', [
    element('div', { 'data-message-author-role': 'user' }, [
      element('li', { 'data-message-role': 'assistant' }, [
        element('span', { 'data-assistant-markdown': '' }, [], 'A1'),
      ]),
    ]),
  ]);
  assert.deepEqual(readChat(), {
    ok: true, site: 'chatgpt', title: 'Fixture', message_count: 1,
    transcript: 'Assistant: A1',
  });
});

test('explicit outer li user role wins over a nested assistant article', () => {
  const readChat = loadReadChat('chatgpt.com', [
    element('li', { 'data-message-role': 'user' }, [
      element('article', { 'data-turn': 'assistant' }, [
        element('span', { 'data-user-message-copy': '' }, [], 'U1'),
      ]),
    ]),
  ]);
  assert.deepEqual(readChat(), {
    ok: true, site: 'chatgpt', title: 'Fixture', message_count: 1,
    transcript: 'User: U1',
  });
});

test('Claude extraction remains separate and unchanged', () => {
  const readChat = loadReadChat('claude.ai', [
    element('div', { 'data-testid': 'user-message' }, [], 'U1'),
    element('div', { class: 'font-claude-response' }, [], 'A1'),
  ]);
  assert.deepEqual(readChat(), {
    ok: true, site: 'claude', title: 'Fixture', message_count: 2,
    transcript: 'User: U1\n\nAssistant: A1',
  });
});
