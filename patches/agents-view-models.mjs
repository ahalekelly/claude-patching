#!/usr/bin/env node
// agents-view-models: agents-view (FleetView) job rows show which model each
// job runs. The age column gains a "<model> · " prefix ("fable · 3m"), read
// from the job record's --model respawn flag, and the column width math is
// widened to match. Both row renderers are covered — the default column
// layout and the gated simple layout — so a server-side flip of the
// tengu_fleetview_simple gate cannot strand the feature or the test. Jobs
// whose record has no --model flag (e.g. remote rows) show the age alone,
// and terminals narrower than 80 columns skip the prefix entirely rather
// than overflow the fixed column budget.
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
  console.error("usage: agents-view-models.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

function fail(label, detail) {
  console.error(`ERROR: agents-view-models: ${label}: ${detail} — bundle layout changed, refusing`);
  process.exit(1);
}

function replaceOne(label, regex, replacement) {
  const matches = [...js.matchAll(regex)];
  if (matches.length !== 1) fail(label, `${matches.length} matches, expected exactly 1`);
  js = js.replace(regex, replacement);
  console.log(`agents-view-models: ${label} patched`);
}

// Two top-level helpers (function declarations hoist across the bundle
// scope). __avmShort maps a model id/alias to its family word; __avmJobModel
// pulls a job record's --model respawn flag through it.
const HELPERS =
  'function __avmShort(m){if(typeof m!=="string")return"";' +
  'm=m.replace(/\\[1m\\]/gi,"");' +
  'let w=/claude-(?:\\d+[-.])*([a-z]+)/.exec(m);' +
  "return w?w[1]:m}" +
  'function __avmJobModel(s,w){if(!(w>=80))return"";' +
  'let f=s&&s.respawnFlags,i=Array.isArray(f)?f.indexOf("--model"):-1;' +
  'return i>=0?__avmShort(f[i+1]):""}';
for (const name of ["__avmShort", "__avmJobModel"]) {
  if (js.includes(name)) fail("helper injection", `identifier ${name} already present`);
}

// Column widths, stock:
//   function cvv(e,t,r,n){let o=Math.max(ovv,...e.map((l)=>Vt(fNi(l,t(l))))),i=Math.min...
// o is the age column width (Vt = string width, fNi = the age text). Widen it
// by each job's "<model> · " prefix; the detail column is computed from the
// remainder, so it narrows to compensate. The helpers ride in on this edit.
// The terminal width flows to every edit from one source: both row
// renderers are called from the same function whose width local is probed
// below (the simple row's renameWidth prop names it), and cvv's 4th
// parameter receives that same local — so the width gate agrees between
// measurement and drawing by construction.
const widthProbes = [...js.matchAll(/renameWidth:Math\.max\(12,([$\w]+)-/g)];
if (widthProbes.length !== 1)
  fail("width probe", `${widthProbes.length} renameWidth sites, expected exactly 1`);
const W = widthProbes[0][1];

replaceOne(
  "age column width",
  /function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+),([$\w]+)\)\{let ([$\w]+)=Math\.max\(([$\w]+),\.\.\.\2\.map\(\(([$\w]+)\)=>([$\w]+)\(([$\w]+)\(\8,\3\(\8\)\)\)\)\),([$\w]+)=Math\.min/g,
  HELPERS +
    'function $1($2,$3,$4,$5){let $6=Math.max($7,...$2.map(($8)=>$9($10($8,$3($8)))+(__avmJobModel($8.state,$5)?$9(__avmJobModel($8.state,$5)+" \\xB7 "):0))),$11=Math.min',
);

// Default-layout job row, stock:
//   age:fNi(ra,bT.has(ra.id)?$.get(ra.state.sessionId)?.nextAt:void 0)
// The age cell is a right-aligned plain string, so the model prefix lands as
// "fable · 3m" and stays aligned via the width edit above.
replaceOne(
  "job row age",
  /age:([$\w]+)\(([$\w]+),([$\w]+)\.has\(\2\.id\)\?([$\w]+)\.get\(\2\.state\.sessionId\)\?\.nextAt:void 0\)/g,
  `age:(__avmJobModel($2.state,${W})?__avmJobModel($2.state,${W})+" \\xB7 ":"")+$1($2,$3.has($2.id)?$4.get($2.state.sessionId)?.nextAt:void 0)`,
);

// Simple-layout job row (behind CLAUDE_CODE_FLEETVIEW_SIMPLE or the
// tengu_fleetview_simple gate), stock:
//   age:CGr(ra),tokens:snr(ra,ku),state:ku,extra:...
// Its detail line joins free-flowing segments, so prefixing the age string
// is the whole edit.
replaceOne(
  "simple job row age",
  /age:([$\w]+)\(([$\w]+)\),tokens:([$\w]+)\(\2,([$\w]+)\),state:\4,/g,
  `age:(__avmJobModel($2.state,${W})?__avmJobModel($2.state,${W})+" \\xB7 ":"")+$1($2),tokens:$3($2,$4),state:$4,`,
);

writeFileSync(jsPath, js);
