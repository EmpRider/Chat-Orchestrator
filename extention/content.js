// Content script: DOM adapter for claude.ai and chatgpt.com.
// NOTE: selectors are best-effort and WILL drift when the sites change.
// Edit CONFIGS below (or use the popup's "Diagnose" button to see what matches).
(() => {
  // Re-injection must TAKE OVER, not bail out. After the extension is reloaded the
  // old (orphaned) script's window flag survives in the same isolated world, so a
  // plain "already injected" guard would stop the fresh script from ever registering
  // its message listener, and the tab would stay unreachable.
  if (typeof window.__chatOrchCleanup === 'function') {
    try {
      window.__chatOrchCleanup();
    } catch {}
  }

  const host = location.hostname;
  const site = /(^|\.)claude\.ai$/.test(host)
    ? 'claude'
    : /(^|\.)gemini\.google\.com$/.test(host)
    ? 'gemini'
    : /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(host)
    ? 'chatgpt'
    : null;
  if (!site) return;

  const CONFIGS = {
    chatgpt: {
      input: ['#prompt-textarea', 'div[contenteditable="true"][data-virtualkeyboard]', 'textarea'],
      send: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]'],
      stop: ['button[data-testid="stop-button"]', 'button[aria-label="Stop streaming"]', 'button[aria-label*="stop" i]'],
      assistant: [
        '[data-message-author-role="assistant"]',
        'article[data-turn="assistant"]',
        '[data-testid^="conversation-turn-"] .markdown',
      ],
      user: ['[data-message-author-role="user"]', 'article[data-turn="user"]'],
      streamingAttr: null,
    },
    claude: {
      input: [
        'div[contenteditable="true"].ProseMirror',
        'div[contenteditable="true"][role="textbox"]',
        'fieldset div[contenteditable="true"]',
      ],
      send: ['button[aria-label="Send message"]', 'button[aria-label="Send Message"]'],
      stop: ['button[aria-label="Stop response"]', 'button[aria-label="Stop Response"]', 'button[aria-label*="stop" i]'],
      assistant: ['div[data-is-streaming]', '.font-claude-response', '.font-claude-message'],
      user: ['[data-testid="user-message"]'],
      streamingAttr: '[data-is-streaming="true"]',
    },
    gemini: {
      input: ['div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]'],
      send: ['button[aria-label="Send message"]'],
      stop: ['button[aria-label*="stop" i]'],
      assistant: ['message-content .markdown'],
      user: ['user-query .query-text'],
      streamingAttr: null,
    },
  };
  const A = CONFIGS[site];

  // Generic fallbacks tried after the site-specific send selectors.
  const SEND_FALLBACKS = ['form button[type="submit"]', 'button[aria-label*="send" i]', 'button[data-testid*="send" i]'];

  // Lines of page chrome that must never be treated as part of a reply.
  const NOISE =
    /^(ChatGPT can make mistakes|Claude can make mistakes|Claude is AI and can make mistakes|Message ChatGPT|Ask anything|Reply to Claude|Check important info|See Cookie Preferences)/i;

  // ------------------------------------------------------------- helpers
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const visible = (el) =>
    !!el && (el.offsetParent !== null || el.getClientRects().length > 0);

  function q(selectors) {
    for (const sel of selectors) {
      const el = [...document.querySelectorAll(sel)].find(visible);
      if (el) return el;
    }
    return null;
  }

  // Document-ordered matches for a selector group, with nested duplicates removed.
  function all(selectors) {
    const nodes = [...document.querySelectorAll(selectors.join(','))];
    return nodes.filter((n, i) => !nodes.some((o, j) => j !== i && o !== n && o.contains(n)));
  }

  async function waitFor(fn, timeoutMs, interval = 200) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  const assistantNodes = () => all(A.assistant);
  const userNodes = () => all(A.user);
  const isGenerating = () =>
    !!q(A.stop) || (A.streamingAttr ? !!document.querySelector(A.streamingAttr) : false);

  const composerText = (el) => ((el && (el.value !== undefined ? el.value : el.textContent)) || '').trim();
  const buttonEnabled = (b) => !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
  const findSendButton = () => q([...A.send, ...SEND_FALLBACKS]);

  function lastAssistantText() {
    const nodes = assistantNodes();
    const last = nodes[nodes.length - 1];
    return last ? last.innerText.trim() : '';
  }

  // Selector-free fallback: take everything on the page that appears AFTER the
  // last line of the prompt we sent, minus known page chrome.
  function fallbackReply(promptText) {
    const root = document.querySelector('main') || document.body;
    const pageText = root.innerText || '';
    const lastLine = (promptText.trim().split('\n').pop() || '').trim().slice(-60);
    if (!lastLine) return '';
    const idx = pageText.lastIndexOf(lastLine);
    if (idx < 0) return '';
    return pageText
      .slice(idx + lastLine.length)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !NOISE.test(l))
      .join('\n')
      .trim();
  }

  // ------------------------------------------------------------- input
  function setInputText(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
      Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    // contenteditable (ProseMirror): select all, clear, then insert.
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete');

    // execCommand fires real beforeinput/input events, so the editor and the
    // page's own state (which enables the send button) both see the change.
    // Newlines are inserted as soft line breaks (Shift+Enter semantics), never as
    // Enter, so multi-line prompts cannot trigger an early submit.
    text
      .replace(/\r/g, '')
      .split('\n')
      .forEach((line, i) => {
        if (i > 0) document.execCommand('insertLineBreak');
        if (line) document.execCommand('insertText', false, line);
      });

    if (!composerText(el)) {
      // Fallback: synthetic paste event.
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }
    if (!composerText(el)) throw new Error('Could not type into the chat input');
  }

  function pressEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // Types the prompt and makes sure it was actually submitted.
  async function sendPrompt(text) {
    const input = await waitFor(() => q(A.input), 20000);
    if (!input) throw new Error('Chat input not found (not logged in, or selectors changed)');

    const userBefore = userNodes().length;
    setInputText(input, text);
    await sleep(600);

    const submitted = () => isGenerating() || userNodes().length > userBefore || composerText(q(A.input)) === '';
    const notes = [];

    const attempts = [
      async () => {
        const btn = await waitFor(() => {
          const b = findSendButton();
          return buttonEnabled(b) ? b : null;
        }, 6000);
        if (!btn) return 'no enabled send button found';
        btn.click();
      },
      async () => {
        const form = (q(A.input) || input).closest('form');
        if (!form) return 'no <form> around the input';
        form.requestSubmit();
      },
      async () => pressEnter(q(A.input) || input),
    ];

    for (const attempt of attempts) {
      const note = await attempt();
      if (note) notes.push(note);
      if (await waitFor(submitted, 4000, 250)) return;
    }
    throw new Error(
      `Typed the message but could not submit it (${notes.join('; ') || 'UI did not react'}). ` +
        'Run "Diagnose this tab" on the worker tab and check the send selectors in content.js.'
    );
  }

  // ------------------------------------------------------------- waiting
  // Prefers the DOM selectors; if they find no new assistant message, falls back
  // to reading the page text after the prompt (needs a longer quiet period because
  // there is no reliable "finished" signal in that mode).
  async function waitForResponse(baselineCount, timeoutMs, promptText) {
    const t0 = Date.now();
    let started = false;
    let lastText = '';
    let stableSince = Date.now();

    const read = () => {
      if (assistantNodes().length > baselineCount) return { mode: 'dom', text: lastAssistantText() };
      return { mode: 'fallback', text: fallbackReply(promptText) };
    };

    while (Date.now() - t0 < timeoutMs) {
      const generating = isGenerating();
      const r = read();
      const hasReply = r.mode === 'dom' || !!r.text;
      if (!started && (generating || hasReply)) started = true;
      if (!started && Date.now() - t0 > 60000) {
        throw new Error(
          'Message was submitted but no reply appeared within 60s (rate limit, login wall, or the page ' +
            'text could not be read). Run "Diagnose this tab" on the worker.'
        );
      }
      if (started) {
        if (r.text !== lastText) {
          lastText = r.text;
          stableSince = Date.now();
        }
        const quietNeeded = r.mode === 'dom' ? 3000 : 5000;
        if (!generating && r.text && Date.now() - stableSince > quietNeeded) return r.text;
      }
      await sleep(500);
    }
    throw new Error('Timed out waiting for the response to finish');
  }

  // ------------------------------------------------------------- reading
  function readChat(lastN) {
    let msgs;
    if (site === 'chatgpt') {
      const roleOf = (n) => (
        n.getAttribute('data-message-role') ||
        n.getAttribute('data-message-author-role') ||
        n.getAttribute('data-turn') || ''
      ).trim().toLowerCase();
      const hasNonChatRoleAncestor = (n) => {
        for (let p = n.parentNode; p; p = p.parentNode) {
          if (typeof p.getAttribute !== 'function') continue;
          if (['data-message-role', 'data-message-author-role', 'data-turn']
            .some((attr) => p.getAttribute(attr) !== null) &&
            roleOf(p) !== 'user' && roleOf(p) !== 'assistant') return true;
        }
        return false;
      };
      const fallbackSel = '[data-testid^="conversation-turn-"] .markdown';
      const matches = [...document.querySelectorAll(
        `li[data-message-role], [data-message-author-role], article[data-turn], ${fallbackSel}`
      )];
      const explicit = matches.filter((n) =>
        (roleOf(n) === 'user' || roleOf(n) === 'assistant') && !hasNonChatRoleAncestor(n));
      const candidates = matches.filter((n) => explicit.includes(n) ||
        (n.matches(fallbackSel) && !roleOf(n) && !hasNonChatRoleAncestor(n) &&
          !explicit.some((o) => o.contains(n))));
      // An explicit li turn owns its role, even inside a legacy role wrapper.
      const turns = candidates.filter((n) =>
        !candidates.some((child) => child !== n && n.contains(child) && child.matches('li[data-message-role]'))
      );
      // Ignore broad wrappers enclosing multiple distinct message leaves.
      const leaves = turns.filter((n) =>
        !turns.some((other) => other !== n && n.contains(other))
      );
      const singleTurns = turns.filter((n) =>
        leaves.filter((leaf) => n.contains(leaf)).length === 1
      );
      const nodes = singleTurns.filter((n) =>
        !singleTurns.some((other) => other !== n && other.contains(n))
      );
      // Role-free legacy turns can contain several sibling Markdown blocks.
      // Keep them as one logical assistant message before applying lastN.
      const fallbackGroups = new Map();
      msgs = [];
      for (const n of nodes) {
        const body = n.querySelector('[data-user-message-copy]') ||
          n.querySelector('[data-assistant-markdown]') || n;
        const text = (body.textContent || '').trim();
        if (!text) continue;
        if (!roleOf(n) && n.matches(fallbackSel)) {
          let turn = n.parentNode;
          while (turn && (typeof turn.matches !== 'function' ||
            !turn.matches('[data-testid^="conversation-turn-"]'))) turn = turn.parentNode;
          if (turn) {
            const group = fallbackGroups.get(turn);
            if (group) group.text += `\n${text}`;
            else {
              const message = { role: 'assistant', text };
              fallbackGroups.set(turn, message);
              msgs.push(message);
            }
            continue;
          }
        }
        msgs.push({ role: roleOf(n) || 'assistant', text });
      }
    } else {
      const userSel = A.user.join(',');
      const nodes = all([...A.user, ...A.assistant]);
      msgs = nodes.map((n) => ({
        role: n.matches(userSel) ? 'user' : 'assistant',
        text: n.innerText.trim(),
      }));
    }
    if (lastN) msgs = msgs.slice(-lastN);
    const transcript = msgs
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
      .join('\n\n');
    return { site, title: document.title, message_count: msgs.length, transcript };
  }

  function diagnose() {
    const count = (list) => list.map((s) => `${s} -> ${document.querySelectorAll(s).length}`);
    const input = q(A.input);
    const btn = findSendButton();
    const main = document.querySelector('main');
    return {
      site,
      url: location.href,
      input: count(A.input),
      send: count([...A.send, ...SEND_FALLBACKS]),
      stop: count(A.stop),
      assistant: count(A.assistant),
      user: count(A.user),
      composer: input
        ? { tag: input.tagName, textLength: composerText(input).length, insideForm: !!input.closest('form') }
        : null,
      sendButton: btn
        ? {
            enabled: buttonEnabled(btn),
            ariaLabel: btn.getAttribute('aria-label'),
            testId: btn.getAttribute('data-testid'),
          }
        : null,
      generating: isGenerating(),
      assistantMessages: assistantNodes().length,
      userMessages: userNodes().length,
      hints: {
        authorRoles: [...document.querySelectorAll('[data-message-author-role]')].map((e) =>
          e.getAttribute('data-message-author-role')
        ),
        lastArticles: [...document.querySelectorAll('article')].slice(-4).map((a) => ({
          testid: a.getAttribute('data-testid'),
          turn: a.getAttribute('data-turn'),
        })),
        markdownBlocks: document.querySelectorAll('.markdown').length,
        streamingAttrs: document.querySelectorAll('[data-is-streaming]').length,
        buttons: [...document.querySelectorAll('form button, main button')]
          .slice(-12)
          .map((b) => b.getAttribute('data-testid') || b.getAttribute('aria-label') || b.textContent.trim().slice(0, 20)),
        mainTextTail: ((main && main.innerText) || '').slice(-300),
      },
    };
  }

  // ------------------------------------------------------------- run loop
  let busy = false;

  async function runPrompt({ taskId, text, timeoutMs }) {
    busy = true;
    try {
      const baseline = assistantNodes().length;
      await sendPrompt(text);
      const result = await waitForResponse(baseline, timeoutMs || 600000, text);
      chrome.runtime.sendMessage({ type: 'task_done', taskId, ok: true, text: result });
    } catch (err) {
      chrome.runtime.sendMessage({
        type: 'task_done',
        taskId,
        ok: false,
        error: String(err?.message || err),
      });
    } finally {
      busy = false;
    }
  }

  function onMessage(msg, _sender, sendResponse) {
    switch (msg?.cmd) {
      case 'ping':
        sendResponse({ ok: true, site, ready: !!q(A.input), busy });
        break;
      case 'run_prompt':
        if (busy) {
          sendResponse({ ok: false, error: 'This tab is still working on a previous task' });
        } else {
          runPrompt(msg);
          sendResponse({ ok: true });
        }
        break;
      case 'read_chat':
        if (typeof self !== 'undefined' && self.__chatOrchStructuredReader) {
          let readTimer;
          const apiRead = self.__chatOrchStructuredReader.readChat(site, msg.lastN, {
            includeReasoning: msg.includeReasoning === true,
            includeAttachments: msg.includeAttachments !== false,
          });
          Promise.race([
            apiRead,
            new Promise((_, reject) => {
              readTimer = setTimeout(() => reject(new Error('API read timeout')), 30000);
            }),
          ]).then((result) => {
            sendResponse({ ok: true, ...result });
          }).catch(() => {
            // Do not reflect raw API exceptions: paths, query parameters and
            // token-bearing request details may be present in their messages.
            try {
              const fallback = readChat(msg.lastN);
              if (fallback.message_count > 0) {
                sendResponse({ ok: true, ...fallback, source: 'dom_fallback' });
                return;
              }
            } catch { /* preserve fail-closed behavior */ }
            sendResponse({
              ok: false, site, message_count: 0, transcript: '',
              error_code: 'EXTRACTION_UNAVAILABLE',
              error: 'Structured conversation read failed and no DOM messages were found. Refresh the conversation tab.',
            });
          }).finally(() => clearTimeout(readTimer));
          return true; // async chrome.runtime message channel
        }
        sendResponse({ ok: true, ...readChat(msg.lastN) });
        break;
      case 'diagnose':
        sendResponse({ ok: true, ...diagnose() });
        break;
      default:
        return false;
    }
    return false;
  }
  chrome.runtime.onMessage.addListener(onMessage);
  window.__chatOrchCleanup = () => {
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {}
  };
})();
