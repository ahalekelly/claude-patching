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

function matchOne(label, regex) {
  const matches = [...js.matchAll(regex)];
  if (matches.length !== 1) {
    console.error(
      `ERROR: agents-view-shortcut: ${label}: ${matches.length} matches, expected exactly 1 — bundle layout changed, refusing`,
    );
    process.exit(1);
  }
  return matches[0];
}

function replaceOne(label, regex, replacement) {
  matchOne(label, regex);
  js = js.replace(regex, replacement);
  console.log(`agents-view-shortcut: ${label} patched`);
}

// The useKeybinding hook: registers a handler for an action in a context.
//   function Bn(e,t,r={}){let{context:n="Global",isActive:o=!0}=r,...
//     registerHandler({action:e,context:n,handler:()=>s.current(),singleKey:!0})...
const useKeybinding = matchOne(
  "useKeybinding hook",
  /function ([$\w]+)\(e,t,r=\{\}\)\{let\{context:n="Global",isActive:o=!0\}=r,[\s\S]{0,300}?registerHandler\(\{action:e,context:n,handler:\(\)=>s\.current\(\),singleKey:!0\}\)/g,
)[1];

// Valid-action list used to validate keybindings.json (and to build the
// keybindings docs). Prepend the new action.
replaceOne(
  "valid-actions list",
  /\["app:interrupt","app:exit","app:toggleTodos"/g,
  '["app:openAgentsView","app:interrupt","app:exit","app:toggleTodos"',
);

// Default Global bindings table. ctrl+a is unbound in stock (it is the GNU
// screen prefix and readline home, a conscious trade for a one-hand chord).
replaceOne(
  "default binding",
  /bindings:\{"ctrl\+c":"app:interrupt"/g,
  'bindings:{"ctrl+a":"app:openAgentsView","ctrl+c":"app:interrupt"',
);

// The REPL component's left-arrow decision memo — captures the identifiers
// the handler needs (all in REPL scope):
//   FZt=Dr.useMemo(()=>{
//     if(A)return{handler:A,confirmHint:"Press ← again to go back"};
//     {let vt=z9t({isBg:Es(),isLoading:Ln,...});
//      if(vt.ok&&vt.via==="detach")return{handler:$Zt,confirmHint:"...go back to agents"};
//      if(Fgn(vt)&&Exe)return{handler:w8e,confirmHint:"...open agents"}}
//     return},[deps])
// A = back-to-agents override passed in when opened from the agents view,
// Es() = daemon-attached, $Zt = debounced detach, w8e = the self-guarded
// open-agents flow (z9t only ever returns via:"detach" when Es() is true, so
// branching on Es() directly is equivalent to the memo's detach check).
const [, A, , Es, detach, openAgents] = matchOne(
  "left-arrow memo",
  /,[$\w]+=[$\w]+\.useMemo\(\(\)=>\{if\(([$\w]+)\)return\{handler:\1,confirmHint:"Press \\u2190 again to go back"\};\{let ([$\w]+)=[$\w]+\(\{isBg:([$\w]+)\(\),isLoading:[$\w]+,isExternalLoading:[$\w]+,betweenCalls:[$\w]+,inFlight:\{count:0,kinds:\[\]\}\}\);if\(\2\.ok&&\2\.via==="detach"\)return\{handler:([$\w]+),confirmHint:"Press \\u2190 again to go back to agents"\};if\([$\w]+\(\2\)&&[$\w]+\)return\{handler:([$\w]+),confirmHint:"Press \\u2190 again to open agents"\}\}return\},\[[^\]]*\]\),/g,
);

// The keybinding registry context is null in the REPL component itself, so
// the handler is wired through the prompt-input component (where chat:submit
// registers, proving the registry works there): the REPL passes an ungated
// handler as a new onOpenAgentsShortcut prop beside onLeftArrowOnEmpty, the
// prompt component destructures it and registers it in the Global context.
replaceOne(
  "handler prop pass",
  /,onExit:([$\w]+),onLeftArrowOnEmpty:([$\w]+),leftArrowConfirmHint:([$\w]+),verbose:/g,
  `,onExit:$1,onLeftArrowOnEmpty:$2,leftArrowConfirmHint:$3,onOpenAgentsShortcut:()=>{if(${A}){${A}();return}if(${Es}()){${detach}();return}${openAgents}()},verbose:`,
);

replaceOne(
  "handler prop destructure",
  /onOpenSessionMemories:([$\w]+),onExit:([$\w]+),onLeftArrowOnEmpty:([$\w]+),leftArrowConfirmHint:([$\w]+),getToolUseContext:/g,
  "onOpenSessionMemories:$1,onExit:$2,onLeftArrowOnEmpty:$3,leftArrowConfirmHint:$4,onOpenAgentsShortcut:_avsOpenAgents,getToolUseContext:",
);

replaceOne(
  "handler registration",
  /(return ([$\w]+)\.registerHandler\(\{action:"chat:submit",context:"Chat",handler:\(\)=>\{[$\w]+\.current\?\.\(([$\w]+)\.current\)\},singleKey:![$\w]+\}\)\},\[[^\]]*\]\);)/g,
  `$1${useKeybinding}("app:openAgentsView",()=>{_avsOpenAgents&&_avsOpenAgents()},{context:"Global"});`,
);

writeFileSync(jsPath, js);
