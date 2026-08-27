#!/usr/bin/env node
// hook-envelope-strip: a hook's stdout reaches the model as itself, not wrapped
// in an envelope naming the hook.
//
// Stock: when a SessionStart, UserPromptSubmit or UserPromptExpansion hook
// prints to stdout, the text is delivered to the model as
// "<hookName> hook success: <output>". A UserPromptSubmit hook that injects
// context — a live timestamp, usage state — pays that framing on every single
// prompt, and the framing describes the plumbing rather than the content. The
// hook's name and its exit status are operator concerns, and the transcript UI
// already shows both; the model only needs what the hook said. The prefix is
// dropped and the message becomes the hook's output verbatim, still wrapped and
// still flagged isMeta.
//
// One anchor site: the attachment-to-message conversion's "hook_success" case,
// pinned by the string literal, the three hookEvent comparisons that scope the
// case to the three prompt-injecting events, and the template text itself. The
// helper names around it are per-module minified aliases and are matched as
// wildcards, never written back in. " hook success: " occurs once in the whole
// bundle, so nothing else can wear this anchor — and the case's own literal
// keeps the edit off the adjacent "hook_additional_context" case, which carries
// its own framing and is left alone.
import { readFileSync, writeFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: hook-envelope-strip.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

const fail = (msg) => {
  console.error(`ERROR: hook-envelope-strip: ${msg}`);
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

const site = matchesOf(
  "hook success envelope",
  /case"hook_success":if\(([$\w]+)\.hookEvent!=="SessionStart"&&\1\.hookEvent!=="UserPromptSubmit"&&\1\.hookEvent!=="UserPromptExpansion"\)return\[\];if\(\1\.content===""\)return\[\];return\[[$\w]+\(\{content:[$\w]+\(`\$\{\1\.hookName\} hook success: \$\{\1\.content\}`\)/g,
  1,
)[0];
// Delete the prefix out of the template, leaving the wrapper call, the
// interpolated content and the isMeta flag exactly as the bundle has them.
splice(site, site[0].replace(`\${${site[1]}.hookName} hook success: `, ""));

writeFileSync(jsPath, js);
console.log(
  "hook-envelope-strip: hook stdout reaches the model unwrapped, without the \"<hook> hook success: \" prefix",
);
