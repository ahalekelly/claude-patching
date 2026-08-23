#!/usr/bin/env node
// tool-defer-whitelist: let CLAUDE_CODE_IMMEDIATE_TOOLS name tools that must
// ship their full schema in the first request instead of being deferred behind
// ToolSearch.
//
// With tool search on, Claude Code defers every MCP tool unconditionally and
// every builtin that declares shouldDefer. That is the right default for a
// large tool pool, but a handful of tools are worth their tokens in every
// session — and stock offers no way to say so.
//
// The patch adds a first check to the deferral predicate: a tool whose name
// appears in the comma- or space-separated CLAUDE_CODE_IMMEDIATE_TOOLS
// environment variable is never deferred. It runs before the isMcp branch, so
// the whitelist reaches MCP tools too. Set it in settings.json's `env` block to
// have it apply to every session.
//
// Anchor: the predicate is reached through the module's export map
// (isDeferredTool), which gives its minified name; the function body is then
// pinned by the three checks that must precede our insertion point.
import { readFileSync, writeFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: tool-defer-whitelist.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

const fail = (msg) => {
  console.error(`ERROR: tool-defer-whitelist: ${msg}`);
  process.exit(1);
};

function only(label, regex) {
  const matches = [...js.matchAll(regex)];
  if (matches.length !== 1)
    fail(`${label}: ${matches.length} matches, expected exactly 1 — bundle layout changed, refusing`);
  return matches[0];
}

const name = only("isDeferredTool export", /isDeferredTool:\(\)=>([$\w]+)[,}]/g)[1];
// The head of the predicate: the always-load escape, the non-deferrable-builtin
// list, and the MCP branch our check has to precede.
const head = only(
  "deferral predicate",
  new RegExp(
    `function ${name.replace(/\$/g, "\\$")}\\(([$\\w]+)\\)\\{if\\(\\1\\.alwaysLoad===!0\\)return!1;if\\([$\\w]+\\(\\)\\.includes\\(\\1\\.name\\)\\)return!1;if\\(\\1\\.isMcp===!0\\)return!0;`,
    "g",
  ),
);

const tool = head[1];
const insertAt = head.index + `function ${name}(${tool}){`.length;
const check =
  `if((process.env.CLAUDE_CODE_IMMEDIATE_TOOLS??"").split(/[,\\s]+/).includes(${tool}.name))return!1;`;
js = js.slice(0, insertAt) + check + js.slice(insertAt);

writeFileSync(jsPath, js);
console.log("tool-defer-whitelist: CLAUDE_CODE_IMMEDIATE_TOOLS now exempts tools from deferral");
