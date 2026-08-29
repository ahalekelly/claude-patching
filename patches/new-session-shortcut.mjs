#!/usr/bin/env node
// new-session-shortcut: ctrl+n spawns a fresh interactive session from
// anywhere, exposed as the keybinding action "app:newSession" so
// keybindings.json can rebind the in-session half.
//
// Stock's only route to a fresh session is FleetView's "+ new session" row,
// and only the feature-gated simple layout (CLAUDE_CODE_FLEETVIEW_SIMPLE or
// the tengu_fleetview_simple gate) ever renders it — the default by-state
// and by-group layouts offer no route at all. The spawn-and-attach flow
// behind the row ships in every build regardless, so the patched chord
// calls it directly. In FleetView, ctrl+n runs it immediately (shadowing
// the chord's stock role as a down-arrow alias — down, j and ctrl+p still
// navigate). In a session,
// ctrl+n stamps a handoff time and runs the same open-agents flow as
// ctrl+a; when FleetView next renders inside the 8-second window it
// consumes the stamp and auto-runs the spawn, so the keystroke backgrounds
// the conversation, spawns a fresh session, and attaches to it. When the
// open-agents flow refuses (unsent draft, queued commands, persistence
// disabled) it explains itself as usual and the stamp expires unread.
//
// The session half and the FleetView half live in different modules of the
// code-split bundle, which load lazily and in either order, so the stamp
// rides on globalThis.__nssHandoff — created idempotently by whichever side
// runs first.
//
// Depends on agents-view-shortcut having run first: the session half anchors
// on that patch's _avsOpenAgents prop — the REPL-scoped open-agents closure
// it threads into the prompt component — and the actions list and bindings
// table anchors include its inserted entries. If agents-view-shortcut is
// dropped or reordered, every anchor here misses and the build aborts.
//
// Anchors are structural regexes over the minified bundle (variable names
// change per build); any match count other than exactly 1 fails loudly so the
// wrapper aborts before repack and the binary stays untouched.
import { readFileSync, writeFileSync } from "node:fs";
import { bundleTools } from "./lib/bundle.mjs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: new-session-shortcut.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

function fail(message) {
  console.error(`ERROR: new-session-shortcut: ${message}`);
  process.exit(1);
}

const { esc, chunkAt, only, onlyIn, oneModule } = bundleTools(() => js, fail);

function replaceOne(label, regex, replacement) {
  const m = only(label, regex);
  js = js.slice(0, m.index) + m[0].replace(regex, replacement) + js.slice(m.index + m[0].length);
  console.log(`new-session-shortcut: ${label} patched`);
}

for (const name of ["__nssHandoff", "_nssKick"])
  if (js.includes(name)) fail(`helper injection: identifier ${name} already present`);

// Valid-action list used to validate keybindings.json (and to build the
// keybindings docs). agents-view-shortcut prepended its action to the stock
// list head, so the pair is the anchor.
replaceOne(
  "valid-actions list",
  /"app:openAgentsView","app:interrupt"/g,
  '"app:openAgentsView","app:newSession","app:interrupt"',
);

// Default Global bindings table, behind agents-view-shortcut's ctrl+a entry.
// ctrl+n is unbound in stock's Global context; menus and scrollers bind it in
// their own narrower contexts, which win while they are open.
replaceOne(
  "default binding",
  /\{"ctrl\+a":"app:openAgentsView","ctrl\+c":"app:interrupt"/g,
  '{"ctrl+a":"app:openAgentsView","ctrl+n":"app:newSession","ctrl+c":"app:interrupt"',
);

// agents-view-shortcut's Global registration in the prompt-input component,
// where _avsOpenAgents is in scope. The new action stamps the handoff time
// and reuses that same closure: back-to-agents override, daemon detach, or
// the guarded open-agents flow, whichever applies.
replaceOne(
  "handler registration",
  /([$\w]+)\("app:openAgentsView",\(\)=>\{_avsOpenAgents&&_avsOpenAgents\(\)\},\{context:"Global"\}\);/g,
  '$&$1("app:newSession",()=>{_avsOpenAgents&&((globalThis.__nssHandoff??={at:0}).at=Date.now(),_avsOpenAgents())},{context:"Global"});',
);

const inModule = oneModule();

// FleetView's launch-scope origin: the origin the row builder stamps on a
// "+ new session" row when the row itself carries none, read at the component
// callsite that feeds the row-building pass
//   ...launcherGroup:xe,scopedFallbackOrigin:$e,termRows:dr,columns:hr,now:Zd}),
// The builder's own parameter destructure spells the same field list but ends
// it in "}){", so the trailing "})," pins the match to the call. The grouped
// layouts never build the row, but the value is layout-independent, so passing
// it straight to the spawn flow makes the chord work in every layout.
const originMatch = only(
  "fallback origin",
  /scopedFallbackOrigin:([$\w]+),termRows:[$\w]+,columns:[$\w]+,now:[$\w]+\}\),/g,
);
inModule("fallback origin", originMatch.index);
const origin = originMatch[1];

// The new-session flow itself, a module-scope function over FleetView's
// context object:
//   function tPy(e,t){let{editor:r,roster:n,attach:o,storageV5:i}=e,s=r.setError,
//     a=o.getSnapshot();if(a.newSessionOpening||a.attachingJobId!==null)return;...
//     I0e([],void 0,"shell",t,...)... s(`Couldn't start a new session ...`)}
// It debounces itself off the view's state store (spawn in flight, attach in
// progress), so every caller below can invoke it unguarded. Its second
// argument is the launch origin.
const flowMatch = only(
  "spawn flow",
  /function ([$\w]+)\(([$\w]+),[$\w]+\)\{let\{editor:[$\w]+,roster:[$\w]+,attach:[$\w]+,storageV5:[$\w]+\}=\2,[$\w]+=[$\w]+\.setError,([$\w]+)=[$\w]+\.getSnapshot\(\);if\(\3\.newSessionOpening\|\|\3\.attachingJobId!==null\)return;[\s\S]{100,1500}?Couldn't start a new session/g,
);
inModule("spawn flow", flowMatch.index);
const flow = flowMatch[1];

// FleetView's component-scope wrapper over the flow, bound in the let chain
// that builds the view's action closures:
//   dy=(Qo)=>tPy(Pm,Qo),V0=a!==void 0&&...
// The kick rides that same chain right after the wrapper: it runs on every
// render, consumes the handoff stamp at most once, and defers the call past
// the render since the flow sets state. The lookahead pins the match to a
// chain position, so a wrapper moved out of one fails loudly.
const flowChunk = chunkAt(flowMatch.index);
const wrapperMatch = onlyIn(
  "spawn wrapper + handoff kick",
  flowChunk.text,
  new RegExp(
    `,([$\\w]+)=\\(([$\\w]+)\\)=>${esc(flow)}\\([$\\w]+,\\2\\),(?=[$\\w]+=[$\\w]+!==void 0&&)`,
    "g",
  ),
);
const wrapperAt = flowChunk.start + wrapperMatch.index;
inModule("spawn wrapper + handoff kick", wrapperAt);
const spawn = wrapperMatch[1];
js =
  js.slice(0, wrapperAt + wrapperMatch[0].length) +
  "_nssKick=((globalThis.__nssHandoff??={at:0}).at&&" +
  "Date.now()-globalThis.__nssHandoff.at<8e3&&" +
  `(globalThis.__nssHandoff.at=0,setTimeout(()=>${spawn}(${origin}),0)),0),` +
  js.slice(wrapperAt + wrapperMatch[0].length);
console.log("new-session-shortcut: spawn wrapper + handoff kick patched");

// FleetView's raw key handler is its own module-scope function over the same
// context object, so it reaches the wrapper and the origin through it:
//   function sPy(e,t){let{...,openNewSessionRow:T,openOrRespawn:C}=e.submit,...
const keyContext = only(
  "key-handler context",
  /openNewSessionRow:([$\w]+),openOrRespawn:[$\w]+\}=([$\w]+)\.submit,/g,
);
inModule("key-handler context", keyContext.index);
const fleetSpawn = keyContext[1];
const fleetOrigin = `${keyContext[2]}.submit.scopedFallbackOrigin`;

// The handler's main-mode down-navigation branch:
//   if(ot.key==="down"||ot.ctrl&&ot.key==="n"){if(Zr(),jD.length>0){...Math.min(jD.length-1...
// Inserting before it takes ctrl+n over for new-session and leaves the rest
// of the branch (down arrow, multiline composer, list wrap) untouched. The
// sub-mode handlers earlier in the flow — rename navigation, the pending
// spawn's esc-to-cancel — still see their keys first.
const branch = only(
  "fleet ctrl+n",
  /if\(([$\w]+)\.key==="down"\|\|\1\.ctrl&&\1\.key==="n"\)\{if\(([$\w]+)\(\),([$\w]+)\.length>0\)\{([$\w]+)\(null\),([$\w]+)\(\(([$\w]+)\)=>Math\.min\(\3\.length-1/g,
);
inModule("fleet ctrl+n", branch.index);
if (branch.index < keyContext.index)
  fail("fleet ctrl+n: the down-navigation branch precedes the key handler's context destructure — refusing");
js =
  js.slice(0, branch.index) +
  `if(${branch[1]}.ctrl&&${branch[1]}.key==="n"){${branch[2]}();${fleetSpawn}(${fleetOrigin});return}` +
  js.slice(branch.index);
console.log("new-session-shortcut: fleet ctrl+n patched");

writeFileSync(jsPath, js);
