#!/usr/bin/env node
// defer-artifact-description: shrink the Artifact tool's description — about
// 1.5k standing prompt tokens in every session — to a stub that points at the
// `artifact-tool` skill, which holds the full original text. Sessions pay for
// the publish/update reference and the runtime-capability contract only when
// they actually publish something.
//
// The description is assembled in the tool's prompt() from chunks:
//   intro         a plain literal — replaced with the stub
//   rules         a large template literal — its use is deleted
//   capabilities  ditto
//   Language / Supporting-files chunks are left alone: they only appear when
//   those features are enabled, and then their text is needed.
//
// Two mechanics, because the chunks differ. A literal target BEGINS with its
// anchor: find anchor occurrences preceded by a quote, scan to the unescaped
// closing delimiter, and splice in the replacement as a JSON string; the length
// window rejects short UI labels sharing the anchor. A blankUse target's
// template literal contains ${} interpolations whose nested strings hold
// unescaped backticks, so it cannot be bounded by an end-scan — instead derive
// the chunk's minified variable name from its definition and delete the ${name}
// use in the assembly template, leaving the definition behind as a dead string.
//
// Content drift: each target carries the sha256[:16] of its literal's raw
// source text in the stock bundle the skill was snapshotted from. Layout drift
// and content drift both abort loudly, binary untouched. After refreshing the
// skill's SKILL.md from the new text (unpack the old and new binaries and diff
// the literals at the anchors below), update the hashes here — the mismatch
// error prints the new values.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const SKILL = "artifact-tool";

const TARGETS = [
  {
    label: "intro chunk",
    hash: "e5af971e17318b68",
    min: 800, // UI labels reusing this phrase are <300 chars; the chunk is ~1.5k
    max: 5000,
    anchor: "Render an HTML or Markdown file to an Artifact",
    replacement: `Render an HTML or Markdown file to an Artifact — a default-private web page hosted on claude.ai that the user can later choose to share. Write the page content to a file, then call Artifact with its path; action: "list" enumerates existing artifacts.

REQUIRED before any publish: invoke the Skill tool with skill: "artifact-tool" to load the full reference (update flows — same file path redeploys to the same URL, updating an artifact from an earlier conversation needs its url; listing and sharing semantics; title/description/favicon rules; runtime capabilities via the artifact-capabilities skill), and load the artifact-design skill before writing the page.

Hard rules that always apply: pages must be fully self-contained — a strict CSP blocks every external host, so inline all CSS/JS and embed assets as data: URIs; write bare page content (no <!DOCTYPE>/<html>/<head>/<body> tags — a skeleton wraps the file at publish time); Read any file you did not write completely before publishing it; never publish pages impersonating a real person or organization, fabricated records presented as genuine, or credential/payment-collecting flows — and if publishing is refused, do not suggest other ways to host the page.

`,
  },
  {
    label: "rules chunk",
    hash: "f73d519cfd381bc2",
    anchor: "**To update**: Edit the file, then call Artifact again with the same file path",
    blankUse: true,
  },
  {
    label: "capabilities chunk",
    hash: "9b98ebf921a530f2",
    anchor: "**Runtime capabilities** (optional): depending on what is enabled",
    blankUse: true,
  },
];

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: defer-artifact-description.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

const fail = (msg) => {
  console.error(`ERROR: defer-artifact-description: ${msg}`);
  process.exit(1);
};

const drift = [];
for (const target of TARGETS) {
  if (target.blankUse) blankUseSite(target);
  else replaceLiteral(target);
}
if (drift.length) {
  console.error(
    `ERROR: defer-artifact-description: the Artifact description text changed — refresh the ${SKILL} skill's SKILL.md from the new text, then update the hashes here:`,
  );
  for (const line of drift) console.error("  " + line);
  process.exit(1);
}
writeFileSync(jsPath, js);

function checkHash({ label, hash }, text) {
  const actual = createHash("sha256").update(text).digest("hex").slice(0, 16);
  if (actual !== hash) drift.push(`${label}: hash ${actual} != expected ${hash}`);
}

// Index of a literal's closing delimiter; `start` is the first content char.
// Template literals need a real scan: ${} interpolations may nest strings and
// further template literals, so a flat search for the closing backtick lands
// inside an interpolation.
function literalEnd(start, quote) {
  if (quote === "`") return scanTemplate(start);
  let i = start;
  while (i < js.length && js[i] !== quote) i += js[i] === "\\" ? 2 : 1;
  return i < js.length ? i : -1;
}

function scanTemplate(start) {
  let i = start;
  while (i < js.length) {
    if (js[i] === "\\") { i += 2; continue; }
    if (js[i] === "`") return i;
    if (js[i] === "$" && js[i + 1] === "{") { i = scanExpression(i + 2); continue; }
    i++;
  }
  return -1;
}

// First index after the "}" closing a ${...} interpolation; `start` is the
// first char after "${". Skips string and template-literal contents so their
// braces don't count toward depth.
function scanExpression(start) {
  let depth = 1;
  let i = start;
  while (i < js.length) {
    const c = js[i];
    if (c === '"' || c === "'") {
      const end = literalEnd(i + 1, c);
      if (end === -1) return js.length;
      i = end + 1;
    } else if (c === "`") {
      const end = scanTemplate(i + 1);
      if (end === -1) return js.length;
      i = end + 1;
    } else {
      if (c === "{") depth++;
      if (c === "}" && --depth === 0) return i + 1;
      i++;
    }
  }
  return js.length;
}

function replaceLiteral(target) {
  const { label, anchor, replacement, min, max } = target;
  let replaced = 0;
  let from = 0;
  while (true) {
    const i = js.indexOf(anchor, from);
    if (i === -1) break;
    from = i + anchor.length;

    const quote = js[i - 1];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue; // anchor mid-string (e.g. quoted in other prose)

    const j = literalEnd(i, quote);
    if (j === -1) fail(`${label}: unterminated literal at ${i}`);

    const len = j - i;
    if (len < min) continue; // short lookalike (UI label), not the target
    if (len > max) fail(`${label}: the literal at ${i} is ${len} chars (> ${max}) — bundle layout changed, refusing`);
    const next = js[j + 1];
    if (!",;})]".includes(next))
      fail(`${label}: unexpected char ${JSON.stringify(next)} after the literal at ${i} — refusing`);
    checkHash(target, js.slice(i, j));

    const encoded = JSON.stringify(replacement);
    js = js.slice(0, i - 1) + encoded + js.slice(j + 1);
    from = i - 1 + encoded.length;
    replaced++;
    console.log(`defer-artifact-description: ${label}: ${len} chars -> ${encoded.length} at ${i}`);
  }
  if (replaced !== 1)
    fail(`${label}: replaced ${replaced} literals, expected exactly 1 — bundle layout changed, refusing`);
}

function blankUseSite(target) {
  const { label, anchor } = target;
  const i = js.indexOf(anchor);
  if (i === -1) fail(`${label}: anchor not found`);
  if (js.indexOf(anchor, i + 1) !== -1) fail(`${label}: anchor appears more than once — refusing`);
  const quote = js[i - 1];
  if (quote !== '"' && quote !== "'" && quote !== "`") fail(`${label}: anchor not at a literal start`);
  const end = literalEnd(i, quote);
  if (end === -1) fail(`${label}: unterminated literal at ${i}`);
  checkHash(target, js.slice(i, end));

  const m = js.slice(Math.max(0, i - 40), i - 1).match(/([$A-Za-z_][$\w]*)=$/);
  if (!m) fail(`${label}: could not derive the chunk's variable name from its definition`);
  const use = "${" + m[1] + "}";
  const first = js.indexOf(use);
  if (first === -1) fail(`${label}: no ${use} use site found`);
  if (js.indexOf(use, first + 1) !== -1) fail(`${label}: multiple ${use} use sites — refusing`);
  js = js.slice(0, first) + js.slice(first + use.length);
  console.log(`defer-artifact-description: ${label}: removed ${use} from the assembly template`);
}
