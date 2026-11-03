// MCP server <-> browser extension bridge.
//
//   Orchestrator chat --(MCP over HTTPS, via tunnel)--> POST /mcp
//   this server       --(WebSocket, localhost)-------> extension service worker (/bridge)
//   extension         --(tabs + content scripts)-----> worker chat tabs

import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

// ---------------------------------------------------------------- auth token
function loadToken() {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  const file = process.env.BRIDGE_TOKEN_FILE || path.join(__dirname, '.token');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}
let TOKEN;

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function requestToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  if (req.headers['x-bridge-token']) return String(req.headers['x-bridge-token']);
  return String(req.query?.token || '');
}

function requireToken(req, res, next) {
  if (!safeEqual(requestToken(req), TOKEN)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ------------------------------------------------------- extension WS bridge
let bridge = null;
const pending = new Map(); // id -> { resolve, reject, timer }

const bridgeConnected = () => bridge && bridge.readyState === 1;

function callExtension(method, params = {}, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    if (!bridgeConnected()) {
      return reject(
        new Error(
          'The browser extension is not connected. Open the extension popup, check the server URL/token, and make sure the browser is running.'
        )
      );
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Extension call "${method}" timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    bridge.send(JSON.stringify({ type: 'call', id, method, params }));
  });
}

function failAllPending(reason) {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
}

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  if (bridge && bridge !== ws) {
    try {
      bridge.close(4000, 'replaced by a newer connection');
    } catch {}
  }
  bridge = ws;
  console.log('[bridge] extension connected');

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (msg.type === 'result') {
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || 'extension error'));
    }
  });

  ws.on('close', () => {
    if (bridge === ws) {
      bridge = null;
      console.log('[bridge] extension disconnected');
      failAllPending('Extension disconnected while a call was in flight');
    }
  });
});

// --------------------------------------------------------------- MCP server
const textResult = (value) => ({
  content: [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
});

const errorResult = (err) => ({
  isError: true,
  content: [{ type: 'text', text: String(err?.message || err) }],
});

function forward(method) {
  return async (args) => {
    try {
      return textResult(await callExtension(method, args || {}));
    } catch (err) {
      return errorResult(err);
    }
  };
}

const waitSeconds = z
  .number()
  .int()
  .min(0)
  .max(50)
  .optional()
  .describe(
    'Seconds to wait for the worker to finish before returning (max 50). If it is still running, you get a task_id; call get_result to keep waiting.'
  );

function buildServer() {
  const server = new McpServer({ name: 'chat-orchestrator', version: '0.1.0' });

  server.registerTool(
    'list_tabs',
    {
      title: 'List chat tabs',
      description:
        'List open Claude / ChatGPT tabs in the user\'s browser with their tab_id, site, title and role (orchestrator, worker, or other).',
      inputSchema: {},
    },
    forward('list_tabs')
  );

  server.registerTool(
    'spawn_worker',
    {
      title: 'Start a worker chat',
      description:
        'Open a NEW chat session in a separate browser window on the given site and send it a task. It works like a sub-agent: the worker has no memory of this conversation unless you pass context. Returns a task_id (and the result if it finishes within wait_seconds). Use get_result to collect the answer. The worker window stays open after it finishes, so you can send follow-ups with send_to_tab. YOU are responsible for closing it with close_worker (using the tab_id) once you have the result and no longer need that worker.',
      inputSchema: {
        site: z.enum(['chatgpt', 'claude']).describe('Which chat site the worker runs on.'),
        task: z
          .string()
          .min(1)
          .describe('Self-contained instructions for the worker. Include all the context it needs.'),
        share_context_from: z
          .string()
          .optional()
          .describe(
            'Optional. Copy the full transcript of another tab into the worker\'s first message. Use a tab_id, "orchestrator" (the tab marked as orchestrator) or "active" (the tab the user is looking at).'
          ),
        auto_close: z
          .boolean()
          .optional()
          .describe(
            'Optional. If true, the extension closes this worker window by itself shortly after the task succeeds (no follow-ups possible). Default false: the window stays open until you call close_worker.'
          ),
        wait_seconds: waitSeconds,
      },
    },
    forward('spawn_worker')
  );

  server.registerTool(
    'send_to_tab',
    {
      title: 'Send a follow-up to an existing worker tab',
      description:
        'Send another message to a worker tab that is already open (continues that chat). Returns a task_id; use get_result to collect the reply.',
      inputSchema: {
        tab_id: z.number().int().describe('tab_id of the worker tab (from list_tabs or spawn_worker).'),
        text: z.string().min(1).describe('Message to send.'),
        wait_seconds: waitSeconds,
      },
    },
    forward('send_to_tab')
  );

  server.registerTool(
    'get_result',
    {
      title: 'Get a worker result',
      description:
        'Get the status/result of a task started by spawn_worker or send_to_tab. If it is still running, waits up to wait_seconds (max 50). Call it again if status is still "running".',
      inputSchema: {
        task_id: z.string().describe('The task_id returned earlier.'),
        wait_seconds: waitSeconds,
      },
    },
    forward('get_result')
  );

  server.registerTool(
    'read_chat',
    {
      title: 'Read a chat transcript',
      description:
        'Read the conversation using the site conversation API where available, with DOM fallback. Supports ChatGPT, Claude and Gemini. Defaults to orchestrator/active tab. Reasoning is excluded by default; image and attachment names can be included.',
      inputSchema: {
        tab_id: z
          .number()
          .int()
          .optional()
          .describe('Tab to read. Omit for the orchestrator/active tab.'),
        last_n: z.number().int().min(1).max(200).optional().describe('Only return the last N messages.'),
        include_reasoning: z.boolean().optional().describe('Include thinking/tool blocks in the transcript (default false).'),
        include_attachments: z.boolean().optional().describe('Include image and attachment labels (default true); never downloads file bytes.'),
      },
    },
    forward('read_chat')
  );

  server.registerTool(
    'close_worker',
    {
      title: 'Close a worker tab',
      description:
        'Close a worker tab/window that was opened by spawn_worker. Call this yourself when you have collected a worker\'s result and no longer need it. Safe to call on an already-closed tab.',
      inputSchema: { tab_id: z.number().int().describe('tab_id of the worker to close.') },
    },
    forward('close_worker')
  );

  return server;
}

// ---------------------------------------------------------------- HTTP app
const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, extensionConnected: Boolean(bridgeConnected()) });
});

app.post('/mcp', requireToken, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] error', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

const methodNotAllowed = (_req, res) =>
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed (stateless server: use POST).' },
    id: null,
  });
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

const httpServer = http.createServer(app);

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const ok = url.pathname === '/bridge' && safeEqual(url.searchParams.get('token') || '', TOKEN);
  if (!ok) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

export function startServer() {
  if (httpServer.listening) return Promise.resolve(httpServer.address());
  TOKEN = loadToken();
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      httpServer.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off('error', onError);
      const address = httpServer.address();
      console.log(`Chat Orchestrator MCP server listening on http://${HOST}:${address.port}`);
      console.log('  Extension bridge: ws://localhost:' + address.port + '/bridge');
      console.log('  MCP endpoint: /mcp (token required; credential not logged)');
      process.parentPort?.postMessage({ type: 'ready', port: address.port });
      resolve(address);
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(PORT, HOST);
  });
}

export async function stopServer() {
  failAllPending('The local MCP server is stopping');
  for (const client of wss.clients) client.terminate();
  if (httpServer.listening) {
    await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  }
}

if (process.parentPort) {
  process.parentPort.on('message', async (event) => {
    if (event?.data?.type !== 'stop') return;
    try {
      await stopServer();
      process.parentPort.postMessage({ type: 'stopped' });
    } catch (error) {
      process.parentPort.postMessage({ type: 'error', message: error.message });
    }
  });
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain || process.parentPort) {
  startServer().catch((error) => {
    console.error('[bridge] startup error:', error.message);
    process.parentPort?.postMessage({ type: 'error', message: error.message });
    process.exitCode = 1;
  });
}
