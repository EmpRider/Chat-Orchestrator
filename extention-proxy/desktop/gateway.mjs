// Optional local reverse proxy for sharing one ngrok domain with AgentBridge.
// The existing AgentBridge backend remains the default; only the dedicated MCP
// route is rewritten to Chat Orchestrator. This process never controls ngrok.
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';

export function chooseUpstream(rawUrl, agentBridgePort = 9002, orchestratorPort = 8787) {
  const url = new URL(rawUrl, 'http://localhost');
  if (url.pathname === '/orchestrator/mcp') {
    return { port: orchestratorPort, path: `/mcp${url.search}`, orchestrator: true };
  }
  return { port: agentBridgePort, path: rawUrl, orchestrator: false };
}

export function createGateway({ agentBridgePort = 9002, orchestratorPort = 8787 } = {}) {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    let route;
    try {
      route = chooseUpstream(request.url, agentBridgePort, orchestratorPort);
    } catch {
      response.writeHead(400).end('Bad request');
      return;
    }

    const upstream = http.request({
      hostname: HOST,
      port: route.port,
      method: request.method,
      path: route.path,
      headers: request.headers,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end('Local upstream unavailable');
    });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  });

  // AgentBridge may use websocket upgrades. Keep that behavior unchanged.
  server.on('upgrade', (request, socket, head) => {
    let route;
    try {
      route = chooseUpstream(request.url, agentBridgePort, orchestratorPort);
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    if (route.orchestrator) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = net.connect({ host: HOST, port: route.port });
    upstream.once('connect', () => {
      const headers = request.rawHeaders.reduce((lines, value, i, array) => {
        if (i % 2 === 0) lines.push(`${value}: ${array[i + 1]}`);
        return lines;
      }, []).join('\r\n');
      upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.stopGateway = async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  };
  return server;
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain || process.parentPort) {
  const port = Number(process.env.GATEWAY_PORT || 9003);
  const gateway = createGateway({
    agentBridgePort: Number(process.env.AGENTBRIDGE_PORT || 9002),
    orchestratorPort: Number(process.env.ORCHESTRATOR_PORT || 8787),
  });
  gateway.on('error', (error) => {
    process.parentPort?.postMessage({ type: 'error', message: error.message });
    if (!process.parentPort) console.error('Local gateway error:', error.message);
    process.exitCode = 1;
  });
  gateway.listen(port, HOST, () => {
    process.parentPort?.postMessage({ type: 'ready', port });
    if (!process.parentPort) console.log(`Local routing gateway listening on ${HOST}:${port}`);
  });
  process.parentPort?.on('message', async (event) => {
    if (event?.data?.type !== 'stop') return;
    await gateway.stopGateway();
    process.parentPort.postMessage({ type: 'stopped' });
  });
}
