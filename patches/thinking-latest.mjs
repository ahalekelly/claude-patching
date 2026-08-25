#!/usr/bin/env node
// thinking-latest: the collapsed read/search group row keeps a one-line
// summary of its most recent thinking block — first line of the block,
// ellipsis when cut off — visible after the turn completes.
//
// Stock draws such a line only while the group is streaming, and from the
// group's latestThinkingSummary field, which the transcript grouper clears on
// the next collapsible tool call:
//
//   <hint>=<cap>(<displayHint>,<n>),<summary>=<linger>(<active>&&!<brief>?
//     e.latestThinkingSummary:void 0,<ms>),<isThinking>=<active>&&<summary>!==void 0,
//   <line>=<isThinking>?<summary>:<hint>;
//   ...
//   <active>&&<line>!==void 0&&<jsxs>(<Box>,{flexDirection:"row",children:[
//     <"  ⎿  " gutter cell>,
//     ...<isThinking>?<one line, <trunc>(<line>,columns-5,10)>:<hint lines>...]})
//
// (<active> is isActiveGroup; <trunc> wrap-truncates to a row budget and
// appends "…".)
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

const esc = (s) => s.replace(/\$/g, "\\$");

const fail = (msg) => {
  console.error(`ERROR: thinking-latest: ${msg}`);
  process.exit(1);
};

// Every site this patch reads or rewrites has to live in one module: the
// bundle is a concatenation of modules behind `//__CHUNK__ <name>` marker
// lines, and injected code can only name bindings from the module it lands in.
let owner;
function sameModule(label, at) {
  const marker = js.lastIndexOf("\n//__CHUNK__ ", at);
  if (marker === -1) fail(`${label}: no module marker precedes the match — refusing`);
  const name = js.slice(marker + 13, js.indexOf("\n", marker + 1));
  if (owner === undefined) owner = name;
  else if (name !== owner)
    fail(`${label} is in ${name} but this patch's other sites are in ${owner} — refusing`);
}

function matchOne(label, regex) {
  const matches = [...js.matchAll(regex)];
  if (matches.length !== 1)
    fail(
      `${label}: ${matches.length} matches, expected exactly 1 — bundle layout changed, refusing`,
    );
  sameModule(label, matches[0].index);
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
// into the row's hint slot in exactly one place, gated on the group being
// active and the turn not being a live brief:
//
//   <summary>=<linger>(<active>&&!<brief>?e.latestThinkingSummary:void 0,<ms>),
//   <isThinking>=<active>&&<summary>!==void 0,<line>=<isThinking>?<summary>:<hint>,
//
// Both gates go with the source they guarded; the brief flag stays bound ahead
// of the run for whatever else reads it.
let activeFlag, thinkingFlag, hintText;
spliceOne(
  "summary source and gate",
  /([$\w]+)=([$\w]+)\(([$\w]+)&&!([$\w]+)\?([$\w]+)\.latestThinkingSummary:void 0,([$\w]+)\),([$\w]+)=\3&&\1!==void 0,([$\w]+)=\7\?\1:([$\w]+)([,;])/g,
  (m) => {
    const [, he, linger, s, , , ms, ce, pe, ye, sep] = m;
    activeFlag = s;
    thinkingFlag = ce;
    hintText = pe;
    return `${he}=${linger}(${lastThinking},${ms}),${ce}=${he}!==void 0,${pe}=${ce}?${he}:${ye}${sep}`;
  },
);

// The row's render guard, anchored on the gutter cell markup that follows it:
// the row opens with a width-5 cell holding the "  \u23BF  " glyph, which also
// names the plain Text component the thinking line is re-rendered through.
// Thinking lines show always; tool display hints stay streaming-only.
let plainText;
spliceOne(
  "row render guard",
  new RegExp(
    `(?<![$\\w])${esc(activeFlag)}&&${esc(hintText)}!==void 0&&` +
      `([$\\w]+\\(([$\\w]+),\\{flexDirection:"row",children:\\[[$\\w]+\\(\\2,\\{width:5,flexShrink:0,` +
      `children:[$\\w]+\\(([$\\w]+),\\{"aria-hidden":!0,dimColor:!0,children:"  \\\\u23BF  "\\}\\)\\}\\))`,
    "g",
  ),
  (m) => {
    plainText = m[3];
    return `(${thinkingFlag}||${activeFlag})&&${hintText}!==void 0&&${m[1]}`;
  },
);

// The thinking line: row budget drops to 1 — first line only, "…" when cut
// off — and the Markdown component is swapped for the plain Text component
// taken from the row's own gutter cell, so the line un-dims on row hover.
spliceOne(
  "one-line hoverable render",
  /([$\w]+)\(([$\w]+),\{dimColor:!0,italic:!0,children:([$\w]+)\(([$\w]+),([$\w]+)-([$\w]+),([$\w]+)\)\}\):\4\.split/g,
  (m) =>
    `${m[1]}(${plainText},{dimColor:!0,italic:!0,children:${m[3]}(${m[4]},${m[5]}-${m[6]},1)}):${m[4]}.split`,
);

writeFileSync(jsPath, js);
