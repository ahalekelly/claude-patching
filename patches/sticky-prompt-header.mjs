#!/usr/bin/env node
// sticky-prompt-header: two tweaks to the sticky header line that shows the
// previous prompt above the transcript viewport.
//
// 1. Always-on: stock code only computes the header while the viewport is
//    scrolled up (not following the bottom). Drop that guard so the header
//    shows whenever the previous prompt has scrolled off the top, including
//    while following live output at the bottom. The header still hides when
//    the prompt itself is visible on screen, and click-to-jump still works.
// 2. Contrast: stock header text is color:"subtle" on userMessageBackground —
//    grey on grey. Render it color:"text", bold instead (theme-aware).
//
// Anchors are structural regexes over the minified bundle (variable names
// change per build); any match count other than exactly 1 fails loudly so the
// wrapper aborts before repack and the binary stays untouched.
import { readFileSync, writeFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: sticky-prompt-header.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

function replaceOne(label, regex, replacement) {
  const matches = [...js.matchAll(regex)];
  if (matches.length !== 1) {
    console.error(
      `ERROR: sticky-prompt-header: ${label}: ${matches.length} matches, expected exactly 1 — bundle layout changed, refusing`,
    );
    process.exit(1);
  }
  js = js.replace(regex, replacement);
  console.log(`sticky-prompt-header: ${label} patched`);
}

// The sticky tracker: a bottom-up scan over the mounted range [t,r) computes
// d = first item fully below the viewport top edge, then a walk-back from d-1
// finds the newest prompt scrolled off the top:
//   for(let b=r-1;b>=t;b--){let C=o(b);if(C>=0){if(C<u)break;p=C}d=b}
//   let f=-1,m=null;if(d>0&&!c)for(...)
// Two changes, in one replacement (the guard's d binds it to the loop, so the
// generic loop shape can't false-positive elsewhere):
// - When the scan breaks on its first iteration (the bottom-most item
//   straddles the viewport top — e.g. one tall streaming block), d keeps its
//   initial value t instead of meaning "everything is scrolled off". Set d=r
//   in that case so the walk-back still runs and finds the latest prompt.
// - Drop the &&!c (c = viewport following the bottom) so the header also
//   shows while at the bottom, not only when scrolled up.
replaceOne(
  "always-visible guard",
  /for\(let ([$\w]+)=([$\w]+)-1;\1>=([$\w]+);\1--\)\{let ([$\w]+)=([$\w]+)\(\1\);if\(\4>=0\)\{if\(\4<([$\w]+)\)break;([$\w]+)=\4\}([$\w]+)=\1\}let ([$\w]+)=-1,([$\w]+)=null;if\(\8>0&&!([$\w]+)\)for/g,
  "for(let $1=$2-1;$1>=$3;$1--){let $4=$5($1);if($4>=0){if($4<$6){if($1===$2-1)$8=$2;break}$7=$4}$8=$1}let $9=-1,$10=null;if($8>0)for",
);

// The header's prompt line, drawn as one Text element holding the pointer
// glyph and the prompt text:
//   jsxs(Text,{color:"subtle",wrap:"truncate-end",children:[pointer," ",text]})
// Restyle it like a transcript user message but a step less prominent:
// pointer in "subtle", prompt text in "inactive" — the theme's true
// intermediate grey between "text" and "subtle" in both light and dark
// themes (dimColor is unusable here: SGR faint rendering is terminal-
// dependent and observed to make the text MORE prominent), same background.
// The element factory and the Text component are both taken from the match, so
// nothing is written by its minified name; each nested element passes its
// child as a one-element array, which is what that factory expects.
replaceOne(
  "header contrast",
  /([$\w]+)\(([$\w]+),\{color:"subtle",wrap:"truncate-end",children:\[([$\w]+)\.pointer," ",([$\w]+)\]\}\)/g,
  '$1($2,{wrap:"truncate-end",children:[$1($2,{color:"subtle",children:[$3.pointer]})," ",$1($2,{color:"inactive",children:[$4]})]})',
);

writeFileSync(jsPath, js);
