#!/usr/bin/env node
// Minimal stdio MCP server exposing one `ping` tool, used by the functional
// suite. Logs its PID and every CLAUDE_* variable it was spawned with, then its
// initialize handshake, then one line per tool call, to $LOGSRV_LOG. The
// startup PIDs and handshakes are what distinguish one shared server from one
// server per subagent; which notes each PID served is what distinguishes one
// server per subagent from one server per agent *name*; and
// CLAUDE_MCP_PER_AGENT in the startup line is the mcp-per-subagent canary.
const fs = require('fs');

const LOG = process.env.LOGSRV_LOG;
if (!LOG) {
  process.stderr.write('logsrv: LOGSRV_LOG must be set to a log path\n');
  process.exit(1);
}

function log(obj) {
  fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...obj }) + '\n');
}

const claudeEnv = {};
for (const [k, v] of Object.entries(process.env)) {
  if (/^CLAUDE/i.test(k)) claudeEnv[k] = v;
}
log({ ev: 'startup', ppid: process.ppid, cwd: process.cwd(), claudeEnv });

const TOOL = {
  name: 'ping',
  description: 'Logging probe. Takes a note string and returns ok.',
  inputSchema: {
    type: 'object',
    properties: { note: { type: 'string', description: 'arbitrary note' } },
    required: ['note'],
  },
};

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    log({ ev: 'init' });
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'logsrv', version: '1.0.0' } } });
    return;
  }
  if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } }); return; }
  if (method === 'tools/call') {
    const note = params?.arguments?.note;
    log({ ev: 'call', note });
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok: ' + note }] } });
    return;
  }
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method?.startsWith('notifications/')) return;
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
// Shutdown has to be observable however the client tears the server down: it
// may close the pipe, signal, or both, and a default SIGTERM kill would not run
// the 'exit' listener.
let stopped = false;
function note(how) {
  if (stopped) return;
  stopped = true;
  log({ ev: 'exit', how });
}
process.stdin.on('end', () => { note('stdin-closed'); process.exit(0); });
process.on('SIGTERM', () => { note('sigterm'); process.exit(0); });
process.on('SIGINT', () => { note('sigint'); process.exit(0); });
process.on('exit', () => note('exit'));
