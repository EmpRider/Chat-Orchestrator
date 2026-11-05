// Read only the disposable Edge manager tab; no chat or Saga mutations.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const managerId = Number(process.env.CHAT_ORCH_E2E_MANAGER_TAB_ID);
assert.ok(Number.isSafeInteger(managerId) && managerId > 0, 'Explicit test manager tab ID required');
const targets = await (await fetch('http://127.0.0.1:9341/json/list')).json();
const target = targets.find((t) => t.type === 'service_worker' &&
  t.url.startsWith('chrome-extension://') && t.url.endsWith('/background.js'));
assert.ok(target, 'Expected isolated extension service worker missing');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let id = 0;
async function evaluate(expression) {
  const key = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP timeout')), 35000);
    function receive(raw) {
      const msg = JSON.parse(String(raw));
      if (msg.id !== key) return;
      clearTimeout(timer); ws.off('message', receive);
      if (msg.error || msg.result?.exceptionDetails) reject(new Error('CDP evaluate rejected'));
      else resolve(msg.result.result?.value);
    }
    ws.on('message', receive);
    ws.send(JSON.stringify({ id: key, method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
const tab = await evaluate('chrome.tabs.get(' + managerId + ')');
assert.equal(new URL(tab.url).hostname, 'chatgpt.com');
const state = await evaluate('chrome.tabs.sendMessage(' + managerId +
  ',{cmd:"observe_state"})');
const read = await evaluate('chrome.tabs.sendMessage(' + managerId +
  ',{cmd:"read_chat",lastN:8,includeReasoning:false,includeAttachments:false})');
const transcript = typeof read?.transcript === 'string' ? read.transcript : '';
const messages = Array.isArray(read?.messages) ? read.messages : [];
ws.close();
console.log('ISOLATED_MANAGER_READBACK ' + JSON.stringify({
  state: state?.state || 'unknown', structuredReadOk: read?.ok === true,
  messageCount: messages.length, transcriptChars: transcript.length,
  combinedBatchVisible: transcript.includes('COORDINATION BATCH'),
}));
