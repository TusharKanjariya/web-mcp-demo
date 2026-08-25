#!/usr/bin/env node
// Bridges the page's WebMCP tools out to MCP clients (Claude Desktop, ChatGPT).
//
// WebMCP lives inside the tab; MCP clients speak JSON-RPC over stdio or HTTP.
// This is the adapter between the two — tools/list becomes getTools(),
// tools/call becomes executeTool(). Zero dependencies.
//
//   node mcp-bridge.mjs             # stdio  — for Claude Desktop
//   node mcp-bridge.mjs --http 8787 # HTTP   — for ChatGPT, behind a tunnel
//
// The browser must already be running with:
//   --remote-debugging-port=9222 --enable-features=WebMCP

import { listTools, callTool } from './page.mjs';

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// Returns a response object, or null for notifications (which get no reply).
async function handle({ id, method, params }) {
  switch (method) {
    case 'initialize':
      return ok(id, {
        // Echo the client's version back so we work with old and new clients alike.
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'webmcp-bridge', version: '1.0.0' },
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return ok(id, {});

    case 'tools/list': {
      const { fatal, tools } = await listTools();
      if (fatal) return fail(id, -32603, fatal);
      return ok(id, {
        tools: tools.map((t) => ({
          // MCP tool names allow [A-Za-z0-9_-], which our hyphenated names satisfy.
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        })),
      });
    }

    case 'tools/call': {
      const { name, arguments: args = {} } = params ?? {};
      if (!name) return fail(id, -32602, 'Missing tool name');
      const { fatal, result } = await callTool(name, JSON.stringify(args));
      // A tool that failed is a *result* with isError, not a protocol error —
      // that's what lets the model read the message and correct itself.
      return ok(id, fatal
        ? { content: [{ type: 'text', text: fatal }], isError: true }
        : { content: [{ type: 'text', text: result }] });
    }

    default:
      return fail(id, -32601, `Unknown method: ${method}`);
  }
}

async function safeHandle(req) {
  try {
    return await handle(req);
  } catch (err) {
    return fail(req?.id ?? null, -32603, err.message);
  }
}

// ------------------------------------------------------------------ stdio
// Newline-delimited JSON-RPC on stdin/stdout. stdout is the protocol channel,
// so every log line must go to stderr or the client sees corrupt frames.
function runStdio() {
  let buf = '';
  // Chained so only one drain runs at a time. Without this, a 'data' event that
  // arrives while an earlier one is awaiting a tool call reads the same buffer
  // and responses get dropped.
  let queue = Promise.resolve();

  async function drain(chunk) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let req;
      try { req = JSON.parse(line); }
      catch { process.stdout.write(JSON.stringify(fail(null, -32700, 'Parse error')) + '\n'); continue; }
      const res = await safeHandle(req);
      if (res) process.stdout.write(JSON.stringify(res) + '\n');
    }
  }

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { queue = queue.then(() => drain(chunk)); });
  process.stderr.write('webmcp-bridge: stdio ready\n');
}

// ------------------------------------------------------------------- http
// Streamable HTTP: a single POST endpoint that returns one JSON response.
function runHttp(port) {
  import('node:http').then(({ createServer }) => {
    createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end('POST /mcp only');
        return;
      }
      let body = '';
      for await (const c of req) body += c;
      let parsed;
      try { parsed = JSON.parse(body); }
      catch { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify(fail(null, -32700, 'Parse error'))); return; }

      // Clients may send a single request or a batch.
      const out = Array.isArray(parsed)
        ? (await Promise.all(parsed.map(safeHandle))).filter(Boolean)
        : await safeHandle(parsed);

      res.writeHead(out ? 200 : 202, { 'content-type': 'application/json' });
      res.end(out ? JSON.stringify(out) : '');
    }).listen(port, () => process.stderr.write(`webmcp-bridge: http://127.0.0.1:${port}/mcp\n`));
  });
}

const httpAt = process.argv.indexOf('--http');
if (httpAt !== -1) runHttp(Number(process.argv[httpAt + 1] ?? 8787));
else runStdio();
