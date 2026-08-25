#!/usr/bin/env node
// A tiny out-of-page WebMCP agent. Zero dependencies.
//
// It talks to the page over the Chrome DevTools Protocol, which puts it exactly
// as far away as a real browser agent: it can only see what getTools() reports
// and can only act through executeTool(). No DOM scraping.
//
//   node agent.mjs list
//   node agent.mjs call list-tasks '{"status":"open"}'
//   node agent.mjs call add-task   '{"title":"Ship the demo","priority":"high"}'
//
// Requires Chrome launched with --remote-debugging-port=9222 --enable-features=WebMCP

import { listTools, callTool } from './page.mjs';

const [cmd, name, args = '{}'] = process.argv.slice(2);
const die = (m) => { console.error(m); process.exit(1); };

try {
  if (cmd === 'list') {
    const { fatal, tools } = await listTools();
    if (fatal) die(fatal);
    for (const t of tools) {
      console.log(`\n${t.name}${t.annotations?.readOnlyHint ? '  (read-only)' : ''}`);
      console.log(`  ${t.description}`);
      const props = Object.entries(t.inputSchema?.properties ?? {});
      const req = new Set(t.inputSchema?.required ?? []);
      for (const [k, v] of props) {
        const type = v.enum ? v.enum.join('|') : v.type;
        console.log(`    ${k}${req.has(k) ? '*' : ''}: ${type} — ${v.description ?? ''}`);
      }
      if (!props.length) console.log('    (no arguments)');
    }
    console.log(`\n${tools.length} tools.`);
  } else if (cmd === 'call') {
    if (!name) die("usage: node agent.mjs call <tool> '<json>'");
    const { fatal, result } = await callTool(name, args);
    if (fatal) die(fatal);
    console.log(result);
  } else {
    die("usage: node agent.mjs list | node agent.mjs call <tool> '<json>'");
  }
} catch (err) {
  die(`agent error: ${err.message}`);
}
