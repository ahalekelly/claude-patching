#!/usr/bin/env node
// agent-list-models: the in-session agent list (the ⏺/◯ rows under the
// prompt) shows which model every row runs.
//
// - Subagent rows: the right-hand status becomes "<elapsed> · <model> ·
//   <tokens>", e.g. "11m 50s · fable · ↓ 92.8k tokens". The task registry
//   stores the resolved model at spawn (an omitted model: parameter resolves
//   to the caller's main-loop model before registration), so the row shows
//   the effective model even for silently-inherited spawns. Rows whose
//   record has no model (shells, resumed agents) are unchanged.
// - The "⏺ main" row gains a right-aligned "<model> · ↓ <tokens>" built from
//   the session's main-loop model and the main transcript's streamed-token
//   counter (the current turn's ↓ tokens, the same figure the spinner shows;
//   it keeps the last turn's value while idle).
//
// Model ids shorten to their family word: "claude-fable-5[1m]" → "fable",
// "us.anthropic.claude-opus-4-6-..." → "opus" (the family word follows
// "claude-" wherever a provider prefix puts it). An id with no "claude-"
// segment — including a bare alias like "opus" — shows as-is minus any
// [1m] suffix.
//
// Every site the patch touches — the row-status builder, the strip
// component, the main row's component — lives in one module of the
// code-split bundle, so the injected helpers are plain module-scope function
// declarations and the probed names resolve in the scope that uses them.
//
// Anchors are structural regexes over the minified bundle (variable names
// change per build); any match count other than exactly 1 fails loudly so the
// wrapper aborts before repack and the binary stays untouched.
import { readFileSync, writeFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: agent-list-models.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

function fail(label, detail) {
  console.error(`ERROR: agent-list-models: ${label}: ${detail} — bundle layout changed, refusing`);
  process.exit(1);
}

function replaceOne(label, regex, replacement) {
  const matches = [...js.matchAll(regex)];
  if (matches.length !== 1) fail(label, `${matches.length} matches, expected exactly 1`);
  js = js.replace(regex, replacement);
  console.log(`agent-list-models: ${label} patched`);
}

for (const name of ["__almShort", "__almInner", "__almMM", "__almMS"]) {
  if (js.includes(name)) fail("helper injection", `identifier ${name} already present`);
}

// Subagent rows: every row's right-hand status is built by one function from
// the task-registry record, stock:
//   function KZT(e,t,r,n){let o=e.type==="in_process_teammate"?
//     e.pendingUserMessages.length:e.pendingMessages.length,...}
//   → {elapsed, tokenText, queuedText, queuedCount}
// Wrap it: prefix the record's model onto tokenText, so the join order comes
// out elapsed · model · tokens. The strip's status-column width is measured
// from the same return value, so alignment follows for free. The __almShort
// helper rides in on this edit (function declarations hoist across the
// module).
replaceOne(
  "subagent row status",
  /function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+),([$\w]+)\)\{let ([$\w]+)=\2\.type==="in_process_teammate"\?\2\.pendingUserMessages\.length:\2\.pendingMessages\.length,/g,
  'function __almShort(m){if(typeof m!=="string")return"";' +
    'm=m.replace(/\\[1m\\]/gi,"");' +
    'let w=/claude-(?:\\d+[-.])*([a-z]+)/.exec(m);' +
    "return w?w[1]:m}" +
    'function $1($2,$3,$4,$5){let q=__almInner($2,$3,$4,$5),m=__almShort($2.model);' +
    'if(m)q.tokenText=q.tokenText?m+" \\xB7 "+q.tokenText:m;return q}' +
    'function __almInner($2,$3,$4,$5){let $6=$2.type==="in_process_teammate"?$2.pendingUserMessages.length:$2.pendingMessages.length,',
);

// The strip component's hook block, stock:
//   function $Gl({showWorkflows:e=!1}={}){let t=lt((X)=>X.tasks),r=rA(),...
// Anchored on the component's own showWorkflows prop plus its first hook — the
// tasks selector, which also yields the store hook's minified name — so the
// hooks that follow can come and go. Prepend a main-loop-model subscription:
// unconditional and first, so the hook order stays fixed across renders.
replaceOne(
  "main model hook",
  /function ([$\w]+)\(\{showWorkflows:([$\w]+)=!1\}=\{\}\)\{let ([$\w]+)=([$\w]+)\(\(([$\w]+)\)=>\5\.tasks\),/g,
  "function $1({showWorkflows:$2=!1}={}){let __almMM=$4(($5)=>$5.mainLoopModel),$3=$4(($5)=>$5.tasks),",
);

// The main row (a separate component with no task record) renders inside the
// same strip, stock:
//   r(ESe,{isSelected:b===0,isViewed:u===void 0,labelWidth:te,moreAbove:ce,onClick:()=>cu(x)})
// Pass it a prebuilt status string built from four minified names, each
// probed from its own unique site rather than assumed — a stale name can
// resolve to an unrelated function and crash the whole interface on render:
//   - the transcripts store variable, from its unique assignment
//   - the main agent id getter, from the transcripts lookup keyed on it
//   - the figures object and token formatter, from the subagent status
//     function's "↓ 92.8k tokens" expression
function probe(label, regex) {
  const matches = [...js.matchAll(regex)];
  if (matches.length !== 1) fail(label, `${matches.length} probes, expected exactly 1`);
  return matches[0].slice(1).map((name) => name.replaceAll("$", "$$$$"));
}
{
  const [tr] = probe("transcripts store", /,([$\w]+)=[$\w]+\.getState\(\)\.transcripts,/g);
  const [mainId] = probe("main agent id getter", /\.transcripts\[([$\w]+)\(\)\]/g);
  const [figures, fmtTokens] = probe(
    "token status expression",
    /\.progress\?\.lastActivity\?([$\w]+)\.arrowDown:\1\.arrowUp,[$\w]+=[$\w]+!==void 0&&[$\w]+>0\?`\$\{[$\w]+\} \$\{([$\w]+)\([$\w]+\)\} tokens`/g,
  );
  replaceOne(
    "main row status prop",
    /&&([$\w]+)\(([$\w]+),\{isSelected:([$\w]+)===0,isViewed:([$\w]+)===void 0,labelWidth:([$\w]+),moreAbove:([$\w]+),onClick:/g,
    "&&$1($2,{mainStatus:(function(){" +
      `let m=__almShort(__almMM),k=${tr}[${mainId}()]?.progress?.tokenCount;` +
      `return[m,k>0?${figures}.arrowDown+" "+${fmtTokens}(k)+" tokens":""].filter(Boolean).join(" \\xB7 ")})(),` +
      "isSelected:$3===0,isViewed:$4===void 0,labelWidth:$5,moreAbove:$6,onClick:",
  );
}

// The main row component itself, stock:
//   {isSelected:t7e,isViewed:SN,labelWidth:Z2t,moreAbove:o7e,onClick:zye}=J2t,
//   [n7e,r7e]=E(!1),Yye=...pointer...,Xye=...circle,
//   bK=o7e>0?`${lg} ${o7e} more`:""
// Its right side is already right-aligned (justifyContent:"space-between")
// and memoized on bK's value, so folding the status into bK needs no memo
// surgery.
replaceOne(
  "main row status render",
  /\{isSelected:([$\w]+),isViewed:([$\w]+),labelWidth:([$\w]+),moreAbove:([$\w]+),onClick:([$\w]+)\}=([$\w]+),(\[[$\w]+,[$\w]+\]=[$\w]+(?:\.useState)?\(!1\),[$\w]+=\1\|\|[$\w]+\?[$\w]+\.pointer\+" ":"  ",[$\w]+=\2\?[$\w]+:[$\w]+\.circle,)([$\w]+)=\4>0\?`\$\{([$\w]+)\} \$\{\4\} more`:""/g,
  '{isSelected:$1,isViewed:$2,labelWidth:$3,moreAbove:$4,onClick:$5,mainStatus:__almMS}=$6,$7$8=[__almMS||"",$4>0?`${$9} ${$4} more`:""].filter(Boolean).join(" \\xB7 ")',
);

writeFileSync(jsPath, js);
