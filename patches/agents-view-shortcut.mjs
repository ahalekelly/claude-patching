#!/usr/bin/env node
// agents-view-shortcut: an always-active keyboard shortcut to the agents view
// (FleetView), default ctrl+a, exposed as the keybinding action
// "app:openAgentsView" so keybindings.json can rebind it.
//
// Stock Claude Code's only in-session route to the agents view is the
// left-arrow gesture, which works solely on an empty prompt while idle. The
// patched action registers in the Global keybinding context and works any
// time: a daemon-attached session detaches back to the agents view; a
// terminal session runs the same open-agents flow as the arrow gesture, which
// backgrounds the conversation first and explains itself when it can't
// (unsent draft, queued commands, persistence disabled).
//
// The bundle is code-split into ES modules, concatenated for patching with a
// "//__CHUNK__ <name>" line before each. The keybinding action tables live in
// one module; the REPL and the prompt-input component that carry the handler
// live together in another, so every injected line lands in that second
// module and no cross-module state is needed. The useKeybinding hook is
// declared in a third module, so its name in the injection site's module is
// the import alias, resolved through the hook's export name rather than
// assumed.
//
// Anchors are structural regexes over the minified bundle (variable names
// change per build); any match count other than exactly 1 fails loudly so the
// wrapper aborts before repack and the binary stays untouched.
import { readFileSync, writeFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: agents-view-shortcut.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

function fail(label, detail) {
  console.error(`ERROR: agents-view-shortcut: ${label}: ${detail} — bundle layout changed, refusing`);
  process.exit(1);
}

function matchOne(label, regex) {
  const matches = [...js.matchAll(regex)];
  if (matches.length !== 1) fail(label, `${matches.length} matches, expected exactly 1`);
  return matches[0];
}

// build receives the match — m[0] is the matched text, m[1..] the capture
// groups — and returns the text to splice in its place.
function replaceOne(label, regex, build) {
  const m = matchOne(label, regex);
  js = js.slice(0, m.index) + build(m) + js.slice(m.index + m[0].length);
  console.log(`agents-view-shortcut: ${label} patched`);
}

const MARKER = "\n//__CHUNK__ ";

// The module holding a match, as its own text — searches for a module-local
// binding (an import alias, an export entry) must not stray into a sibling.
function moduleAt(label, index) {
  const start = js.lastIndexOf(MARKER, index);
  if (start === -1) fail(label, "match precedes the first module marker");
  const head = js.indexOf("\n", start + MARKER.length);
  const next = js.indexOf(MARKER, head);
  return js.slice(head, next === -1 ? js.length : next);
}

function bindingIn(label, text, regex) {
  const matches = [...text.matchAll(regex)];
  if (matches.length !== 1) fail(label, `${matches.length} matches within its module, expected exactly 1`);
  return matches[0][1];
}

const forRegExp = (name) => name.replace(/\$/g, "\\$");

// The useKeybinding hook: registers a handler for an action in a context.
//   function tr(e,t,r={}){let{context:n="Global",isActive:o=!0}=r,s=f(),i=y(t);
//     i.current=t,h(()=>{if(!s||!o)return;return s.registerHandler(
//       {action:e,context:n,handler:()=>i.current(),singleKey:!0})},[e,n,s,o])}
// The sibling hook that registers a whole action map reads
// `.current[c]?.()` instead, so the single-handler call pins this one.
const hook = matchOne(
  "useKeybinding hook",
  /function ([$\w]+)\(([$\w]+),[$\w]+,([$\w]+)=\{\}\)\{let\{context:([$\w]+)="Global",isActive:[$\w]+=!0\}=\3,[\s\S]{0,300}?registerHandler\(\{action:\2,context:\4,handler:\(\)=>[$\w]+\.current\(\),singleKey:!0\}\)/g,
);

// The prompt-input component's chat:submit registration, the proof that the
// keybinding registry works in that component and the seat for the new
// Global registration.
const submit = matchOne(
  "handler registration",
  /return [$\w]+\.registerHandler\(\{action:"chat:submit",context:"Chat",handler:\(\)=>\{[$\w]+\.current\?\.\([$\w]+\.current\)\},singleKey:![$\w]+\}\)\},\[[^\]]*\]\);/g,
);

// The hook reaches the prompt-input module as an import alias: follow it from
// the hook's own export entry to the matching import entry, then require the
// result to be the name a stock Global registration in that module already
// calls, so a mis-followed alias cannot reach the output.
const exportName = bindingIn(
  "useKeybinding export",
  moduleAt("useKeybinding export", hook.index),
  new RegExp(`[{,]${forRegExp(hook[1])} as ([$\\w]+)[,}]`, "g"),
);
const promptModule = moduleAt("useKeybinding import", submit.index);
const useKeybinding = bindingIn(
  "useKeybinding import",
  promptModule,
  new RegExp(`[{,]${forRegExp(exportName)} as ([$\\w]+)[,}]`, "g"),
);
if (bindingIn("useKeybinding alias check", promptModule, /([$\w]+)\("app:toggleTodos",[$\w]+,[$\w]+\);/g) !== useKeybinding)
  fail("useKeybinding alias check", "the followed alias is not the one the module's stock Global registrations call");

// Valid-action list used to validate keybindings.json (and to build the
// keybindings docs). Prepend the new action.
replaceOne(
  "valid-actions list",
  /\["app:interrupt","app:exit","app:toggleTodos"/g,
  () => '["app:openAgentsView","app:interrupt","app:exit","app:toggleTodos"',
);

// Default Global bindings table. ctrl+a is unbound in stock (it is the GNU
// screen prefix and readline home, a conscious trade for a one-hand chord).
replaceOne(
  "default binding",
  /bindings:\{"ctrl\+c":"app:interrupt"/g,
  () => 'bindings:{"ctrl+a":"app:openAgentsView","ctrl+c":"app:interrupt"',
);

// The REPL component's left-arrow decision memo — the value of the
// leftArrowRoute prop, and the source of the identifiers the handler needs
// (all in REPL scope):
//   Ee=z(()=>{
//     if(O)return{handler:O,confirmHint:"Press ← again to go back"};
//     {let T=fw({isBg:No(),isLoading:xt,...});
//      if(T.ok&&T.via==="detach")return{handler:YI,confirmHint:"...go back to agents"};
//      if(iO(T)&&rT)return{handler:Ja,confirmHint:"...open agents"}}
//     return},[deps])
// O = back-to-agents override passed in when opened from the agents view,
// No() = daemon-attached, YI = debounced detach, Ja = the self-guarded
// open-agents flow (fw only ever returns via:"detach" when No() is true, so
// branching on No() directly is equivalent to the memo's detach check).
const [, override, , isBg, detach, openAgents] = matchOne(
  "left-arrow memo",
  /,[$\w]+=[$\w]+(?:\.useMemo)?\(\(\)=>\{if\(([$\w]+)\)return\{handler:\1,confirmHint:"Press \\u2190 again to go back"\};\{let ([$\w]+)=[$\w]+\(\{isBg:([$\w]+)\(\),isLoading:[$\w]+,isExternalLoading:[$\w]+,betweenCalls:[$\w]+,inFlight:\{count:0,kinds:\[\]\}\}\);if\(\2\.ok&&\2\.via==="detach"\)return\{handler:([$\w]+),confirmHint:"Press \\u2190 again to go back to agents"\};if\([$\w]+\(\2\)&&[$\w]+\)return\{handler:([$\w]+),confirmHint:"Press \\u2190 again to open agents"\}\}return\},\[[^\]]*\]\),/g,
);

// The keybinding registry context is null in the REPL component itself, so
// the handler is wired through the prompt-input component (where chat:submit
// registers, proving the registry works there): the REPL passes an ungated
// handler as a new onOpenAgentsShortcut prop beside leftArrowRoute, the prompt
// component destructures it and registers it in the Global context.
replaceOne(
  "handler prop pass",
  /,onExit:([$\w]+),leftArrowRoute:([$\w]+),transcript:/g,
  (m) =>
    `,onExit:${m[1]},leftArrowRoute:${m[2]},onOpenAgentsShortcut:()=>{` +
    `if(${override}){${override}();return}if(${isBg}()){${detach}();return}${openAgents}()},transcript:`,
);

replaceOne(
  "handler prop destructure",
  /onOpenSessionMemories:([$\w]+),onExit:([$\w]+),leftArrowRoute:([$\w]+),onSubmit:/g,
  (m) =>
    `onOpenSessionMemories:${m[1]},onExit:${m[2]},leftArrowRoute:${m[3]},` +
    "onOpenAgentsShortcut:_avsOpenAgents,onSubmit:",
);

replaceOne(
  "handler registration",
  /return [$\w]+\.registerHandler\(\{action:"chat:submit",context:"Chat",handler:\(\)=>\{[$\w]+\.current\?\.\([$\w]+\.current\)\},singleKey:![$\w]+\}\)\},\[[^\]]*\]\);/g,
  (m) =>
    m[0] +
    `${useKeybinding}("app:openAgentsView",()=>{_avsOpenAgents&&_avsOpenAgents()},{context:"Global"});`,
);

writeFileSync(jsPath, js);
