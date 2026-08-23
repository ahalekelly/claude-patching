#!/usr/bin/env node
// toolsearch-visibility: show ToolSearch calls in the transcript.
//
// Stock Claude Code hides them two ways, and both have to go:
//
// 1. The ToolSearch tool definition renders nothing —
//      renderToolUseMessage(){return null},userFacingName:()=>""
//    so even an un-collapsed call draws an empty row. Patched, the tool names
//    itself and renders its query, like every other tool.
// 2. In fullscreen mode the display classifier special-cases ToolSearch to
//    isAbsorbedSilently, which drops the call from the transcript entirely.
//    Patched, that branch is removed and ToolSearch falls through to the
//    generic path, where a tool with no isSearchOrReadCommand is simply not
//    collapsible.
//
// Both edits are anchored off the "ToolSearch" tool-name constant, so they
// cannot land on some other tool that happens to share a code shape.
import { readFileSync, writeFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: toolsearch-visibility.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

const fail = (msg) => {
  console.error(`ERROR: toolsearch-visibility: ${msg}`);
  process.exit(1);
};

function only(label, regex) {
  const matches = [...js.matchAll(regex)];
  if (matches.length !== 1)
    fail(`${label}: ${matches.length} matches, expected exactly 1 — bundle layout changed, refusing`);
  return matches[0];
}

// The minified binding that holds the tool's name, and the tool definition it names.
const toolName = only("ToolSearch name constant", /([$\w]+)="ToolSearch"/g)[1];
const definition = only(
  "ToolSearch tool definition",
  new RegExp(`name:${toolName.replace(/\$/g, "\\$")},maxResultSizeChars:`, "g"),
);

// 1. The definition's null renderer. Required to sit inside the tool object
//    that the definition anchor opened, so a null renderer elsewhere in the
//    bundle can never be mistaken for this one.
const renderer = only(
  "ToolSearch renderer",
  /renderToolUseMessage\(\)\{return null\},userFacingName:\(\)=>""/g,
);
const distance = renderer.index - definition.index;
if (distance < 0 || distance > 20000)
  fail(
    `the null renderer is ${distance} chars from the ToolSearch definition — not the same tool object, refusing`,
  );
js =
  js.slice(0, renderer.index) +
  'renderToolUseMessage(e){return typeof e?.query==="string"?e.query:""},userFacingName:()=>"ToolSearch"' +
  js.slice(renderer.index + renderer[0].length);

// 2. The fullscreen absorb branch, anchored on the ten display flags it returns.
const absorb = only(
  "fullscreen absorb branch",
  new RegExp(
    `if\\([$\\w]+\\(\\)&&[$\\w]+===${toolName.replace(/\$/g, "\\$")}\\)return\\{isCollapsible:!0,isSearch:!1,isRead:!1,isList:!1,isREPL:!1,isMemoryWrite:!1,isScratchpadWrite:!1,isWorkshopWrite:!1,isAbsorbedSilently:!0\\};`,
    "g",
  ),
);
js = js.slice(0, absorb.index) + js.slice(absorb.index + absorb[0].length);

writeFileSync(jsPath, js);
console.log("toolsearch-visibility: ToolSearch calls now render with their query");
