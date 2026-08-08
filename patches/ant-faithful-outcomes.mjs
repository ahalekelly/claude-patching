#!/usr/bin/env node
// ant-faithful-outcomes: give every model the system prompt's faithful
// outcome-reporting rules — say it when tests fail, and quote the output; say
// it when a step was skipped; state a verified result plainly, without hedging.
//
// Stock ships them as the closing sentence of the action-caution section, which
// is built only for sessions running the simple system prompt. Everything else,
// Sonnet included, gets the long "# Executing actions with care" section
// instead: it covers confirming risky actions and not bypassing checks, but
// says nothing about how to report what happened afterwards.
//
// So the patch keeps the section's own gate for the caution prose — which would
// only restate what the long section already says — and returns the reporting
// sentence alone to everyone else. The sentence is taken from the bundle at
// patch time and sliced out of the single stored copy at runtime, so the prompt
// text is the bundle's own and exists in one place.
//
// Two content-bearing anchors, both appearing once: the section's opening words
// pin the builder, and the reporting sentence's opening words pin the split
// point inside it.
import { readFileSync, writeFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: ant-faithful-outcomes.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

const fail = (msg) => {
  console.error(`ERROR: ant-faithful-outcomes: ${msg}`);
  process.exit(1);
};

// Stock: function xNb(e){if(!sE(e))return null;return`For actions that are ...`}
const anchor =
  /function ([$\w]+)\(([$\w]+)\)\{if\(!([$\w]+)\(\2\)\)return null;return(`For actions that are hard to reverse or outward-facing[^`]*`)\}/g;
const matches = [...js.matchAll(anchor)];
if (matches.length !== 1)
  fail(
    `action-caution builder: ${matches.length} matches, expected exactly 1 — bundle layout changed, refusing`,
  );
const [whole, builder, model, gate, section] = matches[0];

const marker = "Report outcomes faithfully:";
const markerCount = section.split(marker).length - 1;
if (markerCount !== 1)
  fail(
    `reporting sentence: ${markerCount} occurrences in the section, expected exactly 1 — bundle layout changed, refusing`,
  );

const patched =
  `function ${builder}(${model}){` +
  `let __caution=${section},__report=__caution.indexOf(${JSON.stringify(marker)});` +
  `if(!${gate}(${model}))return __caution.slice(__report);` +
  `return __caution}`;
js = js.slice(0, matches[0].index) + patched + js.slice(matches[0].index + whole.length);

writeFileSync(jsPath, js);
console.log(
  "ant-faithful-outcomes: the faithful outcome-reporting rules now reach every model",
);
