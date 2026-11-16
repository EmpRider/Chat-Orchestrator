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
        '[data-response-body]',
        '[data-message-author-role="assistant"]',
        'article[data-turn="assistant"]',
        '[data-testid^="conversation-turn-"] .markdown',
      ],
      user: ['[data-user-message-bubble="true"]',
        '[data-message-author-role="user"]', 'article[data-turn="user"]',
        'li[data-message-role="user"]'],
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
  const CONTENT_BUILD='worker-submit-modern-turns-20261116-v5';
  // These milestones remain readable even when the full low-level trace is
  // noisy. Detailed steps are still available in the Console at Debug level.
  const TRACE_MILESTONES=new Set(['submission_begin','page_settled','draft_insert_done',
    'composer_state_transition','composer_projection_snapshot',
    'send_button_wait_end','pre_click_composer_validation_rejected',
    'pre_click_button_rejected','send_activation','send_click_begin',
    'send_click_returned','submission_confirmation_end','submission_failure_summary',
    'submission_confirmation_evidence',
    'parent_setup_submission_uncertain','parent_setup_user_turn_reconciled',
    'parent_setup_linebreak_normalization_accepted']);
  let traceSequence=0;
  let activeTraceId=null;
  const logStep = (taskId, step, data = {}) => {
    // Only send the deliberately redacted diagnostics built below. Never send
    // text, prompts, URLs, DOM HTML, arbitrary exception messages or transcripts.
    const event = {site,taskId,step,at:Date.now(),traceId:activeTraceId,...data};
    if(TRACE_MILESTONES.has(step) || step==='error')
      console[step==='error'?'warn':'info']('[chat-orch:trace]',JSON.stringify(event));
    else console.debug?.('[chat-orch:detail]',event);
    try {
      void chrome.runtime.sendMessage({type:'worker_diagnostic',diagnostic:event})
        ?.catch?.(()=>{});
    } catch {}
  };

  function firstDifference(actual,expected) {
    let i=0;while(i<actual.length&&i<expected.length&&actual[i]===expected[i])i++;
    const actualChar=i<actual.length?actual[i]:'';
    const expectedChar=i<expected.length?expected[i]:'';
    return {index:i,actualCodePoint:actualChar?actual.codePointAt(i):null,
      expectedCodePoint:expectedChar?expected.codePointAt(i):null,
      actualClass:!actualChar?'end':/\s/.test(actualChar)?'whitespace':'text',
      expectedClass:!expectedChar?'end':/\s/.test(expectedChar)?'whitespace':'text',
      actualLength:actual.length,expectedLength:expected.length};
  }
  function whitespaceDiagnostics(actual,expected) {
    const collapse=(value)=>normalizePrompt(value).replace(/\s+/g,' ').trim();
    const actualCollapsed=collapse(actual),expectedCollapsed=collapse(expected);
    return {actualCollapsedLength:actualCollapsed.length,
      expectedCollapsedLength:expectedCollapsed.length,
      collapsedEqual:actualCollapsed===expectedCollapsed,
      collapsedFirstDifference:actualCollapsed===expectedCollapsed?null:
        firstDifference(actualCollapsed,expectedCollapsed)};
  }
  // ChatGPT's contenteditable can replace inserted line breaks with spaces
  // during React's input reaction (for BOTH Parent and Child prompts).
  // Accept ONLY the exact LF -> ASCII-space transformation of a draft that
  // this extension just inserted. Arbitrary whitespace or text drift fails.
  function parentSetupDraftMatches(el,expected,insertedByUs,taskId) {
    const actual=composerText(el);
    if(actual===expected)return true;
    return site==='chatgpt' && insertedByUs &&
      el?.tagName==='DIV' && expected.includes('\n') &&
      actual===expected.replace(/\n/g,' ');
  }

  function textShape(value) {
    const normalized=normalizePrompt(value);
    const lines=normalized.split('\n');
    return {length:normalized.length,lineCount:lines.length,
      lines:lines.map((line,index)=>({index,length:line.length,
        kind:/^<\/?system_instructions>/.test(line)?'system_boundary':
          /^<\/?task>/.test(line)?'task_boundary':
          /^<orchestrator_context/.test(line)?'context_boundary':
          /^<[^>]+>/.test(line)?'tag':'text'}))};
  }
  function promptSectionDiagnostics(actual,expected) {
    const sections=[['system','<system_instructions>','</system_instructions>'],
      ['task','<task>','</task>'],
      ['context','<orchestrator_context untrusted="true">','</orchestrator_context>']];
    return sections.map(([name,open,close])=>{
      const extract=(value)=>{
        const start=value.indexOf(open);
        if(start<0)return null;
        const bodyStart=start+open.length;
        const end=value.indexOf(close,bodyStart);
        return end<0?null:value.slice(bodyStart,end);
      };
      const a=extract(actual),e=extract(expected);
      if(a===null&&e===null)return {name,present:false};
      if(a===null||e===null)return {name,presentActual:a!==null,presentExpected:e!==null};
      const whitespace=whitespaceDiagnostics(a,e);
      return {name,present:true,actualLength:a.length,expectedLength:e.length,
        collapsedEqual:whitespace.collapsedEqual,
        collapsedFirstDifference:whitespace.collapsedFirstDifference};
    });
  }

  function composerDiagnostics(expectedText,taskId=null) {
    const candidates=[];
    logStep(taskId,'composer_diagnostics_begin',{selectorCount:A.input.length,
      expectedLength:typeof expectedText==='string'?normalizePrompt(expectedText).length:null,
      readyState:document.readyState});
    for (const selector of A.input) {
      let nodes=[];
      try {
        nodes=[...document.querySelectorAll(selector)];
        logStep(taskId,'composer_selector_scanned',{selector,count:nodes.length});
      } catch(error) {
        logStep(taskId,'composer_selector_error',{selector,errorType:error?.name || 'Error'});
      }
      for (const [index,el] of nodes.slice(0,8).entries()) {
        try {
          const form=el.closest('form');
          const text=composerText(el);
          const expected=typeof expectedText==='string' ? normalizePrompt(expectedText) : null;
          const candidate={selector,index,visible:visible(el),tag:el.tagName,
            role:el.getAttribute?.('role') || null,
            contentEditable:el.getAttribute?.('contenteditable') || null,
            testId:el.getAttribute?.('data-testid') || null,
            ariaLabel:el.getAttribute?.('aria-label') || null,
            active:document.activeElement===el,textLength:text.length,
            expectedLength:expected?.length ?? null,
            exactMatch:expected===null ? null : text===expected,
            whitespaceMatch:expected===null ? null : whitespaceDiagnostics(text,expected).collapsedEqual,
            whitespace:expected===null ? null : whitespaceDiagnostics(text,expected),
            actualShape:textShape(text),
            expectedShape:expected===null ? null : textShape(expected),
            firstDifference:expected===null ? null : firstDifference(text,expected),
            sectionDifferences:expected===null ? null : promptSectionDiagnostics(text,expected),
            newlineCount:(text.match(/\n/g)||[]).length,
            formTestId:form?.getAttribute?.('data-testid') || null};
          candidates.push(candidate);
          logStep(taskId,'composer_candidate_inspected',{selector,index,visible:candidate.visible,
            tag:candidate.tag,role:candidate.role,active:candidate.active,textLength:candidate.textLength,
            expectedLength:candidate.expectedLength,exactMatch:candidate.exactMatch,
            whitespaceMatch:candidate.whitespaceMatch,firstDifference:candidate.firstDifference,
            actualShape:candidate.actualShape,expectedShape:candidate.expectedShape,
            sectionDifferences:candidate.sectionDifferences});
        } catch(error) {
          logStep(taskId,'composer_candidate_error',{selector,index,errorType:error?.name || 'Error'});
        }
      }
    }
    const selected=q(A.input);
    const result={documentReady:document.readyState,activeTag:document.activeElement?.tagName || null,
      activeRole:document.activeElement?.getAttribute?.('role') || null,
      inputCounts:A.input.map((selector)=>({selector,count:document.querySelectorAll(selector).length,
        visible:[...document.querySelectorAll(selector)].filter(visible).length})),
      selectedIndex:candidates.findIndex((item)=>item.visible),candidates};
    logStep(taskId,'composer_diagnostics_end',{selectedIndex:result.selectedIndex,
      candidateCount:candidates.length,documentReady:result.documentReady});
    return result;
  }

  function sendButtonDiagnostics(composer) {
    const selectors=[...A.send,'button[data-testid="composer-submit-button"]','button[aria-label="Send message"]',...SEND_FALLBACKS];
    const scope=composer?.closest('form') || composer?.closest('[data-testid="composer"]') ||
      composer?.closest('[class*="composer"]');
    const buttons=[];
    for (const selector of [...new Set(selectors)]) {
      let nodes=[];
      try { nodes=[...document.querySelectorAll(selector)]; } catch {}
      for (const button of nodes.slice(0,8)) buttons.push({selector,visible:visible(button),
        enabled:buttonEnabled(button),disabled:Boolean(button.disabled),
        ariaDisabled:button.getAttribute('aria-disabled'),testId:button.getAttribute('data-testid'),
        ariaLabel:button.getAttribute('aria-label'),inComposer:Boolean(scope?.contains?.(button)),
        connected:button.isConnected});
    }
    return {scopeTag:scope?.tagName || null,scopeTestId:scope?.getAttribute?.('data-testid') || null,buttons};
  }

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
  async function awaitBrowserPageSettled(timeoutMs = 12000,taskId=null) {
    const startedAt=Date.now();
    logStep(taskId,'page_settle_request_begin',{timeoutMs,documentReady:document.readyState});
    let response;
    try {
      response=await chrome.runtime.sendMessage({type:'browser_page_settled',timeoutMs});
      logStep(taskId,'page_settle_response',{ok:response?.ok===true,ready:response?.ready===true,
        durationMs:Date.now()-startedAt,documentComplete:response?.documentComplete,
        settledMs:response?.settledMs,remainingMs:response?.remainingMs});
    } catch(error) {
      logStep(taskId,'page_settle_transport_error',{durationMs:Date.now()-startedAt,
        errorType:error?.name || 'Error'});
      throw error;
    }
    if (response?.ok !== true || response.ready !== true) {
      logStep(taskId,'page_settle_rejected',{ok:response?.ok===true,ready:response?.ready===true,
        durationMs:Date.now()-startedAt,errorType:'PageNotSettled'});
      throw new Error(response?.error || 'Browser page has not settled after load');
    }
    logStep(taskId,'page_settle_accepted',{durationMs:Date.now()-startedAt});
  }

  const verifiedAssistantNodes = () => site === 'chatgpt'
    ? all(['[data-response-body]','[data-message-author-role="assistant"]',
        'article[data-turn="assistant"]',
        'li[data-message-role="assistant"]']) : assistantNodes();
  const assistantNodes = () => all(A.assistant);
  const userNodes = () => all(A.user);
  // ChatGPT can put a user-message affordance on the turn wrapper instead
  // of a data-message-author-role=user element. Restrict the fallback to
  // actual user turns; page-wide text and assistant responses are not proof.
  function submissionUserNodes() {
    const nodes=userNodes();
    if(site!=='chatgpt')return nodes;
    for(const turn of document.querySelectorAll('[data-testid^="conversation-turn-"]')) {
      if(turn.getAttribute?.('data-message-author-role')==='user' ||
          turn.querySelector?.('[data-message-author-role="user"],[data-user-message-copy]'))
        nodes.push(turn);
    }
    return [...new Set(nodes)];
  }
  // Use the same message-copy projection as readChat(). ChatGPT frequently
  // renders a shortened bubble while its data-user-message-copy child keeps
  // the full submitted text. innerText of the outer turn is not dependable.
  function submittedUserText(node) {
    if(!node)return '';
    const copy=node.querySelector?.('[data-user-message-copy]') ||
      node.querySelector?.('[data-user-message-bubble="true"]');
    return String(copy?.textContent || copy?.innerText ||
      node.textContent || node.innerText || '');
  }
  const userTurnHasMarker=(marker)=>submissionUserNodes().some((node)=>
    submittedUserText(node).includes(marker));
  const submissionMarkerFor=(expected,taskId)=>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId||'') &&
    expected.includes(taskId) ? taskId : null;
  const isGenerating = () =>
    !!q(A.stop) || (A.streamingAttr ? !!document.querySelector(A.streamingAttr) : false);
  // New ChatGPT tabs start at / and receive a fresh, server-assigned /c/UUID
  // route after an accepted first prompt. Only the shape of the route is
  // observed: never log the URL or conversation identifier.
  const chatgptConversationRoute = () => {
    if(site!=='chatgpt')return null;
    const match=String(location.pathname || '')
      .match(/(?:^|\/)c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i);
    return match?.[1] || null;
  };

  const normalizePrompt = (text) => String(text ?? '').replace(/\r\n?/g,'\n').replace(/\u00a0/g,' ').trim();
  const composerText = (el) => !el ? '' : normalizePrompt(
    el.value !== undefined ? el.value : el.innerText ?? el.textContent);
  const editorIdentities=new WeakMap();
  let editorSerial=0;
  function editorIdentity(el) {
    if(!el)return null;
    if(!editorIdentities.has(el))editorIdentities.set(el,++editorSerial);
    return editorIdentities.get(el);
  }
  // Only lengths, Unicode code-point classes, editor identities and DOM shape
  // are recorded. Never record draft text, pairing codes, URLs or DOM HTML.
  function projectionShape(raw,expected) {
    if(typeof raw!=='string')return {present:false};
    const value=normalizePrompt(raw);
    return {present:true,length:value.length,
      newlineCount:(value.match(/\n/g)||[]).length,
      spaceCount:(value.match(/ /g)||[]).length,
      tabCount:(value.match(/\t/g)||[]).length,
      exactMatch:value===expected,
      whitespaceMatch:whitespaceDiagnostics(value,expected).collapsedEqual,
      firstDifference:value===expected?null:firstDifference(value,expected)};
  }
  function composerTraceSnapshot(el,expected) {
    if(!el)return {present:false};
    const value=el.value,inner=el.innerText,content=el.textContent;
    const chosen=composerText(el);
    const form=el.closest?.('form');
    const structure={
      childElementCount:el.childElementCount ?? null,
      paragraphCount:el.querySelectorAll?.('p')?.length ?? null,
      brCount:el.querySelectorAll?.('br')?.length ?? null,
    };
    return {present:true,editorId:editorIdentity(el),tag:el.tagName,
      connected:el.isConnected ?? null,active:document.activeElement===el,
      contentEditable:el.getAttribute?.('contenteditable') || null,
      formPresent:Boolean(form),formTag:form?.tagName||null,
      chosen:projectionShape(chosen,expected),
      value:projectionShape(value,expected),
      innerText:projectionShape(inner,expected),
      textContent:projectionShape(content,expected),
      structure};
  }
  const buttonEnabled = (b) => !!b && !b.disabled &&
    b.getAttribute('aria-disabled') !== 'true' &&
    b.getAttribute('data-disabled') !== 'true' &&
    !b.closest('[inert]');

  // The primary composer action has precedence over generic Send-labelled
  // buttons elsewhere (e.g. share dialogs, popovers, or hidden composers).
  // Never select a generic page button if the composer's own action is disabled.
  function findSendButton(composer = q(A.input), taskId = null) {
    logStep(taskId,'send_button_lookup_begin',{composerPresent:Boolean(composer),
      composerConnected:composer?.isConnected ?? null,composerTag:composer?.tagName || null,
      documentReady:document.readyState});
    const selectors = [
      ...A.send,
      'button[data-testid="composer-submit-button"]',
      'button[aria-label="Send message"]',
      ...SEND_FALLBACKS,
    ];
    logStep(taskId,'send_button_selectors',{count:selectors.length,selectors});
    const formScope=composer?.closest('form') || null;
    const testIdScope=composer?.closest('[data-testid="composer"]') || null;
    const classScope=composer?.closest('[class*="composer"]') || null;
    const scope=formScope || testIdScope || classScope;
    logStep(taskId,'send_button_scope_resolved',{scopeKind:formScope?'form':
      testIdScope?'composer_testid':classScope?'composer_class':'document',
      scopeTag:scope?.tagName || null,scopeTestId:scope?.getAttribute?.('data-testid') || null,
      composerConnected:composer?.isConnected ?? null});
    function select(root,scopeName) {
      logStep(taskId,'send_button_scope_scan_begin',{scope:scopeName,rootPresent:Boolean(root)});
      if (!root) {
        logStep(taskId,'send_button_scope_scan_end',{scope:scopeName,found:false,matched:false,reason:'NO_SCOPE'});
        return {found:false,button:null};
      }
      let matched = false;
      for (const selector of selectors) {
        let allButtons;
        try { allButtons=[...root.querySelectorAll(selector)]; }
        catch(error) {
          logStep(taskId,'send_button_selector_error',{scope:scopeName,selector,
            errorType:error?.name || 'Error'});
          continue;
        }
        const buttons=allButtons.filter(visible);
        logStep(taskId,'send_button_selector_scanned',{scope:scopeName,selector,
          total:allButtons.length,visible:buttons.length});
        if (!buttons.length) continue;
        matched = true;
        const states=buttons.map((button,index)=>({index,enabled:buttonEnabled(button),
          disabled:Boolean(button.disabled),ariaDisabled:button.getAttribute('aria-disabled'),
          dataDisabled:button.getAttribute('data-disabled'),testId:button.getAttribute('data-testid'),
          ariaLabel:button.getAttribute('aria-label'),connected:button.isConnected}));
        const enabled=buttons.filter(buttonEnabled);
        logStep(taskId,'send_button_candidates_evaluated',{scope:scopeName,selector,
          candidateCount:buttons.length,enabledCount:enabled.length,candidates:states});
        if (enabled.length === 1) {
          logStep(taskId,'send_button_selected',{scope:scopeName,selector,
            testId:enabled[0].getAttribute('data-testid'),ariaLabel:enabled[0].getAttribute('aria-label')});
          return {found:true,button:enabled[0]};
        }
        if (enabled.length > 1) {
          logStep(taskId,'send_button_ambiguous',{scope:scopeName,selector,
            enabledCount:enabled.length});
          return {found:true,button:null};
        }
        logStep(taskId,'send_button_disabled_fallback',{scope:scopeName,selector,
          reason:'ALL_MATCHES_DISABLED'});
        // Continue to the next selector *within the same composer*.
        // A stale disabled primary button must not prevent selecting the
        // enabled alternate submit control in the active form.
      }
      logStep(taskId,'send_button_scope_scan_end',{scope:scopeName,found:false,matched});
      return {found:matched,button:null};
    }
    const scoped = select(scope,'composer');
    if (scoped.found) {
      logStep(taskId,'send_button_lookup_end',{scope:'composer',selected:Boolean(scoped.button)});
      return scoped.button;
    }
    const global=select(document,'document');
    logStep(taskId,'send_button_lookup_end',{scope:'document',selected:Boolean(global.button)});
    return global.button;
  }

  // ChatGPT's native form-submit path is more reliable than an isolated-world
  // button.click() for a Send control whose HTML type is "submit". Use one
  // submission method only: never retry by clicking after requestSubmit(),
  // since the first attempt may already have created a chat turn.
  function activateSendOnce(button,composer,taskId) {
    const form=button?.form || composer?.closest?.('form') || null;
    const type=String(button?.type || button?.getAttribute?.('type') || '').toLowerCase();
    if(site==='chatgpt' && form && type==='submit' &&
        typeof form.requestSubmit==='function' &&
        (!button.form || button.form===form)) {
      logStep(taskId,'send_activation',{method:'form_request_submit',formPresent:true});
      form.requestSubmit(button);
      return 'form_request_submit';
    }
    logStep(taskId,'send_activation',{method:'button_click',formPresent:Boolean(form)});
    button.click();
    return 'button_click';
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
  function setInputText(el, text, taskId) {
    logStep(taskId,'input_focus_begin',{tag:el.tagName,connected:el.isConnected,
      activeBefore:document.activeElement===el,charsBefore:composerText(el).length});
    try { el.focus(); }
    catch(error) {
      logStep(taskId,'input_focus_error',{errorType:error?.name || 'Error'});
      throw error;
    }
    logStep(taskId,'input_focus_done',{activeAfter:document.activeElement===el});
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      // Setting .value and dispatching an untrusted synthetic input event can
      // leave the SPA's controlled composer unchanged. Native editing produces
      // a browser-dispatched input event and updates its internal state.
      logStep(taskId,'input_select_begin',{valueLength:composerText(el).length});
      el.select();
      logStep(taskId,'input_select_done',{selectedStart:el.selectionStart,selectedEnd:el.selectionEnd});
      const normalized = text.replace(/\r/g, '');
      let deleted,inserted;
      try { deleted = document.execCommand('delete'); }
      catch(error) {
        logStep(taskId,'input_delete_error',{errorType:error?.name || 'Error'});
        throw error;
      }
      logStep(taskId,'input_delete_done',{accepted:deleted,valueLength:composerText(el).length});
      try { inserted = document.execCommand('insertText', false, normalized); }
      catch(error) {
        logStep(taskId,'input_insert_error',{errorType:error?.name || 'Error',inputLength:normalized.length});
        throw error;
      }
      logStep(taskId,'input_insert_done',{accepted:inserted,valueLength:composerText(el).length,
        exact:composerText(el)===normalized.trim()});
      if (!deleted || !inserted || composerText(el) !== normalized.trim()) {
        throw new Error('Native textarea editing did not synchronize the composer; no prompt was submitted');
      }
      return;
    }
    // contenteditable (ProseMirror): select all, clear, then insert.
    logStep(taskId,'contenteditable_selection_begin',{tag:el.tagName,
      connected:el.isConnected,charsBefore:composerText(el).length});
    let sel,range;
    try {
      sel=window.getSelection();
      range=document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch(error) {
      logStep(taskId,'contenteditable_selection_error',{errorType:error?.name || 'Error'});
      throw error;
    }
    logStep(taskId,'contenteditable_select_done',{rangeCount:sel.rangeCount,
      selectedTextLength:sel.toString?.().length ?? null});
    let deleted;
    try { deleted=document.execCommand('delete'); }
    catch(error) {
      logStep(taskId,'contenteditable_delete_error',{errorType:error?.name || 'Error'});
      throw error;
    }
    logStep(taskId,'contenteditable_delete_done',{accepted:deleted,valueLength:composerText(el).length});

    // execCommand fires real beforeinput/input events, so the editor and the
    // page's own state (which enables the send button) both see the change.
    // Newlines are inserted as soft line breaks (Shift+Enter semantics), never as
    // Enter, so multi-line prompts cannot trigger an early submit.
    text
      .replace(/\r/g, '')
      .split('\n')
      .forEach((line, i) => {
        if (i > 0) {
          let accepted;
          try { accepted=document.execCommand('insertLineBreak'); }
          catch(error) {
            logStep(taskId,'contenteditable_linebreak_error',{line:i,errorType:error?.name || 'Error'});
            throw error;
          }
          logStep(taskId,'contenteditable_linebreak',{line:i,accepted,valueLength:composerText(el).length});
        }
        if (line) {
          let accepted;
          try { accepted=document.execCommand('insertText',false,line); }
          catch(error) {
            logStep(taskId,'contenteditable_insert_line_error',{line:i,lineLength:line.length,
              errorType:error?.name || 'Error'});
            throw error;
          }
          logStep(taskId,'contenteditable_insert_line',{line:i,accepted,lineLength:line.length,
            valueLength:composerText(el).length});
        }
      });

    const postEditValue=composerText(el);
    logStep(taskId,'contenteditable_edit_result',{valueLength:postEditValue.length,
      empty:!postEditValue,expectedLength:normalizePrompt(text).length});
    if (!postEditValue) {
      // Fallback: synthetic paste event.
      logStep(taskId,'paste_fallback_begin',{textLength:text.length});
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        const accepted=el.dispatchEvent(new ClipboardEvent('paste', {clipboardData:dt,bubbles:true,cancelable:true}));
        logStep(taskId,'paste_fallback_done',{dispatchAccepted:accepted,valueLength:composerText(el).length});
      } catch(error) {
        logStep(taskId,'paste_fallback_error',{errorType:error?.name || 'Error'});
        throw error;
      }
    }
    if (!composerText(el)) {
      logStep(taskId,'input_population_failed',{reason:'EMPTY_AFTER_INSERT'});
      throw new Error('Could not type into the chat input');
    }
    logStep(taskId,'input_population_verified',{valueLength:composerText(el).length,
      exact:composerText(el)===normalizePrompt(text)});
  }

  // Submit only once through the provider's enabled Send control. Prefer
  // native form submission for a real submit button, otherwise click. Never
  // retry a side effect automatically if delivery cannot be confirmed.
  async function sendPrompt(text, taskId) {
    let submitAttempted = false;
    let insertedByUs = false;
    let stage = 'composer_wait';
    let input=null; // Retained across try/catch for post-failure editor diagnostics.
    const thisTraceId=Date.now().toString(36)+'-'+(++traceSequence).toString(36);
    activeTraceId=thisTraceId;
    logStep(taskId, 'submission_begin', {textLength:String(text ?? '').length,
      documentReady:pageReadyForSubmission(),build:CONTENT_BUILD});
    logStep(taskId, 'composer_wait', {documentReady:pageReadyForSubmission(),
      composers:composerDiagnostics(text,taskId)});
    try {
      let composerPolls=0,lastComposerSignature='';
      const composerWaitStarted=Date.now();
      logStep(taskId,'composer_wait_begin',{selectors:A.input,timeoutMs:45000,pollIntervalMs:250});
      const ready = await waitFor(() => {
        composerPolls++;
        const complete=pageReadyForSubmission();
        let input=null,diag=null;
        try {
          input=complete ? q(A.input) : null;
          diag=complete ? composerDiagnostics(text,taskId) : null;
        } catch(error) {
          logStep(taskId,'composer_poll_error',{poll:composerPolls,documentReady:complete,
            errorType:error?.name || 'Error'});
          return null;
        }
        const signature=JSON.stringify({complete,selectedIndex:diag?.selectedIndex,
          candidates:diag?.candidates.map(({visible,tag,role,contentEditable,textLength,exactMatch,whitespaceMatch})=>
            ({visible,tag,role,contentEditable,textLength,exactMatch,whitespaceMatch}))});
        if(signature!==lastComposerSignature && (composerPolls===1 || composerPolls%8===0 || input)){
          logStep(taskId,'composer_poll',{poll:composerPolls,documentReady:complete,found:Boolean(input),
            diagnostic:diag});
          lastComposerSignature=signature;
        }
        return input;
      },45000,250);
      logStep(taskId,'composer_wait_end',{polls:composerPolls,found:Boolean(ready),
        durationMs:Date.now()-composerWaitStarted});
      if (!ready) {
        logStep(taskId,'composer_wait_timeout',{polls:composerPolls,durationMs:Date.now()-composerWaitStarted,
          documentReady:document.readyState,composers:composerDiagnostics(text,taskId)});
        throw new Error('Chat page document or composer is not ready');
      }
      stage = 'page_settling';
      logStep(taskId, stage, {composerTag:ready.tagName,composer:composerDiagnostics(text,taskId)});
      const settleStarted=Date.now();
      logStep(taskId,'page_settle_wait_begin',{timeoutMs:45000});
      await awaitBrowserPageSettled(45000,taskId);
      logStep(taskId,'page_settled',{durationMs:Date.now()-settleStarted,
        documentReady:document.readyState,composer:composerDiagnostics(text,taskId)});
    const accountChangedBeforeSend=chatgptAccountChanged();
    logStep(taskId,'account_state_checked',{accountChanged:accountChangedBeforeSend,
      pageReady:pageReadyForSubmission()});
    if (accountChangedBeforeSend) {
      throw new Error('ChatGPT session changed before submission; refresh and verify login');
    }
    // A provider can replace the editor while the document settles. Never
    // type into an orphaned composer captured before that wait.
    input = q(A.input);
    logStep(taskId,'composer_reacquired_after_settle',{found:Boolean(input),
      sameAsBefore:input===ready,connected:input?.isConnected ?? null,
      pageReady:pageReadyForSubmission(),composer:composerDiagnostics(text,taskId)});
    logStep(taskId,'composer_projection_snapshot',{phase:'before_draft',
      snapshot:composerTraceSnapshot(input,normalizePrompt(text))});
    if (!input || !pageReadyForSubmission()) {
      logStep(taskId,'composer_reacquire_rejected',{found:Boolean(input),pageReady:pageReadyForSubmission()});
      throw new Error('Chat composer changed during page settling; no prompt sent');
    }
    const expected = normalizePrompt(text);
    const previousDraft = composerText(input);
    stage = 'draft_check';
    logStep(taskId,stage,{existingDraftLength:previousDraft.length,expectedLength:expected.length,
      matchesTask:previousDraft===expected,
      whitespaceEquivalent:previousDraft.replace(/\s+/g,' ')===expected.replace(/\s+/g,' '),
      composer:composerDiagnostics(text,taskId),sendButtons:sendButtonDiagnostics(input),
      userTurnCount:userNodes().length,generating:isGenerating()});
    if (previousDraft && previousDraft !== expected) {
      logStep(taskId,'draft_check_rejected',{reason:'NONMATCHING_EXISTING_DRAFT',
        draftLength:previousDraft.length,expectedLength:expected.length,
        whitespace:whitespaceDiagnostics(previousDraft,expected)});
      const error = new Error('Composer contains a different draft; refusing to overwrite or submit it');
      error.code = 'COMPOSER_DRAFT_MISMATCH';
      throw error;
    }
    const userNodesBefore=submissionUserNodes();
    const userBefore = userNodesBefore.length;
    const oldUserNodes=new Set(userNodesBefore);
    const submissionMarker=submissionMarkerFor(expected,taskId);
    const markerVisibleBefore=Boolean(submissionMarker && userTurnHasMarker(submissionMarker));
    if(markerVisibleBefore) {
      const error=new Error('This task is already visible in a sent user turn; refusing duplicate submission');
      error.code='SUBMISSION_UNCERTAIN';
      throw error;
    }
    if (previousDraft === expected && previousDraft) {
      logStep(taskId,'draft_check_accepted',{reason:'EXACT_EXISTING_TASK_DRAFT',draftLength:previousDraft.length});
    }
    if (!previousDraft) {
      logStep(taskId,'draft_check_accepted',{reason:'EMPTY_COMPOSER'});
      insertedByUs = true;
      stage = 'draft_insertion';
      logStep(taskId,'draft_insert_begin',{composer:composerDiagnostics(text,taskId)});
      setInputText(input,text,taskId);
      logStep(taskId,'draft_insert_done',{composer:composerDiagnostics(text,taskId),sendButtons:sendButtonDiagnostics(input)});
      logStep(taskId,'composer_projection_snapshot',{phase:'immediately_after_insert',
        snapshot:composerTraceSnapshot(input,expected)});
    }
    logStep(taskId,'send_button_preparation_wait_begin',{delayMs:250});
    await sleep(250);
    logStep(taskId,'send_button_preparation_wait_end',{composer:composerDiagnostics(text,taskId)});
    logStep(taskId,'composer_projection_snapshot',{phase:'after_input_reaction',
      snapshot:composerTraceSnapshot(q(A.input),expected)});
    stage = 'send_button_wait';
    const sendWaitStarted=Date.now();
    let sendPolls=0,lastSendSignature='',lastEditorSignature='';
    logStep(taskId,'send_button_wait_begin',{timeoutMs:6500,pollIntervalMs:200});
    const button = await waitFor(() => {
      sendPolls++;
      logStep(taskId,'send_button_wait_poll_begin',{poll:sendPolls,
        pageReady:pageReadyForSubmission(),documentReady:document.readyState});
      const currentInput=q(A.input);
      const accountChanged=chatgptAccountChanged();
      logStep(taskId,'send_button_wait_state',{poll:sendPolls,inputPresent:Boolean(currentInput),
        sameComposer:currentInput===input,accountChanged,
        draftLength:composerText(currentInput).length,draftMatches:composerText(currentInput)===expected});
      const found=pageReadyForSubmission() && !accountChanged
        ? findSendButton(currentInput,taskId) : null;
      const currentSnapshot=composerTraceSnapshot(currentInput,expected);
      const editorSignature=JSON.stringify({editorId:currentSnapshot.editorId,
        tag:currentSnapshot.tag,connected:currentSnapshot.connected,
        chosen:currentSnapshot.chosen,
        buttonPresent:Boolean(found),buttonEnabled:buttonEnabled(found)});
      if(editorSignature!==lastEditorSignature) {
        logStep(taskId,'composer_state_transition',{phase:'send_wait',
          poll:sendPolls,elapsedMs:Date.now()-sendWaitStarted,
          originalEditorId:editorIdentity(input),currentEditorId:editorIdentity(currentInput),
          snapshot:currentSnapshot,buttonPresent:Boolean(found),
          buttonEnabled:buttonEnabled(found)});
        lastEditorSignature=editorSignature;
      }
      const signature=JSON.stringify({ready:pageReadyForSubmission(),accountChanged,
        button:Boolean(found),enabled:found?buttonEnabled(found):false,
        draftLength:composerText(currentInput).length});
      if(signature!==lastSendSignature && (sendPolls===1 || sendPolls%5===0 || found)){
        logStep(taskId,'send_button_poll',{poll:sendPolls,elapsedMs:Date.now()-sendWaitStarted,
          state:JSON.parse(signature),composer:composerDiagnostics(text,taskId),buttons:sendButtonDiagnostics(currentInput)});
        lastSendSignature=signature;
      }
      logStep(taskId,'send_button_wait_poll_end',{poll:sendPolls,selected:Boolean(found)});
      return found;
    },6500,200);
    logStep(taskId,'send_button_wait_end',{polls:sendPolls,selected:Boolean(button),
      durationMs:Date.now()-sendWaitStarted});
    if (!button) {
      const inspected = [...document.querySelectorAll([...A.send, ...SEND_FALLBACKS,
        'button[data-testid="composer-submit-button"]'].join(','))]
        .filter(visible).map((b) => ({
          testId:b.getAttribute('data-testid'), enabled:buttonEnabled(b),
          label:b.getAttribute('aria-label') })).slice(0, 8);
      logStep(taskId,'send_button_wait_rejected',{documentReady:document.readyState,
        composerTag:input.tagName,draftLength:composerText(input).length,
        buttonCount:inspected.length,buttons:inspected});
      throw new Error('No unambiguous enabled submit control for the active composer; ' +
        'document=' + document.readyState + ', composer=' + input.tagName +
        ', chars=' + composerText(input).length + ', buttons=' + JSON.stringify(inspected));
    }
    const currentInput=q(A.input);
    logStep(taskId,'composer_projection_snapshot',{phase:'pre_submit',
      originalEditorId:editorIdentity(input),snapshot:composerTraceSnapshot(currentInput,expected)});
    logStep(taskId,'pre_click_validation',{sameComposer:currentInput===input,
      documentReady:document.readyState,accountChanged:chatgptAccountChanged(),
      matchesTask:composerText(currentInput)===expected,
      composer:composerDiagnostics(text,taskId),buttons:sendButtonDiagnostics(currentInput)});
    const finalPageReady=pageReadyForSubmission();
    const finalAccountChanged=chatgptAccountChanged();
    const tabHidden=document.visibilityState==='hidden';
    logStep(taskId,'pre_click_page_validation',{pageReady:finalPageReady,
      documentReady:document.readyState,accountChanged:finalAccountChanged,
      tabHidden});
    if (!finalPageReady || finalAccountChanged || tabHidden) {
      logStep(taskId,'pre_click_page_validation_rejected',{reason:tabHidden?'TAB_NOT_VISIBLE':
        !finalPageReady?'PAGE_NOT_READY':'ACCOUNT_CHANGED'});
      throw new Error('Chat page changed readiness before submission; no message sent');
    }
    const parentDraftMatches=parentSetupDraftMatches(currentInput,expected,insertedByUs,taskId);
    if (!currentInput || currentInput!==input || !parentDraftMatches) {
      const failureClass=!currentInput?'COMPOSER_MISSING':
        currentInput!==input?'EDITOR_REPLACED_AFTER_INSERT':
        whitespaceDiagnostics(composerText(currentInput),expected).collapsedEqual
          ? 'WHITESPACE_RENDERING_DRIFT':'PROMPT_CONTENT_CHANGED';
      logStep(taskId,'pre_click_composer_validation_rejected',{inputPresent:Boolean(currentInput),
        sameComposer:currentInput===input,draftLength:composerText(currentInput).length,
        expectedLength:expected.length,whitespace:whitespaceDiagnostics(composerText(currentInput),expected),
        failureClass,originalEditorId:editorIdentity(input),
        currentEditorId:editorIdentity(currentInput),
        snapshot:composerTraceSnapshot(currentInput,expected)});
      const error=new Error('Chat composer changed before Send; no prompt submitted');
      error.code='COMPOSER_DRAFT_MISMATCH';
      throw error;
    }
    if (composerText(currentInput)!==expected) {
      logStep(taskId,'linebreak_normalization_accepted',{
        originalNewlines:(expected.match(/\n/g)||[]).length,
        currentNewlines:(composerText(currentInput).match(/\n/g)||[]).length,
        exactNewlinesToSpaces:true});
    }
    // No second network-idle gate after inserting the prompt: the page may
    // legitimately start background requests while the enabled Send control
    // is ready. Requiring every such request to finish strands an unsent draft.
    if (!button.isConnected && typeof button.isConnected === 'boolean') {
      logStep(taskId,'pre_click_button_rejected',{reason:'BUTTON_DISCONNECTED',testId:button.getAttribute('data-testid')});
      throw new Error('Composer submit control disappeared before click; no prompt sent');
    }
    const buttonEnabledAtClick=buttonEnabled(button);
    const composerMatchesAtClick=parentSetupDraftMatches(input,expected,insertedByUs,taskId);
    logStep(taskId,'pre_click_controls_validated',{buttonConnected:button.isConnected ?? null,
      buttonEnabled:buttonEnabledAtClick,composerMatches:composerMatchesAtClick,
      draftLength:composerText(input).length,expectedLength:expected.length,
      testId:button.getAttribute('data-testid'),ariaLabel:button.getAttribute('aria-label')});
    if (!buttonEnabledAtClick || !composerMatchesAtClick) {
      logStep(taskId,'pre_click_button_rejected',{reason:!buttonEnabledAtClick?'BUTTON_DISABLED':'DRAFT_CHANGED'});
      throw new Error('Composer changed or Send became disabled before click; no prompt sent');
    }
    stage = 'send_click';
    const startedAtFreshChatRoot=site==='chatgpt' &&
      String(location.pathname || '')==='/';
    const initialConversationRoute=chatgptConversationRoute();
    const generatingBeforeSend=isGenerating();
    logStep(taskId, stage, {testId:button.getAttribute('data-testid'),
      enabled:buttonEnabled(button), userTurnsBefore:userBefore,
      startedInNewChat:startedAtFreshChatRoot,generatingBeforeSend});
    submitAttempted = true;
    logStep(taskId,'send_click_begin',{userTurnsBefore:userBefore,
      testId:button.getAttribute('data-testid'),ariaLabel:button.getAttribute('aria-label')});
    try { activateSendOnce(button,input,taskId); }
    catch(error) {
      logStep(taskId,'send_click_error',{errorType:error?.name || 'Error'});
      throw error;
    }
    logStep(taskId,'send_click_returned',{buttonConnected:button.isConnected ?? null,
      documentReady:document.readyState});
    stage = 'submission_confirmation';
    const confirmationStarted=Date.now();
    let confirmationPolls=0,lastConfirmationSignature='';
    logStep(taskId,'submission_confirmation_begin',{timeoutMs:12000,pollIntervalMs:200,
      userTurnsBefore:userBefore});
    const confirmed = await waitFor(() => {
      confirmationPolls++;
      const currentUserNodes=submissionUserNodes();
      const userTurnCount=currentUserNodes.length;
      const generating=isGenerating();
      const accountChanged=chatgptAccountChanged();
      const draftAfterClick=composerText(q(A.input));
      const newUserNodes=currentUserNodes.filter((node)=>!oldUserNodes.has(node) &&
        submittedUserText(node).trim().length>0);
      const matchedMarker=Boolean(submissionMarker && !markerVisibleBefore &&
        currentUserNodes.some((node)=>
          submittedUserText(node).includes(submissionMarker)));
      const matchedUserTurn=matchedMarker || (userTurnCount>userBefore &&
        currentUserNodes.slice(userBefore).some((node)=>{
          const rendered=normalizePrompt(submittedUserText(node));
          return rendered===expected || whitespaceDiagnostics(rendered,expected).collapsedEqual;
        }));
      // On a newly prepared Child the sent-message UI can show only a
      // collapsed preview, hiding the UUID and/or most of the prompt. If the
      // exact draft was inserted by us, we activated its Send control ONCE,
      // the composer is now empty AND an actual new user turn appeared,
      // those independent DOM transitions confirm that submission happened.
      // Do not apply this fallback to pre-existing drafts or old turns.
      const matchedNewTurn=Boolean(site==='chatgpt' && insertedByUs &&
        submissionMarker && userTurnCount>userBefore &&
        newUserNodes.length>0 && draftAfterClick==='' &&
        !accountChanged);
      // The CURRENT ChatGPT UI can expose zero user-turn elements even after
      // accepting a prompt (and even to read_chat). For an Extension-owned
      // FIRST message on a fresh / chat, use independent browser evidence:
      // the old route had no conversation ID, a NEW /c/UUID appeared after
      // exactly one Send, the composer cleared, and generation newly started.
      // None of those signals alone is sufficient. Existing conversations
      // cannot use this fallback; never accept only a spinner or empty draft.
      const conversationRouteAfterSend=chatgptConversationRoute();
      const freshChatSendEvidence=Boolean(site==='chatgpt' && insertedByUs &&
        submissionMarker && startedAtFreshChatRoot && userBefore===0 &&
        !generatingBeforeSend && generating && draftAfterClick==='' && !accountChanged);
      const matchedFirstConversationRoute=Boolean(freshChatSendEvidence &&
        initialConversationRoute===null &&
        conversationRouteAfterSend!==null && !generatingBeforeSend &&
        generating && draftAfterClick==='');
      const accepted=matchedUserTurn || matchedNewTurn ||
        matchedFirstConversationRoute;
      if(accepted) {
        logStep(taskId,'submission_confirmation_evidence',{
          evidenceType:matchedMarker?'TASK_MARKER_IN_USER_TURN'
            : matchedUserTurn?'EXACT_RENDERED_USER_TURN'
            : matchedNewTurn?'NEW_USER_TURN_AND_CLEARED_COMPOSER'
            : 'NEW_CONVERSATION_ROUTE_AND_GENERATION',
          newUserTurnCount:newUserNodes.length,
          draftCleared:draftAfterClick==='',
          newConversationRoute:matchedFirstConversationRoute,
          copyProjectionPresent:currentUserNodes.some((node)=>
            Boolean(node.querySelector?.('[data-user-message-copy]')))});
      }
      const signature=[userTurnCount,generating,accountChanged,matchedMarker,
        matchedNewTurn,matchedFirstConversationRoute,draftAfterClick.length].join(':');
      if(signature!==lastConfirmationSignature){
        logStep(taskId,'submission_confirmation_poll',{poll:confirmationPolls,
          elapsedMs:Date.now()-confirmationStarted,userTurnCount,userTurnsBefore:userBefore,
          generating,accountChanged,matchedUserTurn,matchedMarker,
          matchedNewTurn,matchedFirstConversationRoute,
          newConversationRoute:conversationRouteAfterSend!==null &&
            conversationRouteAfterSend!==initialConversationRoute,
          newUserTurnCount:newUserNodes.length,
          draftCleared:draftAfterClick==='',draftLength:draftAfterClick.length,
          copyProjectionPresent:newUserNodes.some((node)=>
            Boolean(node.querySelector?.('[data-user-message-copy]')))});
        lastConfirmationSignature=signature;
      }
      // Generation alone can be stale or unrelated. Verify this prompt
      // actually appeared as a new user turn, not just a page transition.
      return accepted||accountChanged;
    },12000,200);
    logStep(taskId,'submission_confirmation_end',{confirmed:Boolean(confirmed),
      polls:confirmationPolls,durationMs:Date.now()-confirmationStarted,
      userTurnsAfter:userNodes().length,generating:isGenerating(),accountChanged:chatgptAccountChanged()});
    logStep(taskId, stage, {confirmed:Boolean(confirmed), userTurnsAfter:userNodes().length,
      generating:isGenerating(), draftLength:composerText(q(A.input)).length,
      accountChanged:chatgptAccountChanged()});
    if (chatgptAccountChanged() || !confirmed) {
      const error = new Error(chatgptAccountChanged()
        ? 'ChatGPT account changed during submission; delivery outcome requires reconciliation'
        : 'Prompt submission outcome uncertain: no new user turn or generation detected');
      error.code = 'SUBMISSION_UNCERTAIN';
      throw error;
    }
    } catch (error) {
      let buttons = [];
      if (stage === 'send_button_wait') {
        try {
          buttons = [...document.querySelectorAll(
            [...A.send,...SEND_FALLBACKS,'button[data-testid="composer-submit-button"]'].join(','))]
            .filter(visible).slice(0, 8).map((button) => ({
              testId:button.getAttribute('data-testid'), enabled:buttonEnabled(button)}));
        } catch {}
      }
      logStep(taskId, 'error', {stage, code:error?.code || 'UNCLASSIFIED',
        reason:error?.code==='COMPOSER_DRAFT_MISMATCH'?'COMPOSER_DRAFT_MISMATCH' :
          stage === 'send_button_wait' ? 'NO_ENABLED_SEND_BUTTON' :
          stage === 'submission_confirmation' ? 'NO_CONFIRMED_USER_TURN' :
          'SUBMISSION_STEP_FAILED', submitAttempted, insertedByUs,
        draftLength:composerText(q(A.input)).length, userTurns:userNodes().length,
        buttons,composer:composerDiagnostics(text,taskId),sendButtons:sendButtonDiagnostics(q(A.input))});
      const failedEditor=q(A.input);
      const expectedAtFailure=normalizePrompt(text);
      const failedText=composerText(failedEditor);
      const failureClass=!failedEditor?'COMPOSER_MISSING':
        failedEditor!==input?'EDITOR_REPLACED_AFTER_INSERT':
        failedText!==expectedAtFailure
          ? (whitespaceDiagnostics(failedText,expectedAtFailure).collapsedEqual
            ? 'WHITESPACE_RENDERING_DRIFT':'PROMPT_CONTENT_CHANGED')
          : (stage==='send_button_wait'?'SEND_CONTROL_NOT_READY':
            stage==='submission_confirmation'?'SUBMISSION_UNCONFIRMED':
            error?.code||'SUBMISSION_STEP_FAILED');
      logStep(taskId,'submission_failure_summary',{stage,
        errorCode:error?.code||'UNCLASSIFIED',failureClass,
        submitAttempted,insertedByUs,originalEditorId:editorIdentity(input),
        currentEditorId:editorIdentity(failedEditor),
        snapshot:composerTraceSnapshot(failedEditor,expectedAtFailure),
        sendButtons:sendButtonDiagnostics(failedEditor),
        userTurnCount:userNodes().length});
      if (error.code === 'SUBMISSION_NOT_ATTEMPTED') submitAttempted = false;
      if (!submitAttempted) {
        // Preserve pre-existing task drafts; clear only text we just inserted.
        const composer = q(A.input);
        const currentDraft=composer?composerText(composer):'';
        const shouldClear=Boolean(insertedByUs&&composer&&currentDraft===normalizePrompt(text));
        logStep(taskId,'unsent_cleanup_decision',{insertedByUs,composerPresent:Boolean(composer),
          currentDraftLength:currentDraft.length,expectedLength:normalizePrompt(text).length,
          clearOnlyOwnInsertedDraft:shouldClear});
        if (shouldClear) {
          logStep(taskId,'unsent_cleanup_begin',{tag:composer.tagName});
          try {
            composer.focus();
            if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
              composer.select();
            } else {
              const selection=window.getSelection(),range=document.createRange();
              range.selectNodeContents(composer);
              selection.removeAllRanges();selection.addRange(range);
            }
            const cleared=document.execCommand('delete');
            logStep(taskId,'unsent_cleanup_done',{accepted:cleared,remainingLength:composerText(composer).length});
          } catch(cleanupError) {
            logStep(taskId,'unsent_cleanup_error',{errorType:cleanupError?.name || 'Error'});
          }
        }
        if (!error.code) error.code = 'SUBMISSION_NOT_ATTEMPTED';
        if (composer && composerText(composer)) {
          error.message += '; unsent draft remains and must be reconciled before reuse';
        }
      } else {
        error.code = 'SUBMISSION_UNCERTAIN';
        logStep(taskId,'submission_marked_uncertain',{stage,reason:'CLICK_ALREADY_ATTEMPTED'});
      }
      throw error;
    } finally {
      if(activeTraceId===thisTraceId)activeTraceId=null;
    }
  }

  // ------------------------------------------------------------- waiting
  // Prefers the DOM selectors; if they find no new assistant message, falls back
  // to reading the page text after the prompt (needs a longer quiet period because
  // there is no reliable "finished" signal in that mode).
  // A completed worker result must belong to an actual assistant turn.
  // ChatGPT page-wide text includes transient UI errors and must never be
  // promoted to a successful assistant answer.
  async function waitForResponse(baselineCount, timeoutMs, promptText, taskId=null) {
    const t0 = Date.now();
    let started = false;
    let lastText = '';
    let stableSince = Date.now();
    let polls=0,lastSignature='';
    logStep(taskId,'response_wait_begin',{baselineAssistantTurns:baselineCount,timeoutMs,site});
    const read = () => {
      logStep(taskId,'response_read_begin',{poll:polls,site});
      if (site === 'chatgpt') {
        const nodes = verifiedAssistantNodes();
        if (nodes.length <= baselineCount) {
          logStep(taskId,'response_read_none',{poll:polls,mode:'none',assistantCount:nodes.length,
            baselineAssistantTurns:baselineCount});
          return {mode:'none',text:''};
        }
        const last = nodes[nodes.length - 1];
        const text=String(last?.innerText || last?.textContent || '').trim();
        logStep(taskId,'response_read_result',{poll:polls,mode:'dom',assistantCount:nodes.length,
          resultLength:text.length});
        return {mode:'dom',text};
      }
      const nodes=assistantNodes();
      if (nodes.length > baselineCount) {
        const text=lastAssistantText();
        logStep(taskId,'response_read_result',{poll:polls,mode:'dom',assistantCount:nodes.length,
          resultLength:text.length});
        return {mode:'dom',text};
      }
      const text=fallbackReply(promptText);
      logStep(taskId,'response_read_result',{poll:polls,mode:'fallback',assistantCount:nodes.length,
        resultLength:text.length});
      return {mode:'fallback',text};
    };

    while (Date.now() - t0 < timeoutMs) {
      polls++;
      logStep(taskId,'response_poll_begin',{poll:polls,elapsedMs:Date.now()-t0});
      const accountChanged=chatgptAccountChanged();
      if (accountChanged) {
        logStep(taskId,'response_account_changed',{poll:polls,elapsedMs:Date.now()-t0});
        const error = new Error('ChatGPT account changed after prompt submission; response is unverified');
        error.code = 'SUBMISSION_UNCERTAIN';
        throw error;
      }
      const generating = isGenerating();
      const result = read();
      if (!started && (generating || result.text)) {
        started=true;
        logStep(taskId,'response_generation_started',{poll:polls,mode:result.mode,
          generating,resultLength:result.text.length,elapsedMs:Date.now()-t0});
      }
      if (!started && Date.now() - t0 > 60000) {
        logStep(taskId,'response_start_timeout',{polls,elapsedMs:Date.now()-t0});
        throw new Error('Message submitted but no verified assistant response appeared within 60s');
      }
      if (started) {
        if (result.text !== lastText) {
          lastText = result.text;
          stableSince = Date.now();
          logStep(taskId,'response_content_changed',{poll:polls,mode:result.mode,
            resultLength:result.text.length});
        }
        const quietNeeded = result.mode === 'dom' ? 3000 : 5000;
        const quietMs=Date.now()-stableSince;
        const signature=[generating,result.mode,result.text.length,Math.floor(quietMs/500)].join(':');
        if(signature!==lastSignature){
          logStep(taskId,'response_state',{poll:polls,generating,mode:result.mode,
            resultLength:result.text.length,quietMs,quietNeeded});
          lastSignature=signature;
        }
        if (!generating && result.text && quietMs > quietNeeded) {
          logStep(taskId,'response_wait_complete',{polls,mode:result.mode,
            resultLength:result.text.length,durationMs:Date.now()-t0});
          return result.text;
        }
      }
      logStep(taskId,'response_poll_sleep',{poll:polls,delayMs:500});
      await sleep(500);
    }
    logStep(taskId,'response_wait_timeout',{polls,durationMs:Date.now()-t0,
      generationStarted:started,lastResultLength:lastText.length});
    throw new Error('Timed out waiting for a verified assistant response');
  }

  // ------------------------------------------------------------- reading
  function readChat(lastN) {
    let msgs;
    if (site === 'chatgpt') {
      // Modern ChatGPT DOM (verified against a captured conversation page):
      // message bodies use separate user bubbles and assistant response
      // bodies, while the old data-message-author-role attributes are absent.
      // Reading these LEAVES in document order avoids duplicate accessible
      // "You said"/"ChatGPT said" headings and DIL wrapper controls.
      const modern=[...document.querySelectorAll(
        '[data-user-message-bubble="true"], [data-response-body]')];
      if(modern.length) {
        msgs=modern.map((node)=>{
          const user=node.matches('[data-user-message-bubble="true"]');
          const body=user?node:
            node.querySelector('[data-dil-response]') ||
            node.querySelector('[data-markdown-text-style="assistant-message"]') || node;
          return {role:user?'user':'assistant',
            text:String(body.textContent || body.innerText || '').trim()};
        }).filter((message)=>message.text);
      } else {
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
      submissionTransport:'native-form-submit-or-button-click-v2',
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
            type: btn.type || btn.getAttribute('type') || null,
            formPresent: Boolean(btn.form || input?.closest?.('form')),
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
  let pendingParentSetupMarker = null;
  function reconcileManualParentSetup(){
    if(!pendingParentSetupMarker)return;
    // A unique pairing code in an actual user turn (not the draft) proves
    // that a human or the browser ultimately sent this one setup message.
    // Only lift the Parent setup uncertainty; never replay a chat submit.
    const sent=userTurnHasMarker(pendingParentSetupMarker);
    if(!sent)return;
    pendingParentSetupMarker=null;
    completionReceiptUncertain=false;
    logStep('parent_setup','parent_setup_user_turn_reconciled',{sent:true});
  }
  function observeState(expectedText = null) {
    reconcileManualParentSetup();
    const input = q(A.input);
    const generating = isGenerating();
    const draft = composerText(input);
    const expected = typeof expectedText === 'string' ? normalizePrompt(expectedText) : '';
    const matchesDraft = !!draft && !!expected && draft === expected;
    const whitespace=whitespaceDiagnostics(draft,expected);
    const whitespaceEquivalent = !!draft && !!expected && !matchesDraft && whitespace.collapsedEqual;
    const state = completionReceiptUncertain ? 'uncertain'
      : chatgptAccountChanged() ? 'uncertain'
      : !pageReadyForSubmission() ? 'loading'
      : !input ? 'unknown' : busy || generating ? 'busy' : draft ? 'draft' : 'idle';
    const ready = state === 'idle' || (state === 'draft' && matchesDraft);
    const diff=!!draft&&!!expected&&!matchesDraft?firstDifference(draft,expected):null;
    return {site,state,busy:state==='busy',ready,matchingDraft:matchesDraft,
      draftLength:draft.length,expectedLength:expected.length,whitespaceEquivalent,
      firstDifference:diff,whitespace,
      actualShape:textShape(draft),expectedShape:expected?textShape(expected):null,
      sectionDifferences:expected?promptSectionDiagnostics(draft,expected):null,
      documentReady:document.readyState==='complete'};
  }

  // Retry only the same completion receipt, NEVER the external chat submission.
  // The background listener treats an identical terminal receipt as idempotent.
  async function reportTaskCompletion(report) {
    const started=Date.now();
    logStep(report.taskId,'completion_report_begin',{ok:report.ok===true,
      uncertain:report.uncertain===true,notSubmitted:report.notSubmitted===true,
      resultLength:typeof report.text==='string'?report.text.length:0});
    for (let attempt = 0; attempt < 3; attempt++) {
      logStep(report.taskId,'completion_report_attempt_begin',{attempt:attempt+1});
      try {
        const response = await chrome.runtime.sendMessage(report);
        logStep(report.taskId,'completion_report_attempt_end',{attempt:attempt+1,
          accepted:response?.ok===true,duplicate:response?.duplicate===true,
          errorType:response?.ok===true?'none':'REJECTED'});
        if (response?.ok === true) {
          logStep(report.taskId,'completion_report_done',{attempts:attempt+1,durationMs:Date.now()-started});
          return;
        }
        if (response?.error === 'Unverified worker completion source') break;
      } catch (error) {
        logStep(report.taskId,'completion_report_transport_error',{attempt:attempt+1,
          errorType:error?.name || 'Error'});
      }
      if (attempt < 2) {
        const delay=600*(attempt+1);
        logStep(report.taskId,'completion_report_retry_wait',{attempt:attempt+1,delayMs:delay});
        await sleep(delay);
      }
    }
    logStep(report.taskId,'completion_report_failed',{durationMs:Date.now()-started});
    throw new Error('Worker completion transport acknowledgment is uncertain');
  }

  async function runPrompt({ taskId, receiptNonce, text, timeoutMs }, onSubmission) {
    const runStarted=Date.now();
    logStep(taskId,'run_prompt_enter',{textLength:String(text ?? '').length,timeoutMs,
      receiptNonceValid:/^[0-9a-f-]{36}$/i.test(receiptNonce || ''),state:observeState(text).state});
    logStep(taskId,'busy_state_set',{before:busy,after:true});
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
      logStep(taskId, 'task_started', {baselineAssistantTurns:baseline, timeoutMs});
      await sendPrompt(text, taskId);
      // This ACK confirms the new user turn, not the assistant's answer.
      // Releasing the startup slot here lets other workers initialize and
      // submit while this worker's model response continues independently.
      reportSubmission({ ok: true, submitted: true });
      logStep(taskId, 'submission_acknowledged');
      const result = await waitForResponse(baseline, timeoutMs || 600000, text,taskId);
      logStep(taskId, 'assistant_completed', {resultLength:result.length});
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
      logStep(taskId, 'completion_receipt', {ok:report.ok});
    } catch (error) {
      logStep(taskId, 'error', {stage:'completion_receipt', code:'RECEIPT_UNCERTAIN',
        errorType:error?.name || 'Error'});
      // Receipt loss is a distinct uncertainty: never replay a submitted chat.
      completionReceiptUncertain = true;
    } finally {
      logStep(taskId,'busy_state_cleared',{before:busy,durationMs:Date.now()-runStarted});
      busy = false;
    }
  }

  // Manager wake: transport submission only. Never treat it as consumer
  // processing or Saga acknowledgment; a timeout might have submitted.
  async function submitManagerBatch(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 60000 ||
        observeState().state !== 'idle') {
      logStep(null, 'error', {stage:'manager_readiness',code:'NOT_READY',state:observeState().state});
      return { ok: false, uncertain: false, error: 'Manager tab is not idle or batch is invalid' };
    }
    // Clearing the composer is not proof that the chat accepted a queue batch.
    // Require this batch's unique ID in a user-message bubble; otherwise UNCERTAIN.
    const batchMarker = /"batch_id":"([0-9a-f-]{36})"/i.exec(text)?.[1];
    if (!batchMarker) return { ok: false, uncertain: false, error: 'Manager batch ID missing' };
    const markerVisible = () => {
      if (userTurnHasMarker(batchMarker)) return true;
      // UI variants may not expose a user-role selector. A visible chat marker
      // counts only after it has left the active composer.
      const inPage = String(document.body?.innerText || '').includes(batchMarker);
      const stillDraft = composerText(q(A.input)).includes(batchMarker);
      return inPage && !stillDraft;
    };
    if (markerVisible()) {
      logStep(batchMarker, 'error', {stage:'manager_duplicate',code:'BATCH_ALREADY_VISIBLE'});
      completionReceiptUncertain = true;
      return { ok: false, uncertain: true, error: 'Batch is already visible; reconcile before retry' };
    }
    busy = true;
    try {
      await sendPrompt(text, batchMarker);
      if (!(await waitFor(markerVisible, 12000, 250))) {
        throw new Error('Manager batch not visible after UI submission');
      }
      logStep(batchMarker, 'manager_batch_visible');
      return { ok: true, submitted: true };
    } catch (error) {
      logStep(batchMarker, 'error', {stage:'manager_batch',code:'BATCH_UNCERTAIN',
        errorType:error?.name || 'Error'});
      completionReceiptUncertain = true;
      return { ok: false, uncertain: true, error: 'Manager submission outcome requires reconciliation' };
    } finally {
      busy = false;
    }
  }

  // Read-only, user-turn-only recovery proof. A composer draft, empty input,
  // assistant response or page-wide text never proves manager delivery.
  function inspectManagerBatch(marker,text) {
    const valid=site==='chatgpt' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marker||'') &&
      typeof text==='string' && text.includes(marker) && text.length<=60000;
    if(!valid)return {ok:false,verified:false,reason:'INVALID_BATCH'};
    const draft=composerText(q(A.input));
    return {ok:true,verified:userTurnHasMarker(marker) && !chatgptAccountChanged(),
      matchingDraft:!!draft && draft===normalizePrompt(text),
      accountChanged:chatgptAccountChanged(),generating:isGenerating(),
      documentReady:pageReadyForSubmission(),draftPresent:!!draft};
  }

  // Explicit, already journaled Skip: delete ONLY the original batch draft.
  // The DOM input event also updates the framework's controlled editor.
  function clearManagerBatchDraft(marker,text) {
    const evidence=inspectManagerBatch(marker,text);
    if(!evidence.ok)return {...evidence,cleared:false};
    if(!evidence.matchingDraft) {
      // This batch was explicitly skipped by the trusted Desktop operator.
      // Another user's draft remains untouched and still blocks new sends.
      if(!pendingParentSetupMarker)completionReceiptUncertain=false;
      return {ok:true,cleared:false,matchingDraft:false,
        verified:evidence.verified,draftPresent:evidence.draftPresent};
    }
    if(busy || evidence.generating || evidence.accountChanged)
      return {ok:false,cleared:false,reason:'MANAGER_NOT_IDLE'};
    const editor=q(A.input);
    try {
      editor.focus();
      if(editor.tagName==='TEXTAREA' || editor.tagName==='INPUT')editor.select();
      else {
        const selection=window.getSelection();
        const range=document.createRange();
        range.selectNodeContents(editor);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      const accepted=document.execCommand('delete');
      const cleared=composerText(q(A.input))==='';
      if(cleared && !pendingParentSetupMarker)completionReceiptUncertain=false;
      logStep(marker,'manager_skipped_draft_cleanup',{accepted,cleared});
      return {ok:cleared,cleared,verified:evidence.verified,
        reason:cleared?'CLEARED':'DELETE_NOT_CONFIRMED'};
    }catch(error){
      logStep(marker,'manager_skipped_draft_cleanup_failed',{errorType:error?.name||'Error'});
      return {ok:false,cleared:false,reason:'COMPOSER_CLEAR_FAILED'};
    }
  }

  function confirmManagerBatchSent(marker) {
    const verified=site==='chatgpt' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marker||'') &&
      userTurnHasMarker(marker) && !chatgptAccountChanged();
    if(verified && !pendingParentSetupMarker)completionReceiptUncertain=false;
    return {ok:verified,verified};
  }

  // Explicit Desktop-only path: submit ONLY the exact existing draft, never
  // insert an absent batch or replace another user's composer contents.
  async function retryManagerDraft(marker,text) {
    const evidence=inspectManagerBatch(marker,text);
    if(!evidence.ok || evidence.verified || !evidence.matchingDraft ||
       evidence.accountChanged || evidence.generating || !evidence.documentReady || busy)
      return {ok:false,uncertain:true,reason:evidence.verified?'ALREADY_SENT':
        evidence.matchingDraft?'NOT_READY':'EXACT_DRAFT_REQUIRED'};
    busy=true;
    try {
      await sendPrompt(text,marker);
      const verified=userTurnHasMarker(marker) && !chatgptAccountChanged();
      if(verified)completionReceiptUncertain=false;
      return {ok:verified,submitted:verified,uncertain:!verified};
    } catch {
      completionReceiptUncertain=true;
      return {ok:false,submitted:false,uncertain:true,reason:'RECONCILE_AFTER_ATTEMPT'};
    } finally {busy=false;}
  }

  // One-time, user-approved Parent setup. The user-message marker proves
  // submission, not successful MCP pairing.
  async function submitParentInitialization(text, marker) {
    if (site !== 'chatgpt' || typeof text !== 'string' || text.length > 6000 ||
        !/^[0-9a-f-]{36}$/i.test(marker || ''))
      return {ok:false,uncertain:false,error:'Invalid Parent setup'};
    if (observeState().state !== 'idle')
      return {ok:false,uncertain:false,error:'Parent chat is not idle'};
    const visibleMarker=()=>userTurnHasMarker(marker);
    if (visibleMarker())
      return {ok:false,uncertain:true,error:'Setup message already visible'};
    busy=true;
    try {
      await sendPrompt(text,'parent_setup');
      if (!await waitFor(visibleMarker,12000,250))
        throw new Error('Setup message visibility unverified');
      return {ok:true,submitted:true};
    } catch(error) {
      logStep('parent_setup','parent_setup_submission_uncertain',{
        errorCode:error?.code || 'UNCLASSIFIED',
        draftStillPresent:composerText(q(A.input))===normalizePrompt(text),
        userMarkerVisible:visibleMarker()});
      pendingParentSetupMarker=marker;
      completionReceiptUncertain=true;
      return {ok:false,uncertain:true,error:'Setup submission uncertain'};
    } finally {busy=false;}
  }

  // D-007: tiny, unprivileged status badge. Source of authority is the
  // extension's approved Parent/owned Child registry, never a page script.
  const agentStatusBadgeId='chat-orchestrator-agent-status';
  const parentOfferId='chat-orchestrator-parent-offer';
  let parentOfferTimer=null;
  let parentOfferDisposed=false;
  function updateParentEnrollmentOffer(status) {
    const existing=document.getElementById(parentOfferId);
    if(site!=='chatgpt' || !status?.offerParent || parentOfferDisposed) {
      if(parentOfferTimer){clearTimeout(parentOfferTimer);parentOfferTimer=null;}
      existing?.remove();
      return;
    }
    if(existing || parentOfferTimer || !document.body)return;
    // A newly spawned Child may briefly look like an ordinary tab before the
    // Proxy finishes binding it. Recheck extension authority just before UX.
    parentOfferTimer=setTimeout(async()=>{
      parentOfferTimer=null;
      if(parentOfferDisposed || document.getElementById(parentOfferId))return;
      let fresh;
      try {fresh=await chrome.runtime.sendMessage({type:'managed_agent_status_request'});}
      catch{return;}
      if(!fresh?.offerParent || !document.body)return;
      const panel=document.createElement('section');
      panel.id=parentOfferId;
      panel.setAttribute('role','group');
      panel.setAttribute('aria-label','Chat Orchestrator Parent Agent approval');
      panel.style.cssText=[
        'position:fixed','top:12px','right:12px','z-index:2147483000',
        'max-width:310px','padding:12px','border-radius:9px',
        'background:#182334','color:#f0f5fa','border:1px solid #54739b',
        'box-shadow:0 4px 18px #0006','font:12px/1.5 system-ui,sans-serif',
      ].join(';');
      const title=document.createElement('strong');
      title.textContent='Use this ChatGPT tab as a Parent Agent?';
      const info=document.createElement('p');
      info.textContent='Yes enables this tab as a managed Parent. No leaves it as a normal chat tab.';
      info.style.margin='8px 0';
      const controls=document.createElement('div');
      controls.style.cssText='display:flex;gap:8px';
      const yes=document.createElement('button');
      const no=document.createElement('button');
      for(const button of [yes,no])
        button.style.cssText='padding:6px 12px;border:1px solid #6589b6;border-radius:6px;cursor:pointer;color:#fff;background:#294b77';
      yes.textContent='Yes';no.textContent='No';
      no.addEventListener('click',async()=>{
        if(no.textContent==='Dismiss'){panel.remove();return;}
        no.disabled=true;
        try{
          const result=await chrome.runtime.sendMessage({type:'dismiss_parent_offer'});
          if(result?.ok!==true)throw new Error('Could not save your choice');
          panel.remove();
        }catch{info.textContent='Could not save No; try again.';no.disabled=false;}
      });
      yes.addEventListener('click',async()=>{
        yes.disabled=true;no.disabled=true;
        info.textContent='Preparing the Parent pairing…';
        try{
          const result=await chrome.runtime.sendMessage({
            type:'create_pairing_offer',approve_parent:true});
          if(result?.ok!==true)throw new Error(result?.error||'Parent setup unavailable');
          yes.remove();
          no.disabled=false;no.textContent='Dismiss';
          info.style.whiteSpace='pre-wrap';
          info.textContent=result.initialization_status==='SENT'
            ? 'Parent approval saved. The one-time setup message was sent; the Agent still needs to complete MCP pairing.'
            : 'Parent approved, but automatic Send was not confirmed. Inspect this conversation first. If the setup prompt is STILL in the composer, click ChatGPT\'s own Send button ONCE. Do not create another Parent pairing. Pairing code: '+result.code;
        }catch(error){
          info.textContent=String(error?.message||'Parent pairing unavailable');
          yes.disabled=false;no.disabled=false;
        }
      });
      controls.append(yes,no);panel.append(title,info,controls);
      document.body.appendChild(panel);
    },1800);
  }
  function updateManagedAgentStatus(status) {
    if(site!=='chatgpt' || !document?.body)return;
    updateParentEnrollmentOffer(status);
    let badge=document.getElementById(agentStatusBadgeId);
    if(!status || (status.managed!==true && status.detached!==true)) {
      badge?.remove();
      return;
    }
    if(!badge) {
      badge=document.createElement('div');
      badge.id=agentStatusBadgeId;
      badge.setAttribute('role','status');
      badge.setAttribute('aria-label','Chat Orchestrator Agent status');
      badge.style.cssText=[
        'position:fixed','right:12px','bottom:12px','z-index:2147483000',
        'background:rgba(23,28,39,.96)','color:#f7f8fa',
        'border:1px solid #4b5563','border-radius:8px','padding:7px 10px',
        'font:12px/1.3 system-ui,sans-serif','pointer-events:none',
      ].join(';');
      document.body.appendChild(badge);
    }
    if(status.detached===true && status.managed!==true) {
      badge.textContent='Chat Orchestrator · Unmanaged tab: your Parent was closed and Cancel was selected. You can close this tab whenever you want.';
      return;
    }
    const role=status.role==='parent'?'Parent':'Child';
    const connection=status.connected===true?'Connected':'Disconnected';
    const children=Number.isSafeInteger(status.activeChildren)?status.activeChildren:0;
    badge.textContent='Chat Orchestrator · '+role+' · '+connection+
      ' · '+children+' direct Child'+(children===1?'':'ren');
  }

  let listenerSequence=0;
  function onMessage(msg, sender, sendResponse) {
    const cmd=msg?.cmd;
    const requestId=++listenerSequence;
    const receivedAt=Date.now();
    logStep(msg?.taskId || null,'listener_received',{requestId,cmd:typeof cmd==='string'?cmd:'unknown',
      senderTabId:Number.isSafeInteger(sender?.tab?.id)?sender.tab.id:null,
      frameId:Number.isSafeInteger(sender?.frameId)?sender.frameId:null,
      readyState:document.readyState,site});
    switch (cmd) {
      case 'ping': {
        const state=observeState(msg.expectedText);
        logStep(null,'listener_ping_reply',{requestId,state:state.state,ready:state.ready,
          draftLength:state.draftLength,expectedLength:state.expectedLength,
          matchingDraft:state.matchingDraft,whitespaceEquivalent:state.whitespaceEquivalent,
          firstDifference:state.firstDifference,whitespace:state.whitespace,
          actualShape:state.actualShape,expectedShape:state.expectedShape,
          sectionDifferences:state.sectionDifferences,documentReady:state.documentReady});
        sendResponse({ok:true,...state});
        break;
      }
      case 'observe_state': {
        const state=observeState(msg.expectedText);
        logStep(null,'listener_observe_reply',{requestId,state:state.state,ready:state.ready,
          draftLength:state.draftLength,expectedLength:state.expectedLength,
          matchingDraft:state.matchingDraft,whitespaceEquivalent:state.whitespaceEquivalent,
          firstDifference:state.firstDifference,whitespace:state.whitespace,
          actualShape:state.actualShape,expectedShape:state.expectedShape,
          sectionDifferences:state.sectionDifferences,documentReady:state.documentReady});
        sendResponse({ok:true,...state});
        break;
      }
      case 'verify_sent_turn': {
        // Read-only reconciliation. The task UUID is in the extension's
        // managed Child setup text. Never count the composer or an assistant.
        const marker=msg.taskId;
        const valid=site==='chatgpt' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(marker||'');
        const verified=Boolean(valid && userTurnHasMarker(marker) &&
          !composerText(q(A.input)).includes(marker));
        logStep(marker,'submission_reconciliation_observed',{verified,
          userTurnCount:submissionUserNodes().length});
        sendResponse({ok:true,verified});
        break;
      }
      case 'run_prompt': {
        logStep(msg.taskId,'task_received',{textLength:String(msg.text ?? '').length,
          receiptNonceValid:/^[0-9a-f-]{36}$/i.test(msg.receiptNonce || ''),timeoutMs:msg.timeoutMs});
        const observed = observeState(msg.text);
        logStep(msg.taskId,'task_readiness_gate',{ok:observed.ready,state:observed.state,
          draftLength:observed.draftLength,expectedLength:observed.expectedLength,
          matchingDraft:observed.matchingDraft,whitespaceEquivalent:observed.whitespaceEquivalent,
          firstDifference:observed.firstDifference,actualShape:observed.actualShape,
          expectedShape:observed.expectedShape,sectionDifferences:observed.sectionDifferences,
          documentReady:observed.documentReady,composers:composerDiagnostics(msg.text,msg.taskId),
          sendButtons:sendButtonDiagnostics(q(A.input))});
        if (!observed.ready) {
          logStep(msg.taskId,'listener_send_response',{requestId,ok:false,
            durationMs:Date.now()-receivedAt,reason:'READINESS_GATE',state:observed.state});
          logStep(msg.taskId, 'error', {stage:'readiness',code:'NOT_READY',state:observed.state,
            draftLength:observed.draftLength,expectedLength:observed.expectedLength,
            matchingDraft:observed.matchingDraft,whitespaceEquivalent:observed.whitespaceEquivalent});
          sendResponse({ ok: false, error: `Tab is not safely idle (${observed.state})` });
        } else {
          logStep(msg.taskId,'listener_dispatch_run_prompt',{requestId,
            durationMs:Date.now()-receivedAt,readinessState:observed.state});
          void runPrompt(msg,(result)=>{
            logStep(msg.taskId,'listener_send_response',{requestId,ok:result?.ok===true,
              submitted:result?.submitted===true,uncertain:result?.uncertain===true,
              durationMs:Date.now()-receivedAt});
            sendResponse(result);
          });
        }
        return true; // submission receipt is asynchronous; model reply arrives separately
      }
      case 'submit_manager_batch': {
        submitManagerBatch(msg.text).then(sendResponse).catch(() => {
          sendResponse({ ok: false, uncertain: true, error: 'Manager submission failed' });
        });
        return true;
      }
      case 'inspect_manager_batch': {
        sendResponse(inspectManagerBatch(msg.batchId,msg.text));
        break;
      }
      case 'clear_manager_batch_draft': {
        sendResponse(clearManagerBatchDraft(msg.batchId,msg.text));
        break;
      }
      case 'confirm_manager_batch_sent': {
        sendResponse(confirmManagerBatchSent(msg.batchId));
        break;
      }
      case 'retry_manager_draft': {
        retryManagerDraft(msg.batchId,msg.text).then(sendResponse).catch(() => {
          sendResponse({ok:false,uncertain:true,reason:'RECONCILE_AFTER_ATTEMPT'});
        });
        return true;
      }
      case 'submit_parent_initialization': {
        submitParentInitialization(msg.text,msg.marker).then(sendResponse).catch(() => {
          sendResponse({ok:false,uncertain:true,error:'Parent setup submission uncertain'});
        });
        return true;
      }
      case 'set_managed_agent_status': {
        updateManagedAgentStatus(msg.status);
        sendResponse({ok:true});
        break;
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
  // A reload recreates this content script and asks for its verified
  // current role. An ordinary, unapproved ChatGPT tab shows no badge.
  if(site==='chatgpt') {
    Promise.resolve().then(()=>chrome.runtime.sendMessage({
      type:'managed_agent_status_request',
    })).then(updateManagedAgentStatus).catch(()=>{});
  }
  window.__chatOrchCleanup = () => {
    parentOfferDisposed=true;
    if(parentOfferTimer)clearTimeout(parentOfferTimer);
    document.getElementById(parentOfferId)?.remove();
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {}
  };
})();
