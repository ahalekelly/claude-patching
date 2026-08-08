#!/usr/bin/env node
// no-collapse-tool-calls: render every Read/Grep/Glob/Bash call on its own
// transcript line instead of rolling consecutive ones up into "Read 3 files"
// or "ran 4 shell commands" — with a keybinding, default ctrl+f, that toggles
// stock folding back on at runtime, whole scrollback included.
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
// The patch makes that isCollapsible a runtime choice: false by default, the
// stock expression when folding is toggled on. Every other branch of the
// helper is untouched, so MCP calls, memory writes and the REPL keep their
// stock display. While unfolded, the group row's git-op summaries
// ("committed <sha>", "pushed to <branch>") — derived from grouped Bash
// calls — do not appear; the commands themselves render instead.
//
// The toggle is the keybinding action "app:toggleToolCallFolding" (rebindable
// in keybindings.json), registered in the Global context beside the
// chat:submit registration the same way agents-view-shortcut wires its
// action. Flipping it must re-render history, not just future rows, so:
//
// - The per-message display-info cache is stamped with a toggle generation
//   and misses when it changes.
// - The transcript grouper runs in a useMemo; a useSyncExternalStore
//   subscription to the toggle generation is appended inside its dependency
//   array (argument expressions evaluate during render, so the hook call is
//   unconditional and stable), which re-renders the component on toggle and
//   regroups the whole message list. The new list identity flows through the
//   virtual message list, re-rendering every row.
//
// This patch applies before agents-view-shortcut, so its insertions into the
// valid-actions list, the Global bindings table and the registration site all
// append after that patch's anchors rather than in front of them.
import { readFileSync, writeFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: no-collapse-tool-calls.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

const fail = (msg) => {
  console.error(`ERROR: no-collapse-tool-calls: ${msg}`);
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
  console.log(`no-collapse-tool-calls: ${label} patched`);
}

// Runtime toggle state, injected at the top of the bundle's CJS wrapper.
// Function declarations hoist within the module body, so the classifier and
// cache below can sit anywhere relative to the injection.
const wrapper = "(function(exports, require, module, __filename, __dirname) {";
const wi = js.indexOf(wrapper);
if (wi < 0 || wi > 200)
  fail("bundle CJS wrapper not found at the head — bundle layout changed, refusing");
js =
  js.slice(0, wi + wrapper.length) +
  "var _fctFold=!1,_fctVer=0,_fctSubs=new Set();" +
  "function _fctToggle(){_fctFold=!_fctFold;_fctVer++;for(const f of _fctSubs)f()}" +
  "function _fctSub(f){_fctSubs.add(f);return()=>_fctSubs.delete(f)}" +
  "function _fctSnap(){return _fctVer}" +
  js.slice(wi + wrapper.length);
console.log("no-collapse-tool-calls: runtime toggle state injected");

// Anchored on the flag names the branch produces, not on its control flow: a
// lookalike site would have to build the same ten-flag display record.
spliceOne(
  "search/read display classifier",
  /let ([$\w]+)=([$\w]+)\.isSearchOrReadCommand\(([$\w]+)\?\?\{\}\),([$\w]+)=\1\.isList\?\?!1,([$\w]+)=\1\.isSearch\|\|\1\.isRead\|\|\4,([$\w]+)=([$\w]+)\.includes\(([$\w]+)\);return\{isCollapsible:\5\|\|\(([$\w]+)\(\)\?\6:!1\),isSearch:\1\.isSearch,isRead:\1\.isRead,isList:\4,/g,
  (m) => {
    const [, kind, tool, input, isList, isSearchOrRead, isBashName, bashNames, name, fullscreen] = m;
    return (
      `let ${kind}=${tool}.isSearchOrReadCommand(${input}??{}),${isList}=${kind}.isList??!1,` +
      `${isSearchOrRead}=${kind}.isSearch||${kind}.isRead||${isList},${isBashName}=${bashNames}.includes(${name});` +
      `return{isCollapsible:_fctFold?${isSearchOrRead}||(${fullscreen}()?${isBashName}:!1):!1,` +
      `isSearch:${kind}.isSearch,isRead:${kind}.isRead,isList:${isList},`
    );
  },
);

// The per-message display-info cache: stamp entries with the toggle
// generation and treat a stale stamp as a miss.
spliceOne(
  "display-info cache read",
  /let ([$\w]+)=([$\w]+)\.get\(([$\w]+)\);if\(\1\?\.tools===([$\w]+)\)return \1\.info;/g,
  (m) =>
    `let ${m[1]}=${m[2]}.get(${m[3]});if(${m[1]}&&${m[1]}._fct!==_fctVer)${m[1]}=void 0;if(${m[1]}?.tools===${m[4]})return ${m[1]}.info;`,
);
spliceOne(
  "display-info cache write",
  /([$\w]+)\.set\(([$\w]+),\{tools:([$\w]+),resolvedTool:([$\w]+),info:([$\w]+)\}\)/g,
  (m) => `${m[1]}.set(${m[2]},{_fct:_fctVer,tools:${m[3]},resolvedTool:${m[4]},info:${m[5]}})`,
);

// The grouper's useMemo: subscribe to the toggle generation inside its
// dependency array. Anchored on the memo's distinctive return record.
spliceOne(
  "grouper memo dependencies",
  /(return\{collapsedBase:[$\w]+,lookups:[$\w]+,hasTruncatedMessages:[$\w]+,hiddenMessageCount:[$\w]+\}\},\[[^\]]*)(\]\),[$\w]+=([$\w]+)\.useMemo)/g,
  (m) => `${m[1]},${m[3]}.useSyncExternalStore(_fctSub,_fctSnap)${m[2]}`,
);

// The keybinding action, appended behind the stock entries so
// agents-view-shortcut's anchors on the list and table heads keep matching.
spliceOne(
  "valid-actions list",
  /\["app:interrupt","app:exit","app:toggleTodos"/g,
  () => '["app:interrupt","app:exit","app:toggleTodos","app:toggleToolCallFolding"',
);
spliceOne(
  "default binding",
  /bindings:\{"ctrl\+c":"app:interrupt",/g,
  () => 'bindings:{"ctrl+c":"app:interrupt","ctrl+f":"app:toggleToolCallFolding",',
);

// The useKeybinding hook, and a Global-context registration beside the
// chat:submit one — the same wiring agents-view-shortcut uses.
const useKeybinding = matchOne(
  "useKeybinding hook",
  /function ([$\w]+)\(e,t,r=\{\}\)\{let\{context:n="Global",isActive:o=!0\}=r,[\s\S]{0,300}?registerHandler\(\{action:e,context:n,handler:\(\)=>s\.current\(\),singleKey:!0\}\)/g,
)[1];
spliceOne(
  "handler registration",
  /(return ([$\w]+)\.registerHandler\(\{action:"chat:submit",context:"Chat",handler:\(\)=>\{[$\w]+\.current\?\.\(([$\w]+)\.current\)\},singleKey:![$\w]+\}\)\},\[[^\]]*\]\);)/g,
  (m) => `${m[1]}${useKeybinding}("app:toggleToolCallFolding",()=>{_fctToggle()},{context:"Global"});`,
);

writeFileSync(jsPath, js);
