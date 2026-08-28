#!/usr/bin/env node
// sticky-prompt-header: three changes to the sticky header line that shows
// the previous prompt above the transcript viewport.
//
// 1. Always-on: stock code only computes the header while the viewport is
//    scrolled up (not following the bottom). Drop that guard so the header
//    shows whenever the previous prompt has scrolled off the top, including
//    while following live output at the bottom. The header still hides when
//    the prompt itself is visible on screen, and click-to-jump still works.
// 2. Contrast: stock header text is color:"subtle" on userMessageBackground —
//    grey on grey. Render the prompt text in "inactive" instead, keeping the
//    pointer glyph "subtle".
// 3. Un-freeze the viewport top edge: the React Compiler memoized the
//    tracker's getScrollTop/getPendingDelta reads on the scroll handle's
//    identity, and the handle is a stable object, so the viewport top the
//    whole tracker compares against is frozen at its first-render value of 0.
//    Stock's own header can therefore never match a scrolled-off prompt —
//    the feature is broken in stock — and changes 1 and 2 are inert without
//    this one. Re-read both values live at their single point of use.
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

const fail = (msg) => {
  console.error(`ERROR: sticky-prompt-header: ${msg}`);
  process.exit(1);
};

const esc = (s) => s.replace(/\$/g, "\\$");

function matchOne(label, regex) {
  const matches = [...js.matchAll(regex)];
  if (matches.length !== 1)
    fail(`${label}: ${matches.length} matches, expected exactly 1 — bundle layout changed, refusing`);
  return matches[0];
}

function spliceOne(label, regex, build) {
  const m = matchOne(label, regex);
  js = js.slice(0, m.index) + build(m) + js.slice(m.index + m[0].length);
  console.log(`sticky-prompt-header: ${label} patched`);
}

// The sticky tracker. A bottom-up scan over the mounted range [start,end)
// computes firstVisible = the first item fully below the viewport top edge,
// then a walk-back from firstVisible-1 finds the newest prompt scrolled off
// the top. The compiler splits the two across memo-cache blocks, so they are
// two anchors: the walk-back carries the content — the scratch's promptText
// lookup and the range diagnostic naming firstVisible — and the names it
// captures pin the scan loop to the same tracker.
const walkBack =
  /if\(([$\w]+)>0&&!([$\w]+)\)\{for\(let ([$\w]+)=\1-1;\3>=0;\3--\)\{let ([$\w]+)=([$\w]+)\[\3\];if\(\4===void 0\)[$\w]+\(([$\w]+),\3,\5,`range=\[\$\{([$\w]+)\},\$\{([$\w]+)\}\] firstVisible=\$\{\1\}`\);let ([$\w]+)=([$\w]+)\(([$\w]+)\.promptText,\4\);/g;
const tracker = matchOne("sticky tracker walk-back", walkBack);
const [firstVisible, following, , , , , start, end] = tracker.slice(1);

// When the scan breaks on its first iteration (the bottom-most item straddles
// the viewport top — e.g. one tall streaming block), firstVisible keeps its
// initial value `start` instead of meaning "everything is scrolled off". Set
// it to `end` in that case so the walk-back still runs and finds the latest
// prompt.
let viewportTop;
spliceOne(
  "first-visible scan",
  new RegExp(
    `for\\(let ([$\\w]+)=${esc(end)}-1;\\1>=${esc(start)};\\1--\\)\\{let ([$\\w]+)=([$\\w]+)\\(\\1\\);` +
      `if\\(\\2>=0\\)\\{if\\(\\2<([$\\w]+)\\)\\{break\\}([$\\w]+)=\\2\\}${esc(firstVisible)}=\\1\\}`,
    "g",
  ),
  (m) => {
    const [, i, top, getItemTop, vt, lastAbove] = m;
    viewportTop = vt;
    return (
      `for(let ${i}=${end}-1;${i}>=${start};${i}--){let ${top}=${getItemTop}(${i});` +
      `if(${top}>=0){if(${top}<${viewportTop}){if(${i}===${end}-1)${firstVisible}=${end};break}${lastAbove}=${top}}` +
      `${firstVisible}=${i}}`
    );
  },
);

// Drop the "viewport is following the bottom" guard so the header also shows
// while at the bottom, not only when scrolled up.
spliceOne("always-visible guard", walkBack, (m) =>
  m[0].replace(`if(${firstVisible}>0&&!${following})`, `if(${firstVisible}>0)`),
);

// The tracker's viewport top edge, frozen by compiler memoization:
//   let lS;if(No[4]!==ot.handle)lS=ot.handle?.getScrollTop()??0,
//     No[4]=ot.handle,No[5]=lS;else lS=No[5];
//   let cS;if(No[6]!==ot.handle)cS=ot.handle?.getPendingDelta()??0,
//     No[6]=ot.handle,No[7]=cS;else cS=No[7];
//   let pr=Math.max(0,lS+cS),...
// getScrollTop is not a pure function of the handle, so caching both reads on
// its identity pins pr at 0 and the walk-back's "still on screen" test
// (top+1>=pr) passes for every mounted item. Replace the definition — the
// frozen caches' single point of use — with live reads through the same
// viewport object. Every dependent memo block compares against pr itself
// (No[11]!==pr, No[22]!==pr), so a live pr invalidates them on its own; the
// following-bottom flag is frozen the same way, but the always-visible splice
// removes its only load-bearing use. Both read sites are probed by method
// name, must name the same viewport object, and hand over every identifier
// the definition anchor and the injected code use.
const scrollRead = matchOne(
  "scroll-top read",
  /if\([$\w]+\[\d+\]!==([$\w]+)\.handle\)([$\w]+)=\1\.handle\?\.getScrollTop\(\)\?\?0,/g,
);
const [, viewport, scrollTop] = scrollRead;
const deltaRead = matchOne(
  "pending-delta read",
  /if\([$\w]+\[\d+\]!==([$\w]+)\.handle\)([$\w]+)=\1\.handle\?\.getPendingDelta\(\)\?\?0,/g,
);
if (deltaRead[1] !== viewport)
  fail("pending-delta read: reads a different viewport object than the scroll-top read");
const delta = deltaRead[2];
spliceOne(
  "live viewport top",
  new RegExp(`let ${esc(viewportTop)}=Math\\.max\\(0,${esc(scrollTop)}\\+${esc(delta)}\\),`, "g"),
  () =>
    `let ${viewportTop}=Math.max(0,(${viewport}.handle?.getScrollTop()??0)+(${viewport}.handle?.getPendingDelta()??0)),`,
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
spliceOne(
  "header contrast",
  /([$\w]+)\(([$\w]+),\{color:"subtle",wrap:"truncate-end",children:\[([$\w]+)\.pointer," ",([$\w]+)\]\}\)/g,
  (m) => {
    const [, jsx, Text, glyph, prompt] = m;
    return (
      `${jsx}(${Text},{wrap:"truncate-end",children:[${jsx}(${Text},{color:"subtle",children:[${glyph}.pointer]})," ",` +
      `${jsx}(${Text},{color:"inactive",children:[${prompt}]})]})`
    );
  },
);

writeFileSync(jsPath, js);
