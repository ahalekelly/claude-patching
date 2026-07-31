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

// The sticky tracker's walk-back that finds the prompt scrolled off the top:
//   let f=-1,m=null;if(d>0&&!c)for(...)
// where c = viewport is following the bottom. Drop the !c so the walk-back
// (and thus the header) also runs while at the bottom.
replaceOne(
  "always-visible guard",
  /let ([$\w]+)=-1,([$\w]+)=null;if\(([$\w]+)>0&&!([$\w]+)\)for/g,
  "let $1=-1,$2=null;if($3>0)for",
);

// The header's prompt text inside the QHa-style component:
//   jsxs(h,{color:"subtle",wrap:"truncate-end",children:[pointer," ",text]})
replaceOne(
  "header contrast",
  /color:"subtle",wrap:"truncate-end"/g,
  'color:"text",bold:!0,wrap:"truncate-end"',
);

writeFileSync(jsPath, js);
