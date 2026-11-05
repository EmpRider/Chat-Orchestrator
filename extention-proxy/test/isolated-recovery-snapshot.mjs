// Read only the disposable Electron CDP page after safe journal restart.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const base = 'http://127.0.0.1:9339';
const targets = await (await fetch(base + '/json/list')).json();
const target = targets.find((t) => t.type === 'page' &&
  t.url.startsWith('file:///D:/web-chat-automation/extention-proxy/desktop/index.html'));
assert.ok(target, 'Expected isolated desktop, refusing any other CDP target');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let seq = 0;
async function evaluate(expression) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP timeout')), 8000);
    const recv = (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id !== id) return;
      clearTimeout(timer); ws.off('message', recv);
      if (msg.error || msg.result?.exceptionDetails) reject(new Error('Evaluation failed'));
      else resolve(msg.result.result?.value);
    };
    ws.on('message', recv);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
let result;
for (let i = 0; i < 50; i++) {
  result = await evaluate('Promise.all([window.bridge.status(),Promise.resolve({summary:document.querySelector("#coordination-summary")?.textContent,queue:document.querySelector("#queue-items")?.textContent})])');
  const [state, ui] = result;
  if (state.phase === 'running' && state.coordinationSnapshot?.hiddenPending > 0 &&
      ui.summary?.includes('re-pair/reconciliation') && ui.queue?.includes('hidden until trusted re-pair')) {
    assert.equal(state.coordinationSnapshot.storageReady, true);
    assert.equal(state.coordinationSnapshot.queue.length, 0, 'unregistered contents must remain private');
    assert.ok(state.coordinationSnapshot.phases.UNCERTAIN >= 1,
      'unacknowledged live manager dispatch was not classified as UNCERTAIN after restart');
    console.log('RECOVERED_HIDDEN_QUEUE_UI_PASS ' + JSON.stringify({
      hiddenPending: state.coordinationSnapshot.hiddenPending,
      uncertain: state.coordinationSnapshot.phases.UNCERTAIN,
      detailsRedacted: true, noAutoReplay: true,
    }));
    ws.close(); process.exit(0);
  }
  await new Promise((res) => setTimeout(res, 150));
}
ws.close();
throw new Error('Post-restart private queue has no visible redacted recovery warning');
