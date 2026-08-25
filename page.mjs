// Shared plumbing: reach the demo page over the Chrome DevTools Protocol and
// talk to its WebMCP tool registry. Used by agent.mjs (CLI) and mcp-bridge.mjs
// (MCP server). Zero dependencies — Node 22+ has a global WebSocket.

const PORT = process.env.CDP_PORT ?? 9222;
const MATCH = process.env.PAGE_MATCH ?? '5500';

async function debuggerUrl() {
  let list;
  try {
    list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
  } catch {
    throw new Error(`No Chrome on port ${PORT}. Launch it with --remote-debugging-port=${PORT} --enable-features=WebMCP.`);
  }
  const page = list.find((t) => t.type === 'page' && t.url.includes(MATCH));
  if (!page) throw new Error(`No open page whose URL contains "${MATCH}".`);
  return page.webSocketDebuggerUrl;
}

// One CDP round trip: evaluate an expression in the page and await its promise.
// The page always hands back JSON *text* — CDP's deep-serializer silently drops
// plain objects like inputSchema, but a string survives intact.
async function evalInPage(expression) {
  const ws = new WebSocket(await debuggerUrl());
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

  const msg = await new Promise((resolve, reject) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) resolve(d); };
    ws.onerror = reject;
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
  });
  ws.close();

  if (msg.error) throw new Error(msg.error.message);
  const { exceptionDetails, result } = msg.result;
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'page threw');
  return JSON.parse(result.value);
}

const guard = `if (!document.modelContext) return JSON.stringify({ fatal: 'document.modelContext is undefined — relaunch Chrome with --enable-features=WebMCP' });`;

export async function listTools() {
  const out = await evalInPage(`(async () => { ${guard}
    const tools = await document.modelContext.getTools();
    return JSON.stringify({ tools: tools.map(t => ({
      name: t.name, description: t.description,
      inputSchema: t.inputSchema, annotations: t.annotations, origin: t.origin,
    })) });
  })()`);
  if (out.fatal) return out;
  // Chrome 151 hands inputSchema back as a JSON string, though the spec's
  // RegisteredTool types it as an object. Normalise to an object here so both
  // callers — and the MCP clients downstream — get what they expect.
  for (const t of out.tools) {
    if (typeof t.inputSchema === 'string') {
      try { t.inputSchema = JSON.parse(t.inputSchema); } catch { t.inputSchema = undefined; }
    }
    t.inputSchema ??= { type: 'object', properties: {} };
  }
  return out;
}

export async function callTool(name, argsJson) {
  return evalInPage(`(async () => { ${guard}
    const mc = document.modelContext;
    const tool = (await mc.getTools()).find(t => t.name === ${JSON.stringify(name)});
    if (!tool) return JSON.stringify({ fatal: 'No tool named ' + ${JSON.stringify(name)} });
    const json = ${JSON.stringify(argsJson)};
    let raw;
    // Chrome 151 wants the arguments as a JSON string; the spec IDL says a plain
    // object. Try the string, and fall back only when the build rejects the type
    // itself — never on an error thrown by the tool, or we'd run it twice.
    try { raw = await mc.executeTool(tool, json); }
    catch (e) {
      const msg = String(e && e.message || e);
      if (/parse input|not an object|convert value/i.test(msg)) raw = await mc.executeTool(tool, JSON.parse(json));
      else return JSON.stringify({ fatal: msg });
    }
    // Chrome resolves executeTool() with a string holding the serialized
    // result, so unwrap one layer of JSON before reading the content array.
    let v = raw;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch {} }
    const out = typeof v === 'string' ? v
      : Array.isArray(v && v.content) ? v.content.map(c => c.text ?? JSON.stringify(c)).join('\\n')
      : JSON.stringify(v, null, 2);
    return JSON.stringify({ result: out });
  })()`);
}
