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
// one module; the left-arrow route helper and the prompt-input component that
// consumes it live together in another, so every injected line lands in that
// second module and no cross-module state is needed. The useKeybinding hook
// is declared in a third module, so its name in the injection site's module
// is the import alias, resolved through the hook's export name rather than
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
//   function tr(e,t,r={}){let{context:n="Global",isActive:s=!0}=r,o=f(),
//     [i]=v(()=>({handler:t}));h(()=>{i.handler=t}),g(()=>{if(!o||!s)return;
//     return o.registerHandler({action:e,context:n,handler:()=>i.handler(),
//     singleKey:!0})},[e,n,o,s,i])}
// The sibling hook that registers a whole action map takes two parameters and
// registers each map key as its own action, so the three-parameter signature
// registering the hook's own action argument pins this one.
const hook = matchOne(
  "useKeybinding hook",
  /function ([$\w]+)\(([$\w]+),[$\w]+,([$\w]+)=\{\}\)\{let\{context:([$\w]+)="Global",isActive:[$\w]+=!0\}=\3,[\s\S]{0,300}?registerHandler\(\{action:\2,context:\4,handler:\(\)=>[^,]*,singleKey:!0\}\)/g,
);

// The prompt-input component's chat:submit registration, the proof that the
// keybinding registry works in that component and the seat for the new
// Global registration.
const submit = matchOne(
  "handler registration",
  /return [$\w]+\.registerHandler\(\{action:"chat:submit",context:"Chat",handler:\(\)=>\{[^{}]*\},singleKey:![$\w]+\}\)\},\[[^\]]*\]\);/g,
);

// The hook reaches the prompt-input module as an import alias: follow it from
// the hook's own export entry to the matching import entry, then require the
// result to be the name a stock Global registration in that module already
// calls, so a mis-followed alias cannot reach the output.
const EXPORT_LISTS = /export\{([^{}]*)\}/g;
const IMPORT_LISTS = /import\{([^{}]*)\}from"[^"]*"/g;

// The one name `local` is published under in a module's export or import
// lists — `{a as b,c,d as e}`, where an entry is bare whenever its local and
// published names agree.
function publishedAs(label, text, lists, local) {
  const list = [...text.matchAll(lists)].map((m) => m[1]).join(",");
  const matches = [
    ...`,${list},`.matchAll(
      new RegExp(`,(?:${forRegExp(local)} as ([$\\w]+)|(${forRegExp(local)})),`, "g"),
    ),
  ];
  if (matches.length !== 1) fail(label, `${matches.length} entries for ${local}, expected exactly 1`);
  return matches[0][1] ?? matches[0][2];
}

const exportName = publishedAs(
  "useKeybinding export",
  moduleAt("useKeybinding export", hook.index),
  EXPORT_LISTS,
  hook[1],
);
const promptModule = moduleAt("useKeybinding import", submit.index);
const useKeybinding = publishedAs(
  "useKeybinding import",
  promptModule,
  IMPORT_LISTS,
  exportName,
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

// The left-arrow route helper, called to decide what the arrow gesture does,
// and the source of the identifiers the shortcut's handler needs:
//   function mle(e,{onDetachToCaller:t,isLoading:o,isExternalLoading:n,
//                   betweenCalls:r,leftArrowOpensAgents:s}){
//     if(t)return{handler:t,confirmHint:"Press ← again to go back"};
//     {let a=sk({isBg:ko(),isLoading:o,...,inFlight:{count:0,kinds:[]}});
//      if(a.ok&&a.via==="detach")
//        return{handler:e.onBgDetach,confirmHint:"...go back to agents"};
//      if(FI(a)&&s)
//        return{handler:e.onLeftArrow,confirmHint:"...open agents"}}
//     return}
// e = the gesture controller: .onBgDetach is the debounced detach,
// .onLeftArrow the self-guarded open-agents flow. ko() = daemon-attached (sk
// only ever returns via:"detach" when ko() is true, so branching on ko()
// directly is equivalent to the helper's detach check).
const route = matchOne(
  "left-arrow route helper",
  /function [$\w]+\(([$\w]+),\{onDetachToCaller:([$\w]+),isLoading:[$\w]+,isExternalLoading:[$\w]+,betweenCalls:[$\w]+,leftArrowOpensAgents:([$\w]+)\}\)\{if\(\2\)return\{handler:\2,confirmHint:"Press \\u2190 again to go back"\};\{let ([$\w]+)=[$\w]+\(\{isBg:([$\w]+)\(\),isLoading:[$\w]+,isExternalLoading:[$\w]+,betweenCalls:[$\w]+,inFlight:\{count:0,kinds:\[\]\}\}\);if\(\4\.ok&&\4\.via==="detach"\)return\{handler:\1\.([$\w]+),confirmHint:"Press \\u2190 again to go back to agents"\};if\([$\w]+\(\4\)&&\3\)return\{handler:\1\.([$\w]+),confirmHint:"Press \\u2190 again to open agents"\}\}return\}/g,
);
const [, , , , , isBg, detachProp, openProp] = route;

// The route reaches the arrow gesture through a memoizing hook wrapper that
// the prompt-input component calls in its own let chain, keeping the result's
// .handler and .confirmHint:
//   ao=uA({gesture:Z,turn:b,transcript:R,
//          onDetachToCaller:Ye(j,(it)=>it.onDetachToCaller)}),
//   Bo=ao?.handler,Go=ao?.confirmHint,
// gesture is the controller the helper receives as its first parameter. The
// ?.handler/?.confirmHint tail pins the consuming component: the REPL also
// calls the hook (with a prebuilt props object) and discards the result. The
// helper is module-local, so its probed names resolve at the call site only
// because both share a module.
const call = matchOne(
  "route hook call",
  /([$\w]+)=([$\w]+)\(\{gesture:([$\w]+),turn:([$\w]+),transcript:([$\w]+),onDetachToCaller:([$\w]+\([$\w]+,\([$\w]+\)=>[$\w]+\.onDetachToCaller\))\}\)(,[$\w]+=\1\?\.handler,[$\w]+=\1\?\.confirmHint,)/g,
);
if (js.lastIndexOf(MARKER, route.index) !== js.lastIndexOf(MARKER, call.index))
  fail("route hook call", "the helper and the hook call that consumes it are in different modules");

// The shortcut's ungated handler is built beside that call, as two extra
// declarators in the component's let chain: the onDetachToCaller selector is
// hoisted into _avsDetach — still exactly one hook call, in the same
// position, so hook order is preserved — and the handler checks it first,
// matching the helper's own precedence: a daemon-attached session detaches
// back to the agents view, a terminal session runs the self-guarded
// open-agents flow. The chat:submit effect that seats the registration below
// is nested in the same component function, so both bindings are in scope
// there, and the registration hook re-reads its handler every render, so the
// closure never goes stale.
{
  const [text, result, routeHook, gesture, turn, transcript, detachExpr, tail] = call;
  js =
    js.slice(0, call.index) +
    `_avsDetach=${detachExpr},` +
    "_avsOpenAgents=()=>{if(_avsDetach){_avsDetach();return}" +
    `if(${isBg}()){${gesture}.${detachProp}();return}` +
    `${gesture}.${openProp}()},` +
    `${result}=${routeHook}({gesture:${gesture},turn:${turn},transcript:${transcript},onDetachToCaller:_avsDetach})` +
    tail +
    js.slice(call.index + text.length);
  console.log("agents-view-shortcut: route hook call patched");
}

replaceOne(
  "handler registration",
  /return [$\w]+\.registerHandler\(\{action:"chat:submit",context:"Chat",handler:\(\)=>\{[^{}]*\},singleKey:![$\w]+\}\)\},\[[^\]]*\]\);/g,
  (m) =>
    m[0] +
    `${useKeybinding}("app:openAgentsView",()=>{_avsOpenAgents&&_avsOpenAgents()},{context:"Global"});`,
);

writeFileSync(jsPath, js);
