#!/usr/bin/env node
// defer-workflow-description: replace the Workflow tool's description — a
// single ~20k-char template literal, and about 5k standing prompt tokens in
// every session — with a short stub that points at the `workflow-tool` skill.
// The skill holds the full original text, so sessions pay for the scripting
// API and orchestration patterns only when they actually write a workflow.
//
// Mechanics: the description is a string literal that BEGINS with its anchor
// sentence. Find anchor occurrences whose preceding character is a quote, scan
// to the unescaped closing delimiter, and splice the replacement in as a JSON
// string — valid wherever the original literal sat, including in place of a
// template literal. The length window rejects short UI labels that reuse the
// same sentence. Anything unexpected fails loudly, so the build aborts before
// repack and the binary stays untouched.
//
// Content drift: HASH is the sha256[:16] of the literal's raw source text in
// the stock bundle the skill was snapshotted from. When an update rewrites the
// description without moving the anchor, the mismatch fails the patch and says
// so — refresh the skill's SKILL.md from the new text (unpack the old and new
// binaries and diff the literals at the anchor), then paste the printed hash
// in here.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const SKILL = "workflow-tool";
const HASH = "3427b9fba88d9302";
const MIN = 3000; // the real description is ~20k chars
const MAX = 60000;
const ANCHOR =
  "Execute a workflow script that orchestrates multiple subagents deterministically.";
const REPLACEMENT = `Execute a workflow script that orchestrates multiple subagents deterministically (loops, conditionals, fan-out). Runs in the background: returns a task ID and the persisted script path; a <task-notification> arrives when it completes.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration: the keyword "ultracode" (or an ultracode-on session reminder), the user asking for a workflow / agent fan-out in their own words, a skill that instructs it, or a named saved workflow. A task that would merely benefit from parallelism does NOT count — use the Agent tool instead, or describe what a workflow could do and ask.

REQUIRED before writing or editing any workflow script: invoke the Skill tool with skill: "workflow-tool" to load the full scripting API (export const meta, agent()/parallel()/pipeline()/phase()/log(), args, budget, nested workflow(), resume semantics) and the orchestration patterns. Scripts are plain JavaScript, not TypeScript, and Date.now()/Math.random()/argless new Date() throw.`;

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: defer-workflow-description.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

const fail = (msg) => {
  console.error(`ERROR: defer-workflow-description: ${msg}`);
  process.exit(1);
};

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

let replaced = 0;
let from = 0;
while (true) {
  const i = js.indexOf(ANCHOR, from);
  if (i === -1) break;
  from = i + ANCHOR.length;

  const quote = js[i - 1];
  if (quote !== '"' && quote !== "'" && quote !== "`") continue; // the sentence quoted inside other prose

  const j = literalEnd(i, quote);
  if (j === -1) fail(`unterminated literal at ${i}`);

  const len = j - i;
  if (len < MIN) continue; // a short lookalike (UI label), not the description
  if (len > MAX) fail(`the literal at ${i} is ${len} chars (> ${MAX}) — bundle layout changed, refusing`);
  const next = js[j + 1];
  if (!",;})]".includes(next))
    fail(`unexpected char ${JSON.stringify(next)} after the literal at ${i} — refusing`);

  const actual = createHash("sha256").update(js.slice(i, j)).digest("hex").slice(0, 16);
  if (actual !== HASH)
    fail(
      `the Workflow description text changed (hash ${actual}, expected ${HASH}) — ` +
        `refresh the ${SKILL} skill's SKILL.md from the new text, then set HASH to ${actual}`,
    );

  const encoded = JSON.stringify(REPLACEMENT);
  js = js.slice(0, i - 1) + encoded + js.slice(j + 1);
  from = i - 1 + encoded.length;
  replaced++;
  console.log(`defer-workflow-description: ${len} chars -> ${encoded.length} at ${i}`);
}
if (replaced !== 1)
  fail(`replaced ${replaced} literals, expected exactly 1 — bundle layout changed, refusing`);

writeFileSync(jsPath, js);
