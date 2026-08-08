#!/usr/bin/env node
// communicating-with-user: give every model the full "# Communicating with the
// user" section of the system prompt.
//
// The builder picks one of three texts from the session's model:
//
//   full     "# Communicating with the user" — write for a teammate catching
//            up, lead with the outcome, prose over fragments and arrow chains,
//            match the surrounding code's comment density. Reserved for the
//            model families the gate names, plus an internal escape hatch.
//   lean     a single sentence about matching the surrounding code, for
//            sessions running the simple system prompt.
//   reduced  "# Text output (does not apply to tool calls)" — the same ground
//            covered in clipped, bulleted form. What everything else gets,
//            Sonnet included.
//
// The patch forces the first branch, so every model reads the full section and
// the other two texts go unused. The two-family gate call is replaced by a
// constant; the branch body, including the sub-variant that adds a paragraph
// about text between tool calls, is left exactly as it was.
//
// The anchor is the section's own heading, which the branch returns as the
// first thing in its template literal — a content-bearing site that appears
// once in the bundle, so the guard being replaced can only be this one.
import { readFileSync, writeFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: communicating-with-user.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

// Stock: if(ANb(t)||xgu(t)){let r=RNb(t);return`# Communicating with the user
const anchor =
  /if\(([$\w]+)\(([$\w]+)\)\|\|([$\w]+)\(\2\)\)\{let ([$\w]+)=([$\w]+)\(\2\);return`# Communicating with the user/g;
const matches = [...js.matchAll(anchor)];
if (matches.length !== 1) {
  console.error(
    `ERROR: communicating-with-user: model gate: ${matches.length} matches, expected exactly 1 — bundle layout changed, refusing`,
  );
  process.exit(1);
}
const [, , model, , variant, subGate] = matches[0];
js = js.replace(
  anchor,
  `if(!0){let ${variant}=${subGate}(${model});return\`# Communicating with the user`,
);

writeFileSync(jsPath, js);
console.log(
  "communicating-with-user: the full Communicating with the user section now goes to every model",
);
