#!/usr/bin/env node
// no-collapse-reads: render every Read/Grep/Glob/Bash call on its own
// transcript line instead of rolling consecutive ones up into "Read 3 files"
// or "ran 4 shell commands".
//
// Claude Code classifies each tool call in a `getToolDisplayKind`-style helper
// that returns a flags object — {isCollapsible,isSearch,isRead,isList,isREPL,
// isMemoryWrite,isScratchpadWrite,isWorkshopWrite,isAbsorbedSilently,isBash}.
// The transcript groups any call whose isCollapsible is true into a single
// summary row. The helper's final branch, reached by every tool that declares
// isSearchOrReadCommand, computes:
//
//   let o=n.isSearchOrReadCommand(t??{}),i=o.isList??!1,
//       s=o.isSearch||o.isRead||i,a=<bashNames>.includes(e);
//   return{isCollapsible:s||(<fullscreen>()?a:!1),...}
//
// The patch replaces the whole isCollapsible expression with false, so
// search, read, list and shell calls all render individually. Every other
// branch of the helper is untouched, so MCP calls, memory writes and the REPL
// keep their stock display. With no shell calls in the groups, the group
// row's git-op summaries ("committed <sha>", "pushed to <branch>") — derived
// from grouped Bash calls — no longer appear; the commands themselves render
// instead.
import { readFileSync, writeFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: no-collapse-reads.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

const fail = (msg) => {
  console.error(`ERROR: no-collapse-reads: ${msg}`);
  process.exit(1);
};

// Anchored on the flag names the branch produces, not on its control flow: a
// lookalike site would have to build the same ten-flag display record.
const classifier =
  /let ([$\w]+)=([$\w]+)\.isSearchOrReadCommand\(([$\w]+)\?\?\{\}\),([$\w]+)=\1\.isList\?\?!1,([$\w]+)=\1\.isSearch\|\|\1\.isRead\|\|\4,([$\w]+)=([$\w]+)\.includes\(([$\w]+)\);return\{isCollapsible:\5\|\|\(([$\w]+)\(\)\?\6:!1\),isSearch:\1\.isSearch,isRead:\1\.isRead,isList:\4,/g;
const matches = [...js.matchAll(classifier)];
if (matches.length !== 1)
  fail(
    `${matches.length} matches for the search/read display classifier, expected exactly 1 — bundle layout changed, refusing`,
  );

const m = matches[0];
const [, kind, tool, input, isList, isSearchOrRead, isBashName, bashNames, name, fullscreen] = m;
const patched =
  `let ${kind}=${tool}.isSearchOrReadCommand(${input}??{}),${isList}=${kind}.isList??!1,` +
  `${isSearchOrRead}=${kind}.isSearch||${kind}.isRead||${isList},${isBashName}=${bashNames}.includes(${name});` +
  `return{isCollapsible:!1,` +
  `isSearch:${kind}.isSearch,isRead:${kind}.isRead,isList:${isList},`;
js = js.slice(0, m.index) + patched + js.slice(m.index + m[0].length);

writeFileSync(jsPath, js);
console.log("no-collapse-reads: search/read/list/shell tool calls are no longer collapsible");
