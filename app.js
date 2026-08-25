// WebMCP demo — pure JS, no build step.
// Two halves: the page REGISTERS tools, the "pretend agent" panel CONSUMES them.

const $ = (sel) => document.querySelector(sel);
const mc = document.modelContext;          // undefined if WebMCP is off

// ---------------------------------------------------------------- state
const tasks = [];
let nextId = 1;
let filter = 'all';

// Pure helpers — the only real logic here, so they're what selfCheck() asserts on.
const visible = (list, f) =>
  f === 'all' ? list : list.filter((t) => (f === 'done' ? t.done : !t.done));
const findTask = (list, id) => list.find((t) => t.id === Number(id));

// Tool results follow MCP's content-array shape. The exact envelope is still
// unsettled across the explainer/spec/Chrome build, so read it back through
// normalize() rather than assuming.
const text = (s) => ({ content: [{ type: 'text', text: s }] });

// Chrome resolves executeTool() with a *string* holding the serialized result,
// so unwrap one layer of JSON before looking for the content array.
function normalize(r) {
  if (typeof r === 'string') {
    try { r = JSON.parse(r); } catch { return r; }
  }
  return Array.isArray(r?.content)
    ? r.content.map((c) => c.text ?? JSON.stringify(c)).join('\n')
    : JSON.stringify(r, null, 2);
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const id = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(id); reject(signal.reason); }, { once: true });
});

function log(kind, msg) {
  const li = document.createElement('li');
  li.className = kind;
  li.textContent = msg;
  $('#log').prepend(li);
}

// ---------------------------------------------------------------- rendering
function render() {
  const ul = $('#tasks');
  ul.textContent = '';
  for (const t of visible(tasks, filter)) {
    const li = document.createElement('li');
    if (t.done) li.className = 'done';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = t.done;
    box.setAttribute('aria-label', `Mark "${t.title}" done`);
    box.addEventListener('change', () => { t.done = box.checked; render(); });

    const id = document.createElement('span');
    id.className = 'id';
    id.textContent = `#${t.id}`;

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = t.title;            // textContent, never innerHTML

    const pri = document.createElement('span');
    pri.className = `pri ${t.priority}`;
    pri.textContent = t.priority;

    li.append(box, id, title, pri);
    ul.append(li);
  }
  const open = tasks.filter((t) => !t.done).length;
  $('#count').textContent = `${open} open / ${tasks.length} total — filter: ${filter}`;
  syncClearTool();
}

function addTask(title, priority) {
  title = String(title ?? '').trim().slice(0, 80);
  if (!title) return null;
  const p = ['low', 'normal', 'high'].includes(priority) ? priority : 'normal';
  const task = { id: nextId++, title, priority: p, done: false };
  tasks.push(task);
  render();
  return task;
}

// ------------------------------------------------- the human-facing wiring
// Runs whether or not WebMCP exists — the app must work for people first.
$('#add-form').addEventListener('submit', (e) => {
  e.preventDefault();                       // required before respondWith()
  const data = new FormData(e.target);
  const task = addTask(data.get('title'), data.get('priority'));

  // Declarative API: this same handler serves agent-driven submits.
  // `agentInvoked` tells you who pressed the button.
  if (!e.agentInvoked) {
    e.target.reset();      // resetting an agent-invoked form CANCELS the tool call
  } else {
    log('tool', `add-task (declarative) -> ${task ? `#${task.id}` : 'rejected'}`);
    e.respondWith?.(Promise.resolve(
      text(task ? `Added task #${task.id}: "${task.title}" (${task.priority}).`
                : 'Rejected: task text was empty.')
    ));
  }
});

$('.filters').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  setFilter(btn.dataset.filter);
});

function setFilter(f) {
  filter = f;
  for (const b of document.querySelectorAll('.filters button')) {
    b.classList.toggle('on', b.dataset.filter === f);
  }
  render();
}

// ---------------------------------------------------------------- provider
// Imperative API: everything a form can't express.
async function registerTools() {
  await mc.registerTool({
    name: 'list-tasks',
    description: 'List the tasks on the board. Use this before acting so you know the task IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['all', 'open', 'done'], description: 'Which tasks to return. Defaults to all.' },
      },
    },
    annotations: { readOnlyHint: true },    // hint: safe to call without asking the user
    async execute({ status = 'all' }) {
      log('tool', `list-tasks(${status})`);
      const rows = visible(tasks, status);
      return text(rows.length
        ? rows.map((t) => `#${t.id} [${t.done ? 'x' : ' '}] ${t.title} (${t.priority})`).join('\n')
        : 'No tasks match that filter.');
    },
  });

  await mc.registerTool({
    name: 'complete-task',
    description: 'Mark one task as done, or reopen it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The task id shown as #N by list-tasks.' },
        done: { type: 'boolean', description: 'True to complete, false to reopen. Defaults to true.' },
      },
      required: ['id'],
    },
    async execute({ id, done = true }) {
      log('tool', `complete-task(${id}, ${done})`);
      const t = findTask(tasks, id);
      // Loose schema, strict code: a descriptive miss lets the agent self-correct.
      if (!t) return text(`No task #${id}. Call list-tasks to see valid ids.`);
      t.done = !!done;
      render();
      return text(`Task #${t.id} "${t.title}" is now ${t.done ? 'done' : 'open'}.`);
    },
  });

  await mc.registerTool({
    name: 'filter-tasks',
    description: "Change which tasks the user's screen is showing.",
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['all', 'open', 'done'], description: 'The view to switch to.' } },
      required: ['status'],
    },
    async execute({ status }) {
      log('tool', `filter-tasks(${status})`);
      setFilter(status);
      return text(`Showing "${status}" tasks.`);
    },
  });

  // Long-running work: honour the AbortSignal instead of ignoring it.
  await mc.registerTool({
    name: 'estimate-task',
    description: 'Estimate how long a task will take. Takes a few seconds.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'The task id to estimate.' } },
      required: ['id'],
    },
    annotations: { readOnlyHint: true },
    async execute({ id }, { signal }) {
      log('tool', `estimate-task(${id}) — working, cancellable`);
      const t = findTask(tasks, id);
      if (!t) return text(`No task #${id}.`);
      await sleep(3000, signal);            // throws if the agent aborts
      return text(`Task #${t.id} "${t.title}" is about ${t.priority === 'high' ? '2 hours' : '30 minutes'}.`);
    },
  });

  log('sys', 'registered 4 imperative tools (+ add-task from the annotated form)');
}

// Tools come and go with page state — that's the whole point of registering
// them in script. This one only exists while something is completed.
let clearCtl = null;
async function syncClearTool() {
  if (!mc) return;
  const has = tasks.some((t) => t.done);
  if (has && !clearCtl) {
    const ctl = new AbortController();
    clearCtl = ctl;                          // claim the slot before awaiting
    await mc.registerTool({
      name: 'clear-completed',
      description: 'Delete every task already marked done.',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        log('tool', 'clear-completed()');
        const n = tasks.filter((t) => t.done).length;
        for (let i = tasks.length - 1; i >= 0; i--) if (tasks[i].done) tasks.splice(i, 1);
        render();
        return text(`Removed ${n} completed task${n === 1 ? '' : 's'}.`);
      },
    }, { signal: ctl.signal });
    log('sys', 'clear-completed registered (something is done)');
  } else if (!has && clearCtl) {
    // abort() IS unregister — there is no unregisterTool(). But before Chrome 153
    // it also cancels that tool's in-flight calls, and clear-completed unregisters
    // *itself* by running. Defer a tick so the call resolves before the abort lands.
    const ctl = clearCtl;
    clearCtl = null;
    setTimeout(() => ctl.abort(), 0);
    log('sys', 'clear-completed unregistered (nothing is done)');
  }
}

// ---------------------------------------------------------------- consumer
let known = [];
let runCtl = null;

async function refreshTools() {
  known = await mc.getTools();
  const sel = $('#tool-select');
  const keep = sel.value;
  sel.textContent = '';
  for (const t of known) {
    const o = document.createElement('option');
    o.value = t.name;
    o.textContent = t.name;
    sel.append(o);
  }
  if (known.some((t) => t.name === keep)) sel.value = keep;
  showTool();
}

function showTool() {
  const t = known.find((x) => x.name === $('#tool-select').value);
  if (!t) { $('#tool-info').textContent = 'No tools registered.'; return; }
  $('#tool-info').textContent =
    `${t.description}\n\norigin: ${t.origin}\nannotations: ${JSON.stringify(t.annotations ?? {})}\n\n` +
    JSON.stringify(t.inputSchema ?? {}, null, 2);
  $('#tool-args').value = JSON.stringify(skeleton(t.inputSchema), null, 2);
}

// Prefill the args box from the schema so you can see what the agent sees.
function skeleton(schema) {
  const out = {};
  for (const [k, v] of Object.entries(schema?.properties ?? {})) {
    out[k] = v.enum?.[0] ?? v.default ??
      (v.type === 'number' || v.type === 'integer' ? 0 : v.type === 'boolean' ? true : '');
  }
  return out;
}

async function runTool() {
  const tool = known.find((x) => x.name === $('#tool-select').value);
  if (!tool) return;

  let input;
  try { input = JSON.parse($('#tool-args').value || '{}'); }
  catch (err) { $('#output').textContent = `Invalid JSON: ${err.message}`; return; }

  runCtl = new AbortController();
  $('#run').disabled = true;
  $('#cancel').disabled = false;
  $('#output').textContent = 'running...';
  try {
    const raw = await execute(tool, input, { signal: runCtl.signal });
    $('#output').textContent = normalize(raw);
  } catch (err) {
    $('#output').textContent = `Error: ${err?.message ?? err}`;
  } finally {
    runCtl = null;
    $('#run').disabled = false;
    $('#cancel').disabled = true;
  }
}

// Chrome 151 wants the arguments as a JSON string; the spec IDL says a plain
// object. Try the string, and fall back only when the build rejects the type
// itself — never on an error thrown by the tool, or we'd run it twice.
async function execute(tool, input, opts) {
  try { return await mc.executeTool(tool, JSON.stringify(input), opts); }
  catch (err) {
    if (/parse input|not an object|convert value/i.test(err?.message ?? '')) {
      return await mc.executeTool(tool, input, opts);
    }
    throw err;
  }
}

// ---------------------------------------------------------------- boot
$('#tool-select').addEventListener('change', showTool);
$('#run').addEventListener('click', runTool);
$('#cancel').addEventListener('click', () => runCtl?.abort());

addTask('Read the WebMCP explainer', 'high');
addTask('Try the DevTools WebMCP panel', 'normal');

if (mc) {
  // Fires whenever any tool is registered or unregistered — a real agent uses
  // this to keep its tool list fresh instead of polling.
  mc.addEventListener('toolchange', refreshTools);
  registerTools().then(refreshTools);
} else {
  const b = $('#support');
  b.hidden = false;
  b.innerHTML = 'WebMCP is not available. Enable <code>chrome://flags/#enable-webmcp-testing</code> ' +
                'and serve this over <code>http://localhost</code>. The board still works; the agent panel does not.';
  $('#run').disabled = true;
  $('#tool-info').textContent = 'document.modelContext is undefined.';
}

// One runnable check: open with ?test and watch the console.
function selfCheck() {
  const t = [{ id: 1, done: false }, { id: 2, done: true }];
  console.assert(visible(t, 'all').length === 2, 'all');
  console.assert(visible(t, 'open').length === 1, 'open');
  console.assert(visible(t, 'done')[0].id === 2, 'done');
  console.assert(findTask(t, '2') === t[1], 'findTask coerces string ids');
  console.assert(findTask(t, 9) === undefined, 'findTask misses cleanly');
  console.assert(normalize(text('hi')) === 'hi', 'normalize content array');
  console.assert(normalize('hi') === 'hi', 'normalize plain string');
  console.assert(skeleton({ properties: { a: { type: 'number' }, b: { enum: ['x'] } } }).b === 'x', 'skeleton uses enum');
  console.log('selfCheck done — no assertion output above means it passed.');
}
if (location.search.includes('test')) selfCheck();
