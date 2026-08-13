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
// ctrl+n stamps a handoff time on globalThis and runs the same open-agents
// flow as ctrl+a; when FleetView next renders inside the 8-second window it
// consumes the stamp and auto-runs the spawn, so the keystroke backgrounds
// the conversation, spawns a fresh session, and attaches to it. When the
// open-agents flow refuses (unsent draft, queued commands, persistence
// disabled) it explains itself as usual and the stamp expires unread.
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

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: new-session-shortcut.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

function matchOne(label, regex) {
  const matches = [...js.matchAll(regex)];
  if (matches.length !== 1) {
    console.error(
      `ERROR: new-session-shortcut: ${label}: ${matches.length} matches, expected exactly 1 — bundle layout changed (or agents-view-shortcut did not run first), refusing`,
    );
    process.exit(1);
  }
  return matches[0];
}

function replaceOne(label, regex, replacement) {
  matchOne(label, regex);
  js = js.replace(regex, replacement);
  console.log(`new-session-shortcut: ${label} patched`);
}

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
  '$&$1("app:newSession",()=>{_avsOpenAgents&&(globalThis._newSessionShortcutAt=Date.now(),_avsOpenAgents())},{context:"Global"});',
);

// FleetView's launch-scope origin: the fallbackOrigin the home layout's row
// builder stamps on its "+ new session" row, captured at the one callsite
//   gA=w?djh(Ix,{statusFor:K6,now:GS,fallbackOrigin:de,...})
// (the builder's own destructure is not preceded by "=w?"). The grouped
// layouts never build the row, but de is layout-independent, so passing it
// straight to the spawn flow makes the chord work in every layout.
const origin = matchOne(
  "fallback origin",
  /=[$\w]+\?[$\w]+\([$\w]+,\{statusFor:[$\w]+,now:[$\w]+,fallbackOrigin:([$\w]+),showFinishedEarlier:/g,
)[1];

// The new-session flow itself, in FleetView component scope:
//   YQe=(ot)=>{if(tn.current||nt.current!==null)return;...
//     d_e([],void 0,"shell",ot,...)... mi(`Couldn't start a new session ...`)}
// It debounces itself (spawn in flight, attach in progress), so both callers
// below can invoke it unguarded. The kick rides the same let chain right
// after the definition: it runs on every render, consumes the handoff stamp
// at most once, and defers the call past the render since the flow sets
// state. The lookahead pins the match to the definition's real end (the
// useRef(!1) that follows it), not a lookalike closing inside the body.
const spawnMatch = matchOne(
  "spawn flow + handoff kick",
  /,([$\w]+)=\(([$\w]+)\)=>\{if\(([$\w]+)\.current\|\|([$\w]+)\.current!==null\)return;[\s\S]{100,1500}?Couldn't start a new session[\s\S]{0,500}?\}\)\},(?=[$\w]+=[$\w]+\.useRef\(!1\))/g,
);
const spawn = spawnMatch[1];
js =
  js.slice(0, spawnMatch.index + spawnMatch[0].length) +
  `_nssKick=(globalThis._newSessionShortcutAt&&Date.now()-globalThis._newSessionShortcutAt<8e3&&(globalThis._newSessionShortcutAt=0,setTimeout(()=>${spawn}(${origin}),0)),0),` +
  js.slice(spawnMatch.index + spawnMatch[0].length);
console.log("new-session-shortcut: spawn flow + handoff kick patched");

// FleetView's raw key handler, at the main-mode down-navigation branch:
//   if(ot.key==="down"||ot.ctrl&&ot.key==="n"){if(Zr(),jD.length>0){...Math.min(jD.length-1...
// Inserting before it takes ctrl+n over for new-session and leaves the rest
// of the branch (down arrow, multiline composer, list wrap) untouched. The
// sub-mode handlers earlier in the flow — rename navigation, the pending
// spawn's esc-to-cancel — still see their keys first.
replaceOne(
  "fleet ctrl+n",
  /if\(([$\w]+)\.key==="down"\|\|\1\.ctrl&&\1\.key==="n"\)\{if\(([$\w]+)\(\),([$\w]+)\.length>0\)\{([$\w]+)\(null\),([$\w]+)\(\(([$\w]+)\)=>Math\.min\(\3\.length-1/g,
  `if($1.ctrl&&$1.key==="n"){$2();${spawn}(${origin});return}$&`,
);

writeFileSync(jsPath, js);
