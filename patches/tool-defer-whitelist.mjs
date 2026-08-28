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
// Anchor: the head of the predicate — the always-load escape and the MCP
// branch our check has to precede, separated by the brace-free run of the
// non-deferrable-builtin check between them. Those two property names pin it.
// The match is then proved to be the real deferral predicate by following the
// public isDeferredTool export back to it:
// the facade module re-exports a binding it imports from the defining module,
// whose export map names the matched function.
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

const esc = (s) => s.replace(/\$/g, "\\$");

// Text of the module containing `at`, and the module's file name. Modules are
// concatenated in load order, each behind a `//__CHUNK__ <name>` marker line.
function chunkAt(at) {
  const marker = js.lastIndexOf("\n//__CHUNK__ ", at);
  if (marker === -1) fail("no chunk marker precedes the match — refusing");
  const nameEnd = js.indexOf("\n", marker + 1);
  let end = js.indexOf("\n//__CHUNK__ ", nameEnd);
  if (end === -1) end = js.length;
  return { name: js.slice(marker + 13, nameEnd), text: js.slice(nameEnd + 1, end) };
}

function onlyIn(label, text, regex) {
  const matches = [...text.matchAll(regex)];
  if (matches.length !== 1)
    fail(`${label}: ${matches.length} matches, expected exactly 1 — bundle layout changed, refusing`);
  return matches[0];
}

// The head of the predicate: the always-load escape and the MCP branch our
// check has to precede.
const head = only(
  "deferral predicate",
  /function ([$\w]+)\(([$\w]+)\)\{if\(\2\.alwaysLoad===!0\)return!1;[^{}]{0,80}if\(\2\.isMcp===!0\)return/g,
);
const name = head[1];

// Prove the match is the tool-search deferral predicate and not a lookalike:
// the module that publishes isDeferredTool imports that binding from the
// module holding the match, which exports the matched function under it. Each
// import and export entry is bare whenever its local and published names
// agree, so both spellings are accepted.
{
  const exported = only("isDeferredTool export", /([$\w]+) as isDeferredTool[,}]/g);
  const facade = chunkAt(exported.index);
  const published = esc(exported[1]);
  const imported = onlyIn(
    "facade import of the deferral predicate",
    facade.text,
    new RegExp(
      `import\\{[^{}]*?(?:([$\\w]+) as ${published}|(?<![$\\w])(${published}))[,}][^{}]*?\\}from"[^"]*?/([^"/]+\\.js)"`,
      "g",
    ),
  );
  const local = esc(imported[1] ?? imported[2]);
  const owner = chunkAt(head.index);
  if (imported[3] !== owner.name)
    fail(
      `isDeferredTool comes from ${imported[3]} but the predicate matched in ${owner.name} — refusing`,
    );
  const reexport = onlyIn(
    "defining module's export of the predicate",
    (owner.text.match(/export\{[^{}]*\}/g) ?? []).join(""),
    new RegExp(`(?:([$\\w]+) as ${local}|(?<![$\\w])(${local}))[,}]`, "g"),
  );
  const resolved = reexport[1] ?? reexport[2];
  if (resolved !== name)
    fail(
      `isDeferredTool resolves to ${resolved}, but the predicate matched is ${name} — refusing`,
    );
}

const tool = head[2];
const insertAt = head.index + `function ${name}(${tool}){`.length;
const check =
  `if((process.env.CLAUDE_CODE_IMMEDIATE_TOOLS??"").split(/[,\\s]+/).includes(${tool}.name))return!1;`;
js = js.slice(0, insertAt) + check + js.slice(insertAt);

writeFileSync(jsPath, js);
console.log("tool-defer-whitelist: CLAUDE_CODE_IMMEDIATE_TOOLS now exempts tools from deferral");
