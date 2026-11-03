// Read-only conversation extraction based on the LLM Chat Exporter adapters.
// All authenticated requests run inside the user's page-origin content script.
// Tokens, file bytes and raw API responses are never sent to the MCP bridge.
(() => {
  const ns = self.__exporter || {};
  const MAX_MESSAGE_CHARS = 250000;

  function renderBlock(block, includeReasoning, includeAttachments) {
    if (!block || typeof block !== 'object') return '';
    switch (block.kind) {
      case 'text': return typeof block.text === 'string' ? block.text : '';
      case 'image': return includeAttachments ? `[Image: ${String(block.name || 'image')}]` : '';
      case 'artifact_ref': return includeAttachments ? `[Artifact: ${String(block.artifactId || 'document')}]` : '';
      case 'thinking': return includeReasoning ? `[Thinking]\n${String(block.text || '')}` : '';
      case 'tool_call': return includeReasoning ? `[Tool call: ${String(block.name || 'tool')}]` : '';
      case 'tool_result': return includeReasoning ? `[Tool result]\n${String(block.text || '')}` : '';
      default: return '';
    }
  }

  function toMessages(conversation, includeReasoning, includeAttachments) {
    return (Array.isArray(conversation?.turns) ? conversation.turns : []).flatMap((turn) => {
      if (turn?.role !== 'human' && turn?.role !== 'assistant') return [];
      const parts = (Array.isArray(turn.blocks) ? turn.blocks : [])
        .map((block) => renderBlock(block, includeReasoning, includeAttachments)).filter(Boolean);
      if (includeAttachments) {
        for (const att of Array.isArray(turn.attachments) ? turn.attachments : []) {
          if (!att?.fileName) continue;
          parts.push(`[Attachment: ${String(att.fileName)}]`);
        }
      }
      const text = parts.join('\n').trim().slice(0, MAX_MESSAGE_CHARS);
      return text ? [{ role: turn.role === 'human' ? 'user' : 'assistant', text }] : [];
    });
  }

  function makeResult(conversation, site, lastN, opts = {}) {
    const includeReasoning = opts.includeReasoning === true;
    const includeAttachments = opts.includeAttachments !== false;
    const all = toMessages(conversation, includeReasoning, includeAttachments);
    const selected = Number.isInteger(lastN) && lastN > 0 ? all.slice(-lastN) : all;
    return {
      site,
      title: conversation.title || document.title || '',
      message_count: selected.length,
      transcript: selected.map(({ role, text }) =>
        `${role === 'user' ? 'User' : 'Assistant'}: ${text}`).join('\n\n'),
      source: 'conversation_api',
    };
  }

  async function readChat(site, lastN, opts = {}) {
    let normalized;
    if (site === 'chatgpt') {
      const api = ns.chatgptApi;
      const id = api?.parseConvIdFromUrl(location.href);
      if (!id) throw new Error('ChatGPT conversation URL is not supported');
      const token = await api.getAccessToken();
      const raw = await api.fetchConversation(id, token);
      normalized = ns.chatgptNormalize.normalize(raw, { inlineTextFiles: false });
    } else if (site === 'claude') {
      const api = ns.claudeApi;
      const id = api?.parseConvIdFromUrl(location.href);
      if (!id) throw new Error('Claude conversation URL is not supported');
      const orgId = await api.getOrgId();
      const raw = await api.fetchConversation(orgId, id);
      normalized = ns.claudeNormalize.normalize(raw, { inlineTextFiles: false });
    } else if (site === 'gemini') {
      const api = ns.geminiApi;
      const locator = api?.parseConvLocator(location.href);
      if (!locator) throw new Error('Gemini conversation URL is not supported');
      const atToken = await api.getAtToken();
      const raw = await api.fetchConversation({ ...locator, atToken });
      normalized = ns.geminiNormalize.normalize(raw, {
        title: document.title,
        inlineTextFiles: false,
      });
    } else {
      throw new Error('Unsupported conversation provider');
    }
    if (!normalized || !normalized.conversation || !Array.isArray(normalized.conversation.turns)) {
      throw new Error('Conversation API returned an unsupported response');
    }
    return makeResult(normalized.conversation, site, lastN, opts);
  }

  // Exported only inside the isolated content-script context.
  self.__chatOrchStructuredReader = { readChat, makeResult };
})();
