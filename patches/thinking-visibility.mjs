#!/usr/bin/env node
// thinking-visibility: show the model's thinking inline in the normal chat
// view, expanded.
//
// Claude Code renders one assistant content block per `case` of a big switch.
// The "thinking" case opens with a mode guard:
//
//   case"thinking":{if(!<transcript>&&!<verbose>){return null}
//     ...jsx(<ThinkingBlock>,{addMargin:...,param:...,
//                             isTranscriptMode:<transcript>,verbose:<verbose>})
//
// so thinking is drawn only in transcript mode (ctrl+o) or under --verbose, and
// the normal view drops it. Inside the component the same isTranscriptMode flag
// picks the layout: true renders the thinking text in full over as many lines
// as it needs, false squashes it to a single whitespace-collapsed line.
//
// The patch drops the guard and pins isTranscriptMode to true, so a thinking
// block renders in every mode and always in its expanded form. Nothing else
// about the block changes — same margin, same dim italic label.
//
// redacted_thinking, whose neighbouring case carries the same guard, is left
// alone: it has no text to show, only a placeholder.
//
// A thinking block that the transcript grouper folded into a collapsed
// read/search group never reaches this switch — it renders as a "Thought for
// Ns" pill instead. thinking-no-fold is the patch that stops that folding; the
// two are designed to be applied together.
import { readFileSync, writeFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: thinking-visibility.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

function replaceOne(label, regex, replacement) {
  const matches = [...js.matchAll(regex)];
  if (matches.length !== 1) {
    console.error(
      `ERROR: thinking-visibility: ${label}: ${matches.length} matches, expected exactly 1 — bundle layout changed, refusing`,
    );
    process.exit(1);
  }
  js = js.replace(regex, replacement);
  console.log(`thinking-visibility: ${label} patched`);
}

// Anchored on the case label plus the component's own prop names — a lookalike
// site would have to render a block with the same addMargin/param/
// isTranscriptMode/verbose signature under a "thinking" case. The memo
// bookkeeping between them is carried through verbatim as groups 3 and 4, so
// the compiler's cache slots keep their meaning.
replaceOne(
  "thinking block render",
  /case"thinking":\{if\(!([$\w]+)&&!([$\w]+)\)\{return null\}(let [$\w]+;if\([^)]*\)[$\w]+=[$\w]+\.jsx\([$\w]+,\{addMargin:[$\w]+,param:[$\w]+,)isTranscriptMode:\1(,verbose:\2\}\))/g,
  "case\"thinking\":{$3isTranscriptMode:!0$4",
);

writeFileSync(jsPath, js);
