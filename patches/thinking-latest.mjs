#!/usr/bin/env node
// thinking-latest: the collapsed read/search group row keeps a one-line
// summary of its most recent thinking block — first line of the block,
// ellipsis when cut off — visible after the turn completes.
//
// Stock draws such a line only while the group is streaming, and from the
// group's latestThinkingSummary field, which the transcript grouper clears on
// the next collapsible tool call:
//
//   ye=<hint>(ce,<cap>),he=<linger>(s?e.latestThinkingSummary:void 0,<ms>),
//   Ce=s&&he!==void 0,Pe=Ce?he:ye;
//   ...
//   s&&Pe!==void 0&&<jsx>(<Box>,{flexDirection:"row",children:[
//     <"  ⎿  " gutter>,
//     ...Ce?<one line, GtT(Pe,columns-5,10)>:<hint lines>...]})
//
// (s is isActiveGroup; GtT wrap-truncates to a row budget and appends "…".)
// Once the turn completes the row disappears, and the thinking is invisible
// until the row is clicked into its expanded view.
//
// The patch changes only this collapsed path; the click expansion and
// transcript mode are untouched:
//
// - The summary text is computed from the group's own message list — the last
//   thinking block, whitespace-collapsed — instead of latestThinkingSummary,
//   so it survives both the turn completing and the grouper's clearing.
// - The row and its thinking branch are un-gated from isActiveGroup, so the
//   line persists once the turn is done. The tool display hints the same row
//   shows stay streaming-only, and a group whose thinking line is showing
//   never switches back to a tool hint.
// - The thinking line's row budget drops from 10 wrapped rows to 1, so it is
//   the block's first line with "…" when cut off.
// - The line renders through the plain Text component instead of the Markdown
//   one. Only plain Text reads the row-hover context that un-dims dim text,
//   so this makes the thinking line brighten on hover together with the rest
//   of the row; a one-line whitespace-collapsed preview loses nothing by
//   skipping Markdown.
//
// thinking-no-fold keeps thinking messages out of these groups entirely,
// which would leave this patch nothing to render — apply-display-patches.sh
// refuses the combination.
import { readFileSync, writeFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: thinking-latest.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

const fail = (msg) => {
  console.error(`ERROR: thinking-latest: ${msg}`);
  process.exit(1);
};

function matchOne(label, regex) {
  const matches = [...js.matchAll(regex)];
  if (matches.length !== 1)
    fail(
      `${label}: ${matches.length} matches, expected exactly 1 — bundle layout changed, refusing`,
    );
  return matches[0];
}

function spliceOne(label, regex, build) {
  const m = matchOne(label, regex);
  js = js.slice(0, m.index) + build(m) + js.slice(m.index + m[0].length);
  console.log(`thinking-latest: ${label} patched`);
}

// The component's destructuring names the group's message list. Anchored on
// the group record's own field names — only the group row destructures
// searchCount through messages in one pattern.
const header = matchOne(
  "group row destructuring",
  /\{searchCount:[$\w]+,readCount:[$\w]+,listCount:[$\w]+,replCount:[$\w]+,memorySearchCount:[$\w]+,memoryReadCount:[$\w]+,memoryWriteCount:[$\w]+,messages:([$\w]+)\}=[$\w]+/g,
);
const messages = header[1];

// The last thinking block in the group, collapsed to one line. Same walk as
// the row's expanded view: direct assistant entries plus grouped_tool_use
// members, last non-empty thinking wins.
const lastThinking =
  `(()=>{let zzT;for(let zzM of ${messages}){` +
  `let zzA=zzM.type==="assistant"?[zzM]:zzM.type==="grouped_tool_use"?zzM.messages:[];` +
  `for(let zzN of zzA){let zzC=zzN.message.content[0];` +
  `if(zzC?.type==="thinking"&&zzC.thinking?.trim())zzT=zzC.thinking.trim().replace(/\\s+/g," ")}}` +
  `return zzT})()`;

// Summary source and gates, one adjacent run. latestThinkingSummary is read
// into the row's hint slot in exactly one place.
let activeFlag, thinkingFlag, hintText;
spliceOne(
  "summary source and gate",
  /([$\w]+)=([$\w]+)\(([$\w]+)\?([$\w]+)\.latestThinkingSummary:void 0,([$\w]+)\),([$\w]+)=\3&&\1!==void 0,([$\w]+)=\6\?\1:([$\w]+);/g,
  (m) => {
    const [, he, linger, s, , ms, ce, pe, ye] = m;
    activeFlag = s;
    thinkingFlag = ce;
    hintText = pe;
    return `${he}=${linger}(${lastThinking},${ms}),${ce}=${he}!==void 0,${pe}=${ce}?${he}:${ye};`;
  },
);

// The row's render guard, anchored on the gutter cell markup that follows it.
// Thinking lines show always; tool display hints stay streaming-only.
spliceOne(
  "row render guard",
  new RegExp(
    `\\b${activeFlag}&&${hintText}!==void 0&&([$\\w]+\\.jsxs\\([$\\w]+,\\{flexDirection:"row",children:\\[[$\\w]+\\.jsx\\([$\\w]+,\\{width:5,flexShrink:0)`,
    "g",
  ),
  (m) => `(${thinkingFlag}||${activeFlag})&&${hintText}!==void 0&&${m[1]}`,
);

// The plain Text component, named by the "  ⎿  " gutter cells of the group
// row's sub-rows. Several sub-rows carry one; they must all name the same
// component.
const gutters = [
  ...js.matchAll(
    /[$\w]+\.jsx\(([$\w]+),\{"aria-hidden":!0,dimColor:!0,children:"  \\u23BF  "\}\)/g,
  ),
];
const gutterNames = new Set(gutters.map((m) => m[1]));
if (gutterNames.size !== 1)
  fail(
    `gutter cells: [${[...gutterNames]}] from ${gutters.length} matches, expected one shared component — bundle layout changed, refusing`,
  );
const plainText = gutters[0][1];

// The thinking line: row budget drops to 1 — first line only, "…" when cut
// off — and the Markdown component is swapped for plain Text so the line
// un-dims on row hover.
spliceOne(
  "one-line hoverable render",
  /([$\w]+)\.jsx\(([$\w]+),\{dimColor:!0,italic:!0,children:([$\w]+)\(([$\w]+),([$\w]+)-([$\w]+),([$\w]+)\)\}\):\4\.split/g,
  (m) =>
    `${m[1]}.jsx(${plainText},{dimColor:!0,italic:!0,children:${m[3]}(${m[4]},${m[5]}-${m[6]},1)}):${m[4]}.split`,
);

writeFileSync(jsPath, js);
