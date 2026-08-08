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
// bundle scope).
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
//   let t=st((ae)=>ae.tasks),r=EC(),n=st((ae)=>ae.effortValue)
// Prepend a main-loop-model subscription. Unconditional and first, so the
// hook order stays fixed across renders.
replaceOne(
  "main model hook",
  /let ([$\w]+)=st\(\(([$\w]+)\)=>\2\.tasks\),([$\w]+)=EC\(\),([$\w]+)=st\(\(([$\w]+)\)=>\5\.effortValue\)/g,
  "let __almMM=st(($2)=>$2.mainLoopModel),$1=st(($2)=>$2.tasks),$3=EC(),$4=st(($5)=>$5.effortValue)",
);

// The main row (a separate component with no task record) renders inside the
// same strip, stock:
//   Ks.jsx(D5m,{isSelected:g===0,isViewed:c===void 0,labelWidth:re,moreAbove:$,onClick:()=>Hfe(_)})
// Pass it a prebuilt status string. The transcripts store variable (for the
// main turn's token counter) is probed first from its unique assignment.
{
  const label = "main row status prop";
  const trRe = /,([$\w]+)=([$\w]+)\.getState\(\)\.transcripts,/g;
  const trs = [...js.matchAll(trRe)];
  if (trs.length !== 1) fail(label, `${trs.length} transcripts-store probes, expected exactly 1`);
  const tr = trs[0][1];
  replaceOne(
    label,
    /&&([$\w]+)\.jsx\(([$\w]+),\{isSelected:([$\w]+)===0,isViewed:([$\w]+)===void 0,labelWidth:([$\w]+),moreAbove:([$\w]+),onClick:/g,
    "&&$1.jsx($2,{mainStatus:(function(){" +
      `let m=__almShort(__almMM),k=${tr}[Hi()]?.progress?.tokenCount;` +
      'return[m,k>0?ze.arrowDown+" "+Hd(k)+" tokens":""].filter(Boolean).join(" \\xB7 ")})(),' +
      "isSelected:$3===0,isViewed:$4===void 0,labelWidth:$5,moreAbove:$6,onClick:",
  );
}

// The main row component itself, stock:
//   {isSelected:mZT,isViewed:kHi,labelWidth:orO,moreAbove:hZT,onClick:i5m}=nrO,
//   [gZT,_ZT]=B4.useState(!1),s5m=...pointer...,a5m=...circle,
//   KMl=hZT>0?`${qre} ${hZT} more`:""
// Its right side is already right-aligned (justifyContent:"space-between")
// and memoized on KMl's value, so folding the status into KMl needs no memo
// surgery.
replaceOne(
  "main row status render",
  /\{isSelected:([$\w]+),isViewed:([$\w]+),labelWidth:([$\w]+),moreAbove:([$\w]+),onClick:([$\w]+)\}=([$\w]+),(\[[$\w]+,[$\w]+\]=[$\w]+\.useState\(!1\),[$\w]+=\1\|\|[$\w]+\?[$\w]+\.pointer\+" ":"  ",[$\w]+=\2\?[$\w]+:[$\w]+\.circle,)([$\w]+)=\4>0\?`\$\{([$\w]+)\} \$\{\4\} more`:""/g,
  '{isSelected:$1,isViewed:$2,labelWidth:$3,moreAbove:$4,onClick:$5,mainStatus:__almMS}=$6,$7$8=[__almMS||"",$4>0?`${$9} ${$4} more`:""].filter(Boolean).join(" \\xB7 ")',
);

writeFileSync(jsPath, js);
