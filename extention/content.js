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
      user: ['[data-message-author-role="user"]', 'article[data-turn="user"]', 'li[data-message-role="user"]'],
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
  // Do not wait for fetch/XHR idle: the provider can keep heartbeats open.
  const pageReadyForSubmission = () => document.readyState === 'complete';
  async function awaitBrowserPageSettled(timeoutMs = 12000) {
    const response = await chrome.runtime.sendMessage({
      type:'browser_page_settled',timeoutMs,
    });
    if (response?.ok !== true || response.ready !== true) {
      throw new Error(response?.error || 'Browser page has not settled after load');
    }
  }

  const verifiedAssistantNodes = () => site === 'chatgpt'
    ? all(['[data-message-author-role="assistant"]', 'article[data-turn="assistant"]',
        'li[data-message-role="assistant"]']) : assistantNodes();
  const assistantNodes = () => all(A.assistant);
  const userNodes = () => all(A.user);
  const isGenerating = () =>
    !!q(A.stop) || (A.streamingAttr ? !!document.querySelector(A.streamingAttr) : false);

  const normalizePrompt = (text) => String(text ?? '').replace(/\r\n?/g,'\n').replace(/\u00a0/g,' ').trim();
  const composerText = (el) => !el ? '' : normalizePrompt(
    el.value !== undefined ? el.value : el.innerText ?? el.textContent);
  const matchingUserTurn = (text) => {
    const expected = normalizePrompt(text);
    return !!expected && userNodes().some((node) =>
      normalizePrompt(node.innerText ?? node.textContent) === expected);
  };
  const buttonEnabled = (b) => !!b && !b.disabled &&
    b.getAttribute('aria-disabled') !== 'true' &&
    b.getAttribute('data-disabled') !== 'true' &&
    !b.closest('[inert]');

  // The primary composer action has precedence over generic Send-labelled
  // buttons elsewhere (e.g. share dialogs, popovers, or hidden composers).
  // Never select a generic page button if the composer's own action is disabled.
  function findSendButton(composer = q(A.input)) {
    const selectors = [
      ...A.send,
      'button[data-testid="composer-submit-button"]',
      'button[aria-label="Send message"]',
      ...SEND_FALLBACKS,
    ];
    const scope = composer?.closest('form') ||
      composer?.closest('[data-testid="composer"]') ||
      composer?.closest('[class*="composer"]');
    function select(root) {
      if (!root) return {found:false,button:null};
      let matched = false;
      for (const selector of selectors) {
        const buttons = [...root.querySelectorAll(selector)].filter(visible);
        if (!buttons.length) continue;
        matched = true;
        const enabled = buttons.filter(buttonEnabled);
        if (enabled.length === 1) return {found:true,button:enabled[0]};
        if (enabled.length > 1) return {found:true,button:null};
        // Continue to the next selector *within the same composer*.
        // A stale disabled primary button must not prevent selecting the
        // enabled alternate submit control in the active form.
      }
      return {found:matched,button:null};
    }
    const scoped = select(scope);
    if (scoped.found) return scoped.button;
    return select(document).button;
  }

  function lastAssistantText() {
    const nodes = assistantNodes();
    const last = nodes[nodes.length - 1];
    return last ? last.innerText.trim() : '';
  }

  function chatgptAccountChanged() {
    return site === 'chatgpt' &&
      /Your account changed\.\s*Send your message again/i.test(
        String(document.body?.innerText || ''));
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
      // Setting .value and dispatching an untrusted synthetic input event can
      // leave the SPA's controlled composer unchanged. Native editing produces
      // a browser-dispatched input event and updates its internal state.
      el.select();
      const normalized = text.replace(/\r/g, '');
      const deleted = document.execCommand('delete');
      const inserted = document.execCommand('insertText', false, normalized);
      if (!deleted || !inserted || composerText(el) !== normalized.trim()) {
        throw new Error('Native textarea editing did not synchronize the composer; no prompt was submitted');
      }
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

  // Use the provider's enabled DOM Send button, as in the original extension.
  // Perform only one click; if delivery cannot be confirmed, do not retry.
  async function sendPrompt(text) {
    let submitAttempted = false;
    let insertedByUs = false;
    try {
      const ready = await waitFor(() => pageReadyForSubmission() && q(A.input), 45000, 250);
      if (!ready) throw new Error('Chat page document or composer is not ready');
      await awaitBrowserPageSettled(45000);
    if (chatgptAccountChanged()) {
      throw new Error('ChatGPT session changed before submission; refresh and verify login');
    }
    const input = ready;
    const expected = normalizePrompt(text);
    const previousDraft = composerText(input);
    if (matchingUserTurn(expected)) {
      const error = new Error('Matching user turn already exists; inspect task before any repeat submission');
      error.code = 'SUBMISSION_UNCERTAIN';
      throw error;
    }
    if (previousDraft && previousDraft !== expected) {
      const error = new Error('Composer contains a different draft; refusing to overwrite or submit it');
      error.code = 'SUBMISSION_NOT_ATTEMPTED';
      throw error;
    }
    const userBefore = userNodes().length;
    if (!previousDraft) {
      insertedByUs = true;
      setInputText(input, text);
    }
    await sleep(250);
    const button = await waitFor(() => {
      if (!pageReadyForSubmission() || chatgptAccountChanged()) return null;
      return findSendButton(input);
    }, 6500, 200);
    if (!button) {
      const inspected = [...document.querySelectorAll([...A.send, ...SEND_FALLBACKS,
        'button[data-testid="composer-submit-button"]'].join(','))]
        .filter(visible).map((b) => ({
          testId:b.getAttribute('data-testid'), enabled:buttonEnabled(b),
          label:b.getAttribute('aria-label') })).slice(0, 8);
      throw new Error('No unambiguous enabled submit control for the active composer; ' +
        'document=' + document.readyState + ', composer=' + input.tagName +
        ', chars=' + composerText(input).length + ', buttons=' + JSON.stringify(inspected));
    }
    if (!pageReadyForSubmission() || chatgptAccountChanged()) {
      throw new Error('Chat page changed readiness before submission; no message sent');
    }
    // No second network-idle gate after inserting the prompt: the page may
    // legitimately start background requests while the enabled Send control
    // is ready. Requiring every such request to finish strands an unsent draft.
    if (!button.isConnected && typeof button.isConnected === 'boolean') {
      throw new Error('Composer submit control disappeared before click; no prompt sent');
    }
    if (!buttonEnabled(button) || composerText(input) !== expected) {
      throw new Error('Composer changed or Send became disabled before click; no prompt sent');
    }
    submitAttempted = true;
    button.click();
    const confirmed = await waitFor(() =>
      userNodes().length > userBefore || isGenerating() || chatgptAccountChanged(), 12000, 200);
    if (chatgptAccountChanged() || !confirmed) {
      const error = new Error(chatgptAccountChanged()
        ? 'ChatGPT account changed during submission; delivery outcome requires reconciliation'
        : 'Prompt submission outcome uncertain: no new user turn or generation detected');
      error.code = 'SUBMISSION_UNCERTAIN';
      throw error;
    }
    } catch (error) {
      if (error.code === 'SUBMISSION_NOT_ATTEMPTED') submitAttempted = false;
      if (!submitAttempted) {
        // Preserve pre-existing task drafts; clear only text we just inserted.
        const composer = q(A.input);
        if (insertedByUs && composer && composerText(composer) === normalizePrompt(text)) {
          composer.focus();
          if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
            composer.select();
          } else {
            const selection=window.getSelection(),range=document.createRange();
            range.selectNodeContents(composer);
            selection.removeAllRanges();selection.addRange(range);
          }
          document.execCommand('delete');
        }
        if (!error.code) error.code = 'SUBMISSION_NOT_ATTEMPTED';
        if (composer && composerText(composer)) {
          error.message += '; unsent draft remains and must be reconciled before reuse';
        }
      } else {
        error.code = 'SUBMISSION_UNCERTAIN';
      }
      throw error;
    }
  }

  // ------------------------------------------------------------- waiting
  // Prefers the DOM selectors; if they find no new assistant message, falls back
  // to reading the page text after the prompt (needs a longer quiet period because
  // there is no reliable "finished" signal in that mode).
  // A completed worker result must belong to an actual assistant turn.
  // ChatGPT page-wide text includes transient UI errors and must never be
  // promoted to a successful assistant answer.
  async function waitForResponse(baselineCount, timeoutMs, promptText) {
    const t0 = Date.now();
    let started = false;
    let lastText = '';
    let stableSince = Date.now();
    const read = () => {
      if (site === 'chatgpt') {
        const nodes = verifiedAssistantNodes();
        if (nodes.length <= baselineCount) return {mode:'none',text:''};
        const last = nodes[nodes.length - 1];
        return {mode:'dom',text:String(last?.innerText || last?.textContent || '').trim()};
      }
      if (assistantNodes().length > baselineCount) {
        return {mode:'dom',text:lastAssistantText()};
      }
      return {mode:'fallback',text:fallbackReply(promptText)};
    };

    while (Date.now() - t0 < timeoutMs) {
      if (chatgptAccountChanged()) {
        const error = new Error('ChatGPT account changed after prompt submission; response is unverified');
        error.code = 'SUBMISSION_UNCERTAIN';
        throw error;
      }
      const generating = isGenerating();
      const result = read();
      if (!started && (generating || result.text)) started = true;
      if (!started && Date.now() - t0 > 60000) {
        throw new Error('Message submitted but no verified assistant response appeared within 60s');
      }
      if (started) {
        if (result.text !== lastText) {
          lastText = result.text;
          stableSince = Date.now();
        }
        const quietNeeded = result.mode === 'dom' ? 3000 : 5000;
        if (!generating && result.text && Date.now() - stableSince > quietNeeded) return result.text;
      }
      await sleep(500);
    }
    throw new Error('Timed out waiting for a verified assistant response');
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
      submissionTransport:'dom-button-click-v1',
      taskDraftPolicy:'exact-match-only',
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
      pageReady: pageReadyForSubmission(),
      documentReady: document.readyState === 'complete',
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
  let completionReceiptUncertain = false;
  function observeState(expectedText = null) {
    const input = q(A.input);
    const generating = isGenerating();
    const draft = composerText(input);
    const matchesDraft = !!draft && typeof expectedText === 'string' &&
      draft === normalizePrompt(expectedText);
    const alreadySubmitted = matchesDraft && matchingUserTurn(expectedText);
    const state = completionReceiptUncertain ? 'uncertain'
      : chatgptAccountChanged() ? 'uncertain'
      : !pageReadyForSubmission() ? 'loading'
      : !input ? 'unknown' : busy || generating ? 'busy' : draft ? 'draft' : 'idle';
    const ready = state === 'idle' || (state === 'draft' && matchesDraft && !alreadySubmitted);
    return {site,state,busy:state==='busy',ready,matchingDraft:matchesDraft,
      matchingUserTurn:alreadySubmitted,draftLength:draft.length,
      documentReady:document.readyState==='complete'};
  }

  // Retry only the same completion receipt, NEVER the external chat submission.
  // The background listener treats an identical terminal receipt as idempotent.
  async function reportTaskCompletion(report) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await chrome.runtime.sendMessage(report);
        if (response?.ok === true) return;
        if (response?.error === 'Unverified worker completion source') break;
      } catch { /* service worker may be restarting */ }
      if (attempt < 2) await sleep(600 * (attempt + 1));
    }
    throw new Error('Worker completion transport acknowledgment is uncertain');
  }

  async function runPrompt({ taskId, receiptNonce, text, timeoutMs }, onSubmission) {
    busy = true;
    let report;
    let submissionReported = false;
    const reportSubmission = (outcome) => {
      if (submissionReported) return;
      submissionReported = true;
      onSubmission(outcome);
    };
    try {
      const baseline = site === 'chatgpt' ? verifiedAssistantNodes().length : assistantNodes().length;
      await sendPrompt(text);
      // This ACK confirms the new user turn, not the assistant's answer.
      // Releasing the startup slot here lets other workers initialize and
      // submit while this worker's model response continues independently.
      reportSubmission({ ok: true, submitted: true });
      const result = await waitForResponse(baseline, timeoutMs || 600000, text);
      report = { type: 'task_done', taskId, receiptNonce, ok: true, text: result };
    } catch (err) {
      const uncertain = err?.code === 'SUBMISSION_UNCERTAIN';
      report = {
        type: 'task_done', taskId, receiptNonce, ok: false,
        uncertain,
        notSubmitted: err?.code === 'SUBMISSION_NOT_ATTEMPTED',
        error: String(err?.message || err),
      };
      if (!submissionReported) {
        reportSubmission({ok:false,uncertain,notSubmitted:report.notSubmitted,
          error:report.error});
      }
      if (report.uncertain) completionReceiptUncertain = true;
    }
    try {
      await reportTaskCompletion(report);
    } catch {
      // Receipt loss is a distinct uncertainty: never replay a submitted chat.
      completionReceiptUncertain = true;
    } finally {
      busy = false;
    }
  }

  // Manager wake: transport submission only. Never treat it as consumer
  // processing or Saga acknowledgment; a timeout might have submitted.
  async function submitManagerBatch(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 60000 ||
        observeState().state !== 'idle') {
      return { ok: false, uncertain: false, error: 'Manager tab is not idle or batch is invalid' };
    }
    // Clearing the composer is not proof that the chat accepted a queue batch.
    // Require this batch's unique ID in a user-message bubble; otherwise UNCERTAIN.
    const batchMarker = /"batch_id":"([0-9a-f-]{36})"/i.exec(text)?.[1];
    if (!batchMarker) return { ok: false, uncertain: false, error: 'Manager batch ID missing' };
    const markerVisible = () => {
      if (userNodes().some((node) =>
        String(node.innerText || node.textContent || '').includes(batchMarker))) return true;
      // UI variants may not expose a user-role selector. A visible chat marker
      // counts only after it has left the active composer.
      const inPage = String(document.body?.innerText || '').includes(batchMarker);
      const stillDraft = composerText(q(A.input)).includes(batchMarker);
      return inPage && !stillDraft;
    };
    if (markerVisible()) {
      completionReceiptUncertain = true;
      return { ok: false, uncertain: true, error: 'Batch is already visible; reconcile before retry' };
    }
    busy = true;
    try {
      await sendPrompt(text);
      if (!(await waitFor(markerVisible, 12000, 250))) {
        throw new Error('Manager batch not visible after UI submission');
      }
      return { ok: true, submitted: true };
    } catch {
      completionReceiptUncertain = true;
      return { ok: false, uncertain: true, error: 'Manager submission outcome requires reconciliation' };
    } finally {
      busy = false;
    }
  }

  function onMessage(msg, _sender, sendResponse) {
    switch (msg?.cmd) {
      case 'ping':
        sendResponse({ok:true,...observeState(msg.expectedText)});
        break;
      case 'observe_state':
        sendResponse({ok:true,...observeState(msg.expectedText)});
        break;
      case 'run_prompt': {
        const observed = observeState(msg.text);
        if (!observed.ready) {
          sendResponse({ ok: false, error: `Tab is not safely idle (${observed.state})` });
        } else {
          void runPrompt(msg, sendResponse);
        }
        return true; // submission receipt is asynchronous; model reply arrives separately
      }
      case 'submit_manager_batch': {
        submitManagerBatch(msg.text).then(sendResponse).catch(() => {
          sendResponse({ ok: false, uncertain: true, error: 'Manager submission failed' });
        });
        return true;
      }
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
