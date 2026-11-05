// Stop only the explicitly isolated test desktop via its loopback DevTools port.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import WebSocket from 'ws';
const targets = await (await fetch('http://127.0.0.1:9339/json/list')).json();
const target = targets.find((x) => x.type === 'page' &&
  x.url.startsWith('file:///D:/web-chat-automation/extention-proxy/desktop/index.html'));
assert.ok(target, 'Test-only desktop page not found. Refusing to target unknown app.');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let seq = 0;
async function evaluate(expr) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP timed out')), 10000);
    function message(raw) {
      const data = JSON.parse(String(raw));
      if (data.id !== id) return;
      clearTimeout(timer); ws.off('message', message);
      if (data.exceptionDetails || data.error) reject(new Error('Desktop invocation failed'));
      else resolve(data.result?.result?.value);
    }
    ws.on('message', message);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate',
      params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
}
const current = await evaluate('window.bridge.status()');
assert.equal(current.port, 8899);
await evaluate('window.bridge.stop()');
for (let i = 0; i < 70; i++) {
  if ((await evaluate('window.bridge.status()')).phase === 'stopped') break;
  await new Promise((resolve) => setTimeout(resolve, 150));
}
assert.equal((await evaluate('window.bridge.status()')).phase, 'stopped');
const lock = 'D:/web-chat-automation/test-output/p0-ui-profile/coordination.events.journal.lock';
const exists = await fs.stat(lock).then(() => true).catch((e) =>
  e.code === 'ENOENT' ? false : Promise.reject(e));
assert.equal(exists, false, 'Isolated journal lock survived graceful stop');
ws.close();
console.log('E2E_DESKTOP_GRACEFUL_STOP_PASS');
