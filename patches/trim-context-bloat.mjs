#!/usr/bin/env node
// trim-context-bloat: drop three standing paragraphs from every session's
// system prompt.
//
//   userEmail    "The user's email address is ..." — the model does not need it
//   currentDate  "Today's date is ..." — a date with no time, stale in any
//                session that outlives midnight. A UserPromptSubmit hook that
//                echoes the live date and time is strictly better; see the
//                README.
//   model family "The most recent Claude models are ..." plus the full model-ID
//                table — guidance for writing code against the Claude API, paid
//                for in every session regardless of what the session is doing.
//
// Two anchor sites. The first is the user-context builder, whose returned
// object carries the userEmail and currentDate entries; removing the entries
// removes the blocks, since the renderer walks whatever keys the object has
// (userEmail is already conditional there). The second is the model-family
// paragraph: its memoized builder is found by the paragraph's own opening
// words, and the calls to it — array entries in the environment preamble, which
// is null-filtered — are replaced with null.
import { readFileSync, writeFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: trim-context-bloat.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

const fail = (msg) => {
  console.error(`ERROR: trim-context-bloat: ${msg}`);
  process.exit(1);
};

function matchesOf(label, regex, expected) {
  const matches = [...js.matchAll(regex)];
  if (matches.length !== expected)
    fail(
      `${label}: ${matches.length} matches, expected exactly ${expected} — bundle layout changed, refusing`,
    );
  return matches;
}

function splice(match, replacement) {
  js = js.slice(0, match.index) + replacement + js.slice(match.index + match[0].length);
}

// 1. The conditional userEmail entry, deleted whole.
splice(
  matchesOf(
    "userEmail context entry",
    /,\.\.\.([$\w]+)&&\{userEmail:`The user's email address is \$\{\1\}\.`\}/g,
    1,
  )[0],
  "",
);

// 2. The unconditional currentDate entry, which closes the context object.
splice(
  matchesOf(
    "currentDate context entry",
    /,currentDate:`Today's date is \$\{[$\w]+\(\)\}\.`\}/g,
    1,
  )[0],
  "}",
);

// 3. The model-family paragraph. Its builder is memoized under a minified name;
// take the name from the definition, then neutralize its call sites — each one
// an entry in the environment preamble array, pinned by the sentence that
// follows it there.
const paragraph = matchesOf(
  "model-family paragraph",
  /([$\w]+)=[$\w]+\(\(\)=>\{let ([$\w]+)=[$\w]+\(\)\.latest_per_family;return`The most recent Claude models are /g,
  1,
)[0][1];
const callSites = matchesOf(
  "model-family paragraph call sites",
  new RegExp(
    `${paragraph}\\(\\),"Claude Code is available as a CLI in the terminal`,
    "g",
  ),
  2,
);
// Last first: an earlier splice would shift every later match index.
for (const site of callSites.reverse())
  splice(site, 'null,"Claude Code is available as a CLI in the terminal');

writeFileSync(jsPath, js);
console.log(
  "trim-context-bloat: userEmail, currentDate and the model-family paragraph removed from the system prompt",
);
