import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { chooseUpstream, createGateway } from '../desktop/gateway.mjs';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

test('only the dedicated connector path is rewritten', () => {
  assert.deepEqual(chooseUpstream('/orchestrator/mcp?token=a%20b'), { port: 8787, path: '/mcp?token=a%20b', orchestrator: true });
  assert.deepEqual(chooseUpstream('/mcp?token=x'), { port: 9002, path: '/mcp?token=x', orchestrator: false });
  assert.deepEqual(chooseUpstream('/orchestrator/health'), { port: 9002, path: '/orchestrator/health', orchestrator: false });
});

test('gateway forwards other paths to AgentBridge and the connector path to MCP', async () => {
  const agentBridge = http.createServer((request, response) => response.end(`agentbridge:${request.url}`));
  const agentBridgeWs = new WebSocketServer({ server: agentBridge });
  agentBridgeWs.on('connection', (socket) => socket.on('message', (message) => socket.send(`agentbridge:${message}`)));
  const orchestrator = http.createServer((request, response) => response.end(`orchestrator:${request.url}`));
  const agentBridgePort = await listen(agentBridge);
  const orchestratorPort = await listen(orchestrator);
  const gateway = createGateway({ agentBridgePort, orchestratorPort });
  const gatewayPort = await listen(gateway);
  try {
    const route = await fetch(`http://127.0.0.1:${gatewayPort}/orchestrator/mcp?token=secret`);
    assert.equal(await route.text(), 'orchestrator:/mcp?token=secret');
    const original = await fetch(`http://127.0.0.1:${gatewayPort}/health?x=1`);
    assert.equal(await original.text(), 'agentbridge:/health?x=1');
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/bridge`);
      socket.once('open', () => socket.send('ping'));
      socket.once('message', (message) => {
        try { assert.equal(String(message), 'agentbridge:ping'); socket.close(); resolve(); }
        catch (error) { reject(error); }
      });
      socket.once('error', reject);
    });
  } finally {
    await gateway.stopGateway();
    await new Promise((resolve) => agentBridgeWs.close(resolve));
    await Promise.all([close(agentBridge), close(orchestrator)]);
  }
});
