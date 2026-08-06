#!/usr/bin/env node
// Minimal logging MCP stdio server for the toolUseId correlation experiment.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LOG = '/Users/akelly/.claude/jobs/87f26767/tmp/expA/mcp.log';
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

function log(obj) {
  fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...obj }) + '\n');
}

const claudeEnv = {};
for (const [k, v] of Object.entries(process.env)) {
  if (/^CLAUDE/i.test(k) || /^ANTHROPIC/i.test(k) || k === 'PWD' || k === 'MCP_SERVER_NAME') claudeEnv[k] = v;
}
const munged = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
const guessDir = path.join(PROJECTS, munged);

log({
  ev: 'startup',
  pid: process.pid,
  ppid: process.ppid,
  cwd: process.cwd(),
  argv: process.argv,
  mungedProjectDir: guessDir,
  mungedProjectDirExists: fs.existsSync(guessDir),
  claudeEnvVars: claudeEnv,
  allEnvKeys: Object.keys(process.env).sort(),
});

function grepFiles(root, needle) {
  const r = spawnSync('grep', ['-rl', '--include=*.jsonl', '-F', '--', needle, root], { encoding: 'utf8' });
  if (r.status === 0) return r.stdout.trim().split('\n').filter(Boolean);
  return [];
}

async function findToolUseId(id) {
  const start = Date.now();
  const roots = fs.existsSync(guessDir) ? [guessDir] : [PROJECTS];
  for (let attempt = 0; ; attempt++) {
    let hits = [];
    for (const r of roots) hits = hits.concat(grepFiles(r, id));
    if (hits.length) return { found: true, attempt, elapsedMs: Date.now() - start, files: hits, roots };
    if (Date.now() - start > 5000) return { found: false, attempt, elapsedMs: Date.now() - start, files: [], roots };
    await new Promise((res) => setTimeout(res, 10));
  }
}

function send(msg) {
  const line = JSON.stringify(msg);
  log({ ev: 'send', raw: line });
  process.stdout.write(line + '\n');
}

const TOOL = {
  name: 'ping',
  description: 'Logging probe. Takes a note string, waits ~500ms, returns ok.',
  inputSchema: { type: 'object', properties: { note: { type: 'string', description: 'arbitrary note' } }, required: ['note'] },
};

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    log({ ev: 'initialize_params', params });
    send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'logsrv', version: '0.0.1' } } });
    return;
  }
  if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } }); return; }
  if (method === 'tools/call') {
    const meta = params && params._meta;
    const tuid = meta && (meta['claudecode/toolUseId'] || meta.toolUseId);
    log({ ev: 'tools_call_params', params_full: params, extracted_meta: meta || null, toolUseId: tuid || null, note: params?.arguments?.note });
    let corr = null;
    if (tuid) corr = await findToolUseId(tuid);
    else await new Promise((r) => setTimeout(r, 500));
    if (corr) log({ ev: 'correlation', toolUseId: tuid, note: params?.arguments?.note, ...corr });
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok: ' + (params?.arguments?.note || '') }] } });
    return;
  }
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method && method.startsWith('notifications/')) return;
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    log({ ev: 'recv', raw: line });
    let msg;
    try { msg = JSON.parse(line); } catch (e) { log({ ev: 'parse_error', line, err: String(e) }); continue; }
    handle(msg).catch((e) => log({ ev: 'handler_error', err: String(e && e.stack) }));
  }
});
process.stdin.on('end', () => log({ ev: 'stdin_end' }));
process.on('exit', (c) => log({ ev: 'exit', code: c }));
