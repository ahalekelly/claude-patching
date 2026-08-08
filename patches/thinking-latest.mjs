#!/usr/bin/env node
// thinking-latest: the collapsed read/search group row shows its most recent
// thinking block in full, instead of the truncated one-line summary stock
// draws while streaming and drops when the turn completes.
//
// The group row component has two render paths. Its verbose path (per-message
// click expansion, transcript mode, --verbose) walks the group's messages and
// renders every thinking block through the ThinkingBlock component:
//
//   if(<block>?.type==="thinking"&&<block>.thinking)
//     return <jsx>.jsx(<Box>,{marginTop:1,children:
//       <jsx>.jsx(<ThinkingBlock>,{param:<block>,addMargin:!1,
//                                  isTranscriptMode:!0,verbose:!0})},<msg>.uuid)
//
// The collapsed path renders the "Thought for Ns, ..." summary row, and under
// it — only while the group is streaming — a single line holding the latest
// thinking text collapsed to whitespace (latestThinkingSummary), truncated to
// the row width. Once the turn completes the thinking is invisible until the
// row is clicked into the verbose path.
//
// The patch changes only the collapsed path:
//
// - The group's most recent thinking block renders in full under the summary
//   row, through the same ThinkingBlock call the verbose path uses. It stays
//   after the turn completes, so the latest thinking is always readable
//   without a click; clicking the row still opens every block, unchanged.
// - The one-line latestThinkingSummary render is dropped — the full block
//   replaces it. The row's non-thinking display hints (the file being read,
//   the pattern being searched) are untouched.
//
// thinking-no-fold keeps thinking messages out of these groups entirely, which
// would leave this patch nothing to render — apply-display-patches.sh refuses
// the combination.
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

// The verbose path's thinking render names the jsx runtime, the Box component
// and the ThinkingBlock component. Anchored on the thinking type guard plus
// the exact prop signature — a lookalike would have to render a keyed
// marginTop:1 box around a param/addMargin/isTranscriptMode/verbose call.
const verbose = matchOne(
  "verbose thinking render",
  /if\(([$\w]+)\?\.type==="thinking"&&\1\.thinking\)return ([$\w]+)\.jsx\(([$\w]+),\{marginTop:1,children:\2\.jsx\(([$\w]+),\{param:\1,addMargin:!1,isTranscriptMode:!0,verbose:!0\}\)\},([$\w]+)\.uuid\)/g,
);
const [, , jsx, box, thinkingBlock] = verbose;

// The component's destructuring names the group's message list. Anchored on
// the group record's own field names — only the group row destructures
// searchCount through messages in one pattern.
const header = matchOne(
  "group row destructuring",
  /\{searchCount:[$\w]+,readCount:[$\w]+,listCount:[$\w]+,replCount:[$\w]+,memorySearchCount:[$\w]+,memoryReadCount:[$\w]+,memoryWriteCount:[$\w]+,messages:([$\w]+)\}=([$\w]+)/g,
);
const [, messages] = header;

// Drop the one-line summary: latestThinkingSummary is read into the row's
// hint slot in exactly one place, guarded by the isActiveGroup flag.
const summary = matchOne(
  "one-line thinking summary",
  /=([$\w]+)\(([$\w]+)\?([$\w]+)\.latestThinkingSummary:void 0,([$\w]+)\)/g,
);
js =
  js.slice(0, summary.index) +
  `=${summary[1]}(void 0,${summary[4]})` +
  js.slice(summary.index + summary[0].length);
console.log("thinking-latest: one-line thinking summary dropped");

// Inject the full latest-thinking render into the collapsed return, right
// after the summary row. Anchored on the row's closing markup followed by the
// memoryOps element — the only children array that sequences the two.
const site = matchOne(
  "collapsed row injection point",
  /\.jsx\(([$\w]+),\{\}\)\]\}\)\]\}\),([$\w]+)\.memoryOps&&/g,
);
const injected =
  `(()=>{let zzLast;for(let zzM of ${messages}){` +
  `let zzArr=zzM.type==="assistant"?[zzM]:zzM.type==="grouped_tool_use"?zzM.messages:[];` +
  `for(let zzN of zzArr){let zzC=zzN.message.content[0];` +
  `if(zzC?.type==="thinking"&&zzC.thinking)zzLast=zzN}}` +
  `return zzLast?${jsx}.jsx(${box},{children:` +
  `${jsx}.jsx(${thinkingBlock},{param:zzLast.message.content[0],addMargin:!1,isTranscriptMode:!0,verbose:!0})},zzLast.uuid):null})(),`;
js =
  js.slice(0, site.index) +
  `.jsx(${site[1]},{})]})]}),` +
  injected +
  `${site[2]}.memoryOps&&` +
  js.slice(site.index + site[0].length);
console.log("thinking-latest: latest thinking block rendered on the collapsed row");

writeFileSync(jsPath, js);
