#!/usr/bin/env node
// agent-model-display: show which model each agent runs, in the two agent
// lists that omit it.
//
// 1. In-session agent list (the ⏺/◯ rows under the prompt): each subagent
//    row's right-hand status gains a "<model> · " prefix, so "11m 50s ·
//    ↓ 92.8k tokens" becomes "fable · 11m 50s · ↓ 92.8k tokens". The task
//    registry stores the resolved model at spawn (an omitted model: parameter
//    resolves to the caller's main-loop model before registration), so the
//    row shows the effective model even for silently-inherited spawns. Rows
//    whose record has no model (the main session, shells, resumed agents)
//    are unchanged.
// 2. Agents view (FleetView): each job row's age column gains a "<model> · "
//    prefix ("fable · 3m"), read from the job record's --model respawn flag.
//    The column width math is widened to match. Jobs with no --model flag
//    (e.g. remote rows) show the age alone.
//
// Model ids shorten to their family word: "claude-fable-5[1m]" → "fable",
// "opus[1m]" → "opus", "claude-opus-4-6" → "opus". An unrecognized id shows
// as-is minus any [1m] suffix.
//
// Anchors are structural regexes over the minified bundle (variable names
// change per build); any match count other than exactly 1 fails loudly so the
// wrapper aborts before repack and the binary stays untouched.
import { readFileSync, writeFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: agent-model-display.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

function fail(label, detail) {
  console.error(`ERROR: agent-model-display: ${label}: ${detail} — bundle layout changed, refusing`);
  process.exit(1);
}

function replaceOne(label, regex, replacement) {
  const matches = [...js.matchAll(regex)];
  if (matches.length !== 1) fail(label, `${matches.length} matches, expected exactly 1`);
  js = js.replace(regex, replacement);
  console.log(`agent-model-display: ${label} patched`);
}

// Two top-level helpers, injected once and shared by both edits (function
// declarations hoist across the bundle scope). Names are checked for collision
// first. __akModelShort maps a model id/alias to its family word; __akJobModel
// pulls a job record's --model respawn flag through it.
const HELPERS =
  'function __akModelShort(m){if(typeof m!=="string")return"";' +
  'm=m.replace(/\\[1m\\]/gi,"");' +
  'let w=/^claude-(?:\\d+[-.])*([a-z]+)/.exec(m)||/^([a-z]+)/.exec(m);' +
  "return w?w[1]:m}" +
  "function __akJobModel(s){let f=s&&s.respawnFlags,i=Array.isArray(f)?f.indexOf(\"--model\"):-1;" +
  'return i>=0?__akModelShort(f[i+1]):""}';
for (const name of ["__akModelShort", "__akJobModel"]) {
  if (js.includes(name)) fail("helper injection", `identifier ${name} already present`);
}

// FleetView column widths, stock:
//   function cvv(e,t,r,n){let o=Math.max(ovv,...e.map((l)=>Vt(fNi(l,t(l))))),i=Math.min...
// o is the age column width (Vt = string width, fNi = the age text). Widen it
// by each job's "<model> · " prefix; the detail column is computed from the
// remainder, so it narrows to compensate. The helpers ride in on this edit.
replaceOne(
  "fleetview age width",
  /function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+),([$\w]+)\)\{let ([$\w]+)=Math\.max\(([$\w]+),\.\.\.\2\.map\(\(([$\w]+)\)=>([$\w]+)\(([$\w]+)\(\8,\3\(\8\)\)\)\)\),([$\w]+)=Math\.min/g,
  HELPERS +
    'function $1($2,$3,$4,$5){let $6=Math.max($7,...$2.map(($8)=>$9($10($8,$3($8)))+(__akJobModel($8.state)?$9(__akJobModel($8.state)+" \\xB7 "):0))),$11=Math.min',
);

// FleetView row, stock:
//   age:fNi(ra,bT.has(ra.id)?$.get(ra.state.sessionId)?.nextAt:void 0)
// The age cell is a right-aligned plain string, so the model prefix lands as
// "fable · 3m" and stays aligned via the width edit above.
replaceOne(
  "fleetview row age",
  /age:([$\w]+)\(([$\w]+),([$\w]+)\.has\(\2\.id\)\?([$\w]+)\.get\(\2\.state\.sessionId\)\?\.nextAt:void 0\)/g,
  'age:(__akJobModel($2.state)?__akJobModel($2.state)+" \\xB7 ":"")+$1($2,$3.has($2.id)?$4.get($2.state.sessionId)?.nextAt:void 0)',
);

// In-session agent list: every row's right-hand status is built by one
// function from the task-registry record, stock:
//   function KZT(e,t,r,n){let o=e.type==="in_process_teammate"?
//     e.pendingUserMessages.length:e.pendingMessages.length,...}
//   → {elapsed, tokenText, queuedText, queuedCount}
// Wrap it: prefix the record's model onto elapsed. The strip's status-column
// width is measured from the same return value, so alignment follows for
// free. Records without a model (main session, shells, resumed agents) pass
// through untouched.
for (const name of ["__akStatusInner"]) {
  if (js.includes(name)) fail("helper injection", `identifier ${name} already present`);
}
replaceOne(
  "session agent list model prefix",
  /function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+),([$\w]+)\)\{let ([$\w]+)=\2\.type==="in_process_teammate"\?\2\.pendingUserMessages\.length:\2\.pendingMessages\.length,/g,
  'function $1($2,$3,$4,$5){let q=__akStatusInner($2,$3,$4,$5),m=__akModelShort($2.model);' +
    'if(m)q.elapsed=q.elapsed?m+" \\xB7 "+q.elapsed:m;return q}' +
    'function __akStatusInner($2,$3,$4,$5){let $6=$2.type==="in_process_teammate"?$2.pendingUserMessages.length:$2.pendingMessages.length,',
);

writeFileSync(jsPath, js);
