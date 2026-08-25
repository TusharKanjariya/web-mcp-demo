// Shared plumbing: reach the demo page over the Chrome DevTools Protocol and
// talk to its WebMCP tool registry. Used by agent.mjs (CLI) and mcp-bridge.mjs
// (MCP server). Zero dependencies — Node 22+ has a global WebSocket.

const PORT = process.env.CDP_PORT ?? 9222;
const URL_ = process.env.PAGE_URL ?? 'https://tusharkanjariya.github.io/web-mcp-demo/';
const MATCH = process.env.PAGE_MATCH ?? new URL(URL_).host;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());

// MCP clients launch this as a child process with no browser around, so start
// one if the debug port is dead, and open the page if it isn't already up.
// The flag is only needed for origins without an origin-trial token.
async function launchChrome() {
  const { existsSync } = await import('node:fs');
  const { spawn } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32'
      ? [`${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
         `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
         `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium'];

  const exe = candidates.find((p) => p && existsSync(p));
  if (!exe) throw new Error(`Chrome not found. Start it yourself with --remote-debugging-port=${PORT}.`);

  spawn(exe, [
    `--remote-debugging-port=${PORT}`,
    '--enable-features=WebMCP',
    `--user-data-dir=${join(tmpdir(), 'webmcp-chrome')}`,
    '--no-first-run', '--no-default-browser-check',
    URL_,
  ], { detached: true, stdio: 'ignore' }).unref();

  for (let i = 0; i < 30; i++) {          // up to ~15s for the port to answer
    await sleep(500);
    try { return await targets(); } catch {}
  }
  throw new Error(`Chrome did not open a debug port on ${PORT}.`);
}

async function debuggerUrl() {
  let list;
  try { list = await targets(); } catch { list = await launchChrome(); }

  let page = list.find((t) => t.type === 'page' && t.url.includes(MATCH));
  if (!page) {
    // Browser is up but our page isn't open — open it.
    await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_)}`, { method: 'PUT' });
    for (let i = 0; i < 20 && !page; i++) {
      await sleep(500);
      page = (await targets()).find((t) => t.type === 'page' && t.url.includes(MATCH));
    }
    if (!page) throw new Error(`Could not open ${URL_}.`);
    await sleep(1000);                    // let the page's tools register
  }
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

// MCP clients call tools/list once at startup and cache the answer, so an empty
// list from a page that is still booting would look like an empty server
// forever. Give registration a moment to happen before believing a zero.
export async function listTools() {
  for (let i = 0; i < 10; i++) {
    const out = await readTools();
    if (out.fatal || out.tools.length) return out;
    await sleep(500);
  }
  return readTools();
}

async function readTools() {
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
