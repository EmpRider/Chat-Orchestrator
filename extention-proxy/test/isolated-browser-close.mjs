// Close only the two fixed loopback debug ports reserved for disposable test browser profiles.
import WebSocket from 'ws';
for (const port of [9341, 9340]) {
  let version;
  try { version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json(); }
  catch { continue; }
  if (!/Chrome|Edg/i.test(version.Browser || '')) throw new Error('Unknown browser on test port ' + port);
  if (!version.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:' + port + '/devtools/browser/')) {
    throw new Error('Unexpected devtools endpoint on ' + port);
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  try { ws.close(); } catch {}
  console.log('ISOLATED_TEST_BROWSER_CLOSE_REQUESTED ' + port);
}
