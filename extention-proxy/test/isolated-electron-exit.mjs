// Dispose of the test-only Electron instance at the reserved loopback CDP port.
import WebSocket from 'ws';
const base = 'http://127.0.0.1:9339';
const pages = await (await fetch(base + '/json/list')).json();
if (!pages.some((t) => t.type === 'page' &&
  t.url.startsWith('file:///D:/web-chat-automation/extention-proxy/desktop/index.html'))) {
  throw new Error('Unexpected CDP target; refusing to close a non-test Electron app');
}
const version = await (await fetch(base + '/json/version')).json();
if (!version.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:9339/devtools/browser/')) {
  throw new Error('Unexpected Electron debug endpoint');
}
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
await new Promise((res) => setTimeout(res, 400));
ws.close();
console.log('ISOLATED_ELECTRON_EXIT_REQUESTED');
