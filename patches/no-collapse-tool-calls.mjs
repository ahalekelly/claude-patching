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
// chat:submit registration the same way agents-view-shortcut wires its action.
//
// Shared state
// ------------
// The bundle is code-split ESM: the sites this patch edits live in four
// modules — the classifier and the display-info cache in one, the transcript
// grouper in another, the keybinding tables in a third, the chat:submit
// registration in a fourth. An injected declaration would only be visible
// inside its own module, so the toggle state is a globalThis namespace:
//
//   globalThis.__fct = {fold, ver, subs, sub, snap, toggle}
//
// Every module that reads it initializes it with `??=` at its own head, right
// after its import prologue. Modules load lazily and in no fixed order, so no
// module may assume another one ran first; `??=` makes whichever runs first
// the creator and the rest no-ops. sub/snap/toggle are properties of the one
// object rather than per-module functions, which also gives useSyncExternalStore
// the stable subscribe identity it requires.
//
// Flipping the toggle must re-render history, not just future rows, so:
//
// - The per-message display-info cache is stamped with the toggle generation.
//   A stale stamp clears the entry, which misses both of the cache's hit paths
//   (same tools object, and same resolved tool).
// - The transcript grouper runs in a useMemo; a useSyncExternalStore
//   subscription to the toggle generation is appended inside its dependency
//   array (argument expressions evaluate during render, so the hook call is
//   unconditional and its order stable), which re-renders the component on
//   toggle and regroups the whole message list. The new list identity flows
//   through the virtual message list, re-rendering every row.
//
// Cross-module names
// ------------------
// A minified name is only meaningful inside the module it was probed from, so
// the two hooks called from injected code — useKeybinding at the registration
// site, useSyncExternalStore at the grouper — are resolved through the import
// list of the module doing the calling: probe the hook's definition, read the
// export alias its own module publishes it under, then read the local alias
// the calling module imports that under. The import's source module is
// asserted to be the defining module, which proves the alias is the hook.
//
// Anchors are content-bearing (flag names, action strings, property names),
// each asserted to match exactly once across the whole concatenation, and any
// other count aborts before anything is written. No splice crosses a
// `//__CHUNK__` marker line.
//
// This patch applies before agents-view-shortcut and new-session-shortcut, so
// its insertions into the valid-actions list, the Global bindings table and
// the registration site all append after stock text those patches anchor on.
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

const esc = (s) => s.replace(/\$/g, "\\$");

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

// Text of the module containing `at`, and the module's file name. Modules are
// concatenated in load order, each behind a `//__CHUNK__ <name>` marker line.
function chunkAt(at) {
  const marker = js.lastIndexOf("\n//__CHUNK__ ", at);
  if (marker === -1) fail("no chunk marker precedes the match — refusing");
  const nameEnd = js.indexOf("\n", marker + 1);
  let end = js.indexOf("\n//__CHUNK__ ", nameEnd);
  if (end === -1) end = js.length;
  return { name: js.slice(marker + 13, nameEnd), start: nameEnd + 1, text: js.slice(nameEnd + 1, end) };
}

// The one entry named `local` in a comma-separated `{a as b,c as d}` list.
function aliasOf(label, list, local) {
  const hits = [...`,${list},`.matchAll(new RegExp(`,${esc(local)} as ([$\\w]+),`, "g"))];
  if (hits.length !== 1)
    fail(`${label}: ${hits.length} entries for ${local}, expected exactly 1 — refusing`);
  return hits[0][1];
}

// The local name under which `site` imports the binding defined as `local` in
// the module holding `defAt`, proven by the import's source module.
function importedAs(label, defAt, local, site) {
  const def = chunkAt(defAt);
  const exports = [...def.text.matchAll(/export\{([^{}]*)\}/g)].map((m) => m[1]).join(",");
  const exported = aliasOf(`${label} export`, exports, local);
  const imports = [
    ...site.text.matchAll(/import\{([^{}]*)\}from"[^"]*\/([^"\/]+\.js)"/g),
  ].filter((m) => `,${m[1]},`.includes(`,${exported} as `));
  if (imports.length !== 1)
    fail(
      `${label}: ${site.name} imports ${exported} in ${imports.length} statements, expected exactly 1 — refusing`,
    );
  if (imports[0][2] !== def.name)
    fail(
      `${label}: ${site.name} imports ${exported} from ${imports[0][2]}, but it is defined in ${def.name} — refusing`,
    );
  return aliasOf(`${label} import`, imports[0][1], exported);
}

// Runtime toggle state. Every module below that reads it seeds it at its own
// head; `??=` makes the first module to load the creator.
const STATE =
  "globalThis.__fct??=(()=>{let s={fold:!1,ver:0,subs:new Set()};" +
  "s.sub=(f)=>{s.subs.add(f);return()=>{s.subs.delete(f)}};" +
  "s.snap=()=>s.ver;" +
  "s.toggle=()=>{s.fold=!s.fold;s.ver++;for(let f of s.subs)f()};" +
  "return s})();";

const seeded = new Set();
function seedState(label, regex) {
  const chunk = chunkAt(matchOne(label, regex).index);
  if (seeded.has(chunk.name)) return;
  seeded.add(chunk.name);
  const head = /^(?:\/\/[^\n]*\n|\n)+(?:import\{[^{}]*\}from"[^"]*";)+/.exec(chunk.text);
  if (!head) fail(`${chunk.name}: no import prologue at the module head — refusing`);
  const at = chunk.start + head[0].length;
  js = js.slice(0, at) + STATE + js.slice(at);
  console.log(`no-collapse-tool-calls: toggle state seeded in ${chunk.name}`);
}

// Anchored on the flag names the branch produces, not on its control flow: a
// lookalike site would have to build the same ten-flag display record.
const CLASSIFIER =
  /let ([$\w]+)=([$\w]+)\.isSearchOrReadCommand\(([$\w]+)\?\?\{\}\),([$\w]+)=\1\.isList\?\?!1,([$\w]+)=\1\.isSearch\|\|\1\.isRead\|\|\4,([$\w]+)=([$\w]+)\.includes\(([$\w]+)\);return\{isCollapsible:\5\|\|\(([$\w]+)\(\)\?\6:!1\),isSearch:\1\.isSearch,isRead:\1\.isRead,isList:\4,/g;
// The per-message display-info cache: a Map keyed by message, hit either on
// the same tools object or on the same resolved tool.
const CACHE_READ =
  /let ([$\w]+)=([$\w]+)\.get\(([$\w]+)\);if\(\1\?\.tools===([$\w]+)\)return \1\.info;/g;
const CACHE_WRITE =
  /([$\w]+)\.set\(([$\w]+),\{tools:([$\w]+),resolvedTool:([$\w]+),info:([$\w]+)\}\)/g;
// The grouper's useMemo, anchored on the record it returns.
const GROUPER =
  /(return\{collapsedBase:[$\w]+,lookups:[$\w]+,hasTruncatedMessages:[$\w]+,hiddenMessageCount:[$\w]+\}\},\[[^\]]*)(\]\))/g;
// The chat:submit registration our own registration is appended to.
const REGISTRATION =
  /(return ([$\w]+)\.registerHandler\(\{action:"chat:submit",context:"Chat",handler:\(\)=>\{[^{}]*\},singleKey:![$\w]+\}\)\},\[[^\]]*\]\);)/g;

for (const [label, regex] of [
  ["classifier", CLASSIFIER],
  ["display-info cache read", CACHE_READ],
  ["display-info cache write", CACHE_WRITE],
  ["grouper", GROUPER],
  ["registration", REGISTRATION],
])
  seedState(label, regex);

spliceOne("search/read display classifier", CLASSIFIER, (m) => {
  const [, kind, tool, input, isList, isSearchOrRead, isBashName, bashNames, name, fullscreen] = m;
  return (
    `let ${kind}=${tool}.isSearchOrReadCommand(${input}??{}),${isList}=${kind}.isList??!1,` +
    `${isSearchOrRead}=${kind}.isSearch||${kind}.isRead||${isList},${isBashName}=${bashNames}.includes(${name});` +
    `return{isCollapsible:globalThis.__fct.fold?${isSearchOrRead}||(${fullscreen}()?${isBashName}:!1):!1,` +
    `isSearch:${kind}.isSearch,isRead:${kind}.isRead,isList:${isList},`
  );
});

// Stamp cache entries with the toggle generation; a stale stamp drops the
// entry, so neither of the two hit paths below can return folded-era info.
spliceOne(
  "display-info cache read",
  CACHE_READ,
  (m) =>
    `let ${m[1]}=${m[2]}.get(${m[3]});if(${m[1]}&&${m[1]}._fct!==globalThis.__fct.ver)${m[1]}=void 0;` +
    `if(${m[1]}?.tools===${m[4]})return ${m[1]}.info;`,
);
spliceOne(
  "display-info cache write",
  CACHE_WRITE,
  (m) =>
    `${m[1]}.set(${m[2]},{_fct:globalThis.__fct.ver,tools:${m[3]},resolvedTool:${m[4]},info:${m[5]}})`,
);

// Subscribe to the toggle generation inside the grouper memo's dependency
// array, through the grouper module's own alias for useSyncExternalStore.
{
  const def = matchOne(
    "useSyncExternalStore",
    /([$\w]+)=function\(([$\w]+),([$\w]+),([$\w]+)\)\{return ([$\w]+)\.H\.useSyncExternalStore\(\2,\3,\4\)\}/g,
  );
  const useStore = importedAs(
    "useSyncExternalStore",
    def.index,
    def[1],
    chunkAt(matchOne("grouper", GROUPER).index),
  );
  spliceOne(
    "grouper memo dependencies",
    GROUPER,
    (m) => `${m[1]},${useStore}(globalThis.__fct.sub,globalThis.__fct.snap)${m[2]}`,
  );
}

// The keybinding action, appended behind the stock entries so the shortcut
// patches' anchors on the list and table heads keep matching.
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

// A Global-context registration beside the chat:submit one, through the
// registration module's own alias for the useKeybinding hook.
{
  const def = matchOne(
    "useKeybinding hook",
    /function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+)=\{\}\)\{let\{context:([$\w]+)="Global",isActive:([$\w]+)=!0\}=\4,[\s\S]{0,300}?registerHandler\(\{action:\2,context:\5,handler:\(\)=>[^,]*,singleKey:!0\}\)/g,
  );
  const useKeybinding = importedAs(
    "useKeybinding",
    def.index,
    def[1],
    chunkAt(matchOne("registration", REGISTRATION).index),
  );
  spliceOne(
    "handler registration",
    REGISTRATION,
    (m) =>
      `${m[1]}${useKeybinding}("app:toggleToolCallFolding",()=>{globalThis.__fct.toggle()},{context:"Global"});`,
  );
}

writeFileSync(jsPath, js);
