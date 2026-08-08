#!/usr/bin/env node
// thinking-no-fold: keep a thinking block as its own transcript entry instead
// of rolling it into the adjacent collapsed read/search group.
//
// The transcript grouper walks the message list and accumulates read, search,
// list and memory tool calls into one `collapsed_read_search` entry, which
// renders as a single summary row. Thinking has its own branch in that walk:
//
//   else if(<queuedCommand>(c))<flush>(),<out>.push(c);
//   else if(<thought>!==void 0){
//     if(<group>.latestThinkingSummary=<thought>.text.trim().replace(/\s+/g," "),
//        <prev>!==void 0){...<group>.thoughtForMs+=Math.min(<delta>,<cap>)}
//     <group>.messages.push(<thought>.message)}
//
// — the thinking message joins the open group and contributes the elapsed time
// the group's row shows as "Thought for Ns · ctrl+o to expand". A turn that
// thinks and then answers, with no tool calls at all, still produces such a
// group: the thinking message alone opens it.
//
// The patch rewrites that branch to the same shape the grouper uses for any
// entry it will not group: flush the open group, then push the thinking message
// to the top level. It therefore renders through the normal thinking path —
// which thinking-visibility keeps visible and expanded — and the group's
// thinking fields are never populated, so no "Thought for" row appears.
//
// One consequence: the live one-line thinking summary that stock draws on the
// group row while a turn streams (settings.showThinkingSummaries) has no group
// to sit on. The thinking message itself streams in its place.
import { readFileSync, writeFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: thinking-no-fold.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

function replaceOne(label, regex, replacement) {
  const matches = [...js.matchAll(regex)];
  if (matches.length !== 1) {
    console.error(
      `ERROR: thinking-no-fold: ${label}: ${matches.length} matches, expected exactly 1 — bundle layout changed, refusing`,
    );
    process.exit(1);
  }
  js = js.replace(regex, replacement);
  console.log(`thinking-no-fold: ${label} patched`);
}

// Anchored on the two group fields only this branch writes —
// latestThinkingSummary and thoughtForMs — and on the whitespace-collapsing
// regex literal between them. The preceding clause is matched too, purely to
// name the flush function and the output array the replacement needs; they are
// not otherwise in scope of a regex over minified code.
replaceOne(
  "thinking grouper branch",
  /else if\(([$\w]+)\(([$\w]+)\)\)([$\w]+)\(\),([$\w]+)\.push\(\2\);else if\(([$\w]+)!==void 0\)\{if\(([$\w]+)\.latestThinkingSummary=\5\.text\.trim\(\)\.replace\(\/\\s\+\/g," "\),([$\w]+)!==void 0\)\{let ([$\w]+)=Date\.parse\(\2\.timestamp\)-Date\.parse\(\7\);if\(Number\.isFinite\(\8\)&&\8>0\)\6\.thoughtForMs\+=Math\.min\(\8,[$\w]+\)\}\6\.messages\.push\(\5\.message\)\}/g,
  "else if($1($2))$3(),$4.push($2);else if($5!==void 0)$3(),$4.push($2);",
);

writeFileSync(jsPath, js);
