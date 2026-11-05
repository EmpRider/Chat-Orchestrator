// Manual isolated Electron UI screenshot: no DOM writes or production browser access.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const endpoint = process.env.CHAT_ORCH_E2E_CDP_URL || 'http://127.0.0.1:9339';
if (!/^http:\/\/127\.0\.0\.1:[0-9]{4,5}$/.test(endpoint)) throw new Error('Loopback CDP only');
const targets = await (await fetch(endpoint + '/json/list')).json();
const target = targets.find((t) => t.type === 'page' &&
  t.url?.endsWith('/extention-proxy/desktop/index.html'));
if (!target?.webSocketDebuggerUrl) throw new Error('Isolated desktop target absent');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP screenshot timeout')), 10000);
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id !== 1) return;
    clearTimeout(timer);
    if (msg.error || !msg.result?.data) reject(new Error('CDP screenshot failed'));
    else resolve(msg.result.data);
  });
  ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot',
    params: { format: 'png', captureBeyondViewport: false } }));
});
ws.close();
const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../test-output/p0-ui-dashboard.png');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, Buffer.from(result, 'base64'));
console.log('E2E_SCREENSHOT_OK ' + output);
