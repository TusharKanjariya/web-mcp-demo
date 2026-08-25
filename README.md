# WebMCP demo — Task Board

Three files, no build step, no dependencies. A plain task board that also exposes
itself to an AI agent as callable tools via `document.modelContext`.

## Run

WebMCP needs a secure context, so serve it — don't open the file directly:

```
cd C:/projects/web-mcp-demo
python -m http.server 8000
```

Then in Chrome:

1. `chrome://flags/#enable-webmcp-testing` → **Enabled** → relaunch.
2. Open <http://localhost:8000>.
3. If the orange banner appears, the flag didn't take.

Add `?test` to the URL to run the assertions in `selfCheck()` (console).

## What to look at

| Concept | Where |
|---|---|
| **Declarative API** — a form becomes a tool | `index.html`, the `toolname` / `tooldescription` / `toolparamdescription` / `toolautosubmit` attributes |
| **`agentInvoked` + `respondWith()`** — answering an agent without navigating | `app.js`, the `submit` handler |
| **Imperative API** — `registerTool` with a JSON Schema | `app.js`, `registerTools()` |
| **`readOnlyHint`** — telling the agent what's safe | `list-tasks`, `estimate-task` |
| **`AbortSignal` as cancellation** | `estimate-task` — run it, hit Cancel |
| **`AbortSignal` as *unregistration*** — there is no `unregisterTool()` | `syncClearTool()` |
| **`toolchange`** — how an agent notices tools appear/disappear | bottom of `app.js` |
| **Consumer half** — `getTools()` + `executeTool()` | the "Pretend Agent" panel |

The panel is there so you can see both ends of the API without a real agent.
Chrome DevTools has the same thing built in: **Application → WebMCP**.

## Try this

1. Tick a task done → watch the log: `clear-completed` **registers itself**, and
   the tool dropdown grows. Untick it → it unregisters. That's the argument for
   registering tools in script instead of a static manifest.
2. Run `filter-tasks` with `{"status":"done"}` → the agent changed *the user's
   screen*, not a hidden copy of the state. That's the difference from backend MCP.
3. Run `estimate-task` and hit Cancel within 3s.
4. Run `complete-task` with `{"id":99}` → a descriptive miss, not a throw, so a
   real agent can correct itself.

## Driving it from outside the browser (`agent.mjs`)

`agent.mjs` is a real out-of-page agent in ~110 lines with zero dependencies. It
talks to the page over the Chrome DevTools Protocol, so it can only see what
`getTools()` reports and only act through `executeTool()` — no DOM scraping.

Launch Chrome with the flag *and* a debugging port (a separate profile is required;
Chrome refuses `--remote-debugging-port` on your default one):

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 --enable-features=WebMCP `
  --user-data-dir="$env:TEMP\chrome-webmcp" --no-first-run `
  http://127.0.0.1:5500/index.html
```

Then:

```
node agent.mjs list
node agent.mjs call list-tasks     '{"status":"open"}'
node agent.mjs call add-task       '{"title":"Ship the demo","priority":"high"}'
node agent.mjs call complete-task  '{"id":1}'
node agent.mjs call clear-completed '{}'
```

`--enable-features=WebMCP` is the command-line equivalent of the
`chrome://flags/#enable-webmcp-testing` toggle.

## Using it from Claude Desktop or ChatGPT (`mcp-bridge.mjs`)

Neither app speaks WebMCP — they speak **MCP**. `mcp-bridge.mjs` is the adapter:
`tools/list` → `getTools()`, `tools/call` → `executeTool()`. Same JSON-RPC handler,
two transports. Chrome must already be running with the flag and the debug port.

### Claude Desktop — stdio

Add to `%APPDATA%\Claude\claude_desktop_config.json`, then fully quit and reopen
Claude Desktop (it reads the file only at startup):

```json
{
  "mcpServers": {
    "webmcp-board": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\projects\\web-mcp-demo\\mcp-bridge.mjs"]
    }
  }
}
```

Use the **full path** to `node.exe` — Claude Desktop launches servers with a
minimal PATH, so a bare `node` usually fails. stdout is the protocol channel, so
the bridge logs only to stderr.

### ChatGPT — HTTP, and only through a tunnel

ChatGPT's connectors cannot reach `localhost`; a connector must be a public HTTPS
endpoint speaking SSE or Streamable HTTP, added under Developer mode (Pro/Plus/
Business/Enterprise/Edu). So:

```
node mcp-bridge.mjs --http 8787
ngrok http 8787          # then register https://<id>.ngrok.app/mcp as the connector
```

**Understand what that does before you run it.** The tunnel publishes a
no-auth endpoint that executes tools inside your logged-in browser tab, to anyone
who guesses the URL. Fine for a few minutes of local experimenting; not something
to leave running. Claude Desktop's stdio path has no such exposure — prefer it.

## Publishing to GitHub Pages

The demo is 100% static, so it deploys as-is and HTTPS gives you the secure
context WebMCP requires. But three different things are called "working":

| | On GitHub Pages |
|---|---|
| The task board | Works for everyone. Plain HTML/CSS/JS, no backend. |
| `document.modelContext` | **Undefined for visitors.** WebMCP is still *Proposed* on Chrome Platform Status — not on by default in any Chrome. Visitors see the orange banner unless they enable the flag themselves, or you attach an origin-trial token. |
| `agent.mjs`, `mcp-bridge.mjs` | Not published — they're local CDP clients. They keep running on your machine; you just point them at the new URL. |

To make it work for visitors without the flag, register an origin trial for
`https://<username>.github.io` (that one origin covers all your project pages) and
add the token to `index.html`:

```html
<meta http-equiv="origin-trial" content="TOKEN_GOES_HERE">
```

Tokens last about six weeks; extending one requires submitting feedback.

To point the local tooling at the published page instead of Live Server:

```
PAGE_MATCH=github.io node agent.mjs list
```

Chrome still needs `--remote-debugging-port=9222 --enable-features=WebMCP` locally —
publishing the page changes where the tools live, not how you reach them.

## What Chrome 151 actually does vs. what the spec says

Found by running the thing, not by reading:

| The spec / explainer says | Chrome 151 does | Handled in |
|---|---|---|
| `executeTool(tool, inputObject)` takes an object | Takes a **JSON string**; an object gives `Failed to parse input arguments` | `execute()` in `app.js`, `callTool()` in `agent.mjs` |
| `RegisteredTool.inputSchema` is an `object` | Is a **JSON string** | `listTools()` output in `agent.mjs` |
| `executeTool` resolves to a `DOMString` | True — a *serialized* `{content:[…]}`, so it needs unwrapping twice | `normalize()` |
| — | Calling `form.reset()` during an agent-invoked submit **cancels the tool call** (`Tool execution cancelled by a form reset`) | the `submit` handler only resets for human submits |
| Chrome 153+: unregistering no longer cancels in-flight calls | On 151 it **does** — so a tool that unregisters itself while running kills its own response | `syncClearTool()` defers `abort()` by a tick |

The last two are the interesting ones: both are lifecycle traps you only hit once
an actual agent drives the page.

## Caveats

- The tool result envelope (`{content:[{type:'text',text}]}` vs a plain string)
  is still inconsistent between the explainer, the spec IDL, and Chrome. `normalize()`
  and `execute()` in `app.js` absorb both.
- Nothing here covers cross-origin (`exposedTo` / `fromOrigins` / `allow="tools"`).
- `untrustedContentHint` is a *hint*. The prompt-injection threat model is still open
  in the spec — don't treat any of this as an authorization boundary.
