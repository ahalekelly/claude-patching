#!/usr/bin/env node
// toolsearch-visibility: show ToolSearch calls in the transcript.
//
// Stock Claude Code hides them two ways, and both have to go:
//
// 1. The ToolSearch tool definition renders nothing —
//      renderToolUseMessage(){return null},userFacingName:()=>""
//    so even an un-collapsed call draws an empty row. Patched, the tool names
//    itself and renders its query, like every other tool.
// 2. In fullscreen mode the display classifier absorbs ToolSearch alongside
//    a list of other silently absorbed tools. Patched, the condition keeps
//    only that list, so ToolSearch falls through to the generic path, where a
//    tool with no isSearchOrReadCommand is simply not collapsible.
//
// Both edits are anchored off the "ToolSearch" tool-name constant, so they
// cannot land on some other tool that happens to share a code shape.
import { readFileSync, writeFileSync } from "node:fs";
import { bundleTools } from "./lib/bundle.mjs";

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

const { esc, chunkAt, only, onlyIn, importedAs } = bundleTools(() => js, fail);

// The minified binding that holds the tool's name, and the tool definition it names.
const nameConst = only("ToolSearch name constant", /([$\w]+)="ToolSearch"/g);
const toolName = nameConst[1];
const definition = only(
  "ToolSearch tool definition",
  new RegExp(`name:${esc(toolName)},maxResultSizeChars:`, "g"),
);
const nameSite = chunkAt(nameConst.index);
const defSite = chunkAt(definition.index);
if (
  defSite.name !== nameSite.name &&
  importedAs("ToolSearch name", nameConst.index, toolName, defSite) !== toolName
)
  fail(`ToolSearch definition does not import ${toolName} from ${nameSite.name} — refusing`);

// 1. The definition module's null renderer.
const renderer = onlyIn(
  "ToolSearch renderer",
  defSite.text,
  /renderToolUseMessage\(\)\{return null\},userFacingName:\(\)=>""/g,
);
const rendererAt = defSite.start + renderer.index;

// 2. The fullscreen absorb branch, anchored on the ten display flags it returns.
const absorb = only(
  "fullscreen absorb branch",
  /if\(([$\w]+)\(\)&&([$\w]+)===([$\w]+)\|\|([$\w]+)\)return\{isCollapsible:!0,isSearch:!1,isRead:!1,isList:!1,isREPL:!1,isMemoryWrite:!1,isScratchpadWrite:!1,isWorkshopWrite:!1,isAbsorbedSilently:!0,popsOutOnError:\4\};/g,
);
const absorbSite = chunkAt(absorb.index);
if (absorbSite.name === nameSite.name) {
  if (absorb[3] !== toolName)
    fail(`fullscreen absorb branch uses ${absorb[3]}, not ToolSearch name ${toolName} — refusing`);
} else if (
  importedAs("ToolSearch name", nameConst.index, toolName, absorbSite) !== absorb[3]
)
  fail(`fullscreen absorb branch uses ${absorb[3]}, not its ToolSearch import — refusing`);

const rendererReplacement =
  'renderToolUseMessage(e){return typeof e?.query==="string"?e.query:""},userFacingName:()=>"ToolSearch"';
js =
  js.slice(0, rendererAt) +
  rendererReplacement +
  js.slice(rendererAt + renderer[0].length);
console.log("toolsearch-visibility: ToolSearch renderer patched");

const absorbAt =
  absorb.index + (absorb.index > rendererAt ? rendererReplacement.length - renderer[0].length : 0);
const condition = `if(${absorb[1]}()&&${absorb[2]}===${absorb[3]}||${absorb[4]})`;
js =
  js.slice(0, absorbAt) +
  `if(${absorb[4]})` +
  js.slice(absorbAt + condition.length);
console.log("toolsearch-visibility: ToolSearch silent absorption removed");

writeFileSync(jsPath, js);
