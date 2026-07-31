#!/usr/bin/env node
// defer-tool-descriptions: replace the Workflow and Artifact tool descriptions
// in the unpacked Claude Code bundle with short stubs that point at the
// workflow-tool / artifact-tool skills (~/.agents/skills/), which hold the full
// original text. Saves ~6.5k standing prompt tokens per session; the full
// guidance loads only in sessions that actually use the tool.
//
// Bundle layout this patch relies on (verify with an unpack + grep after
// updates): the Workflow description is a single ~20k-char template literal.
// The Artifact description is assembled in its prompt() from chunks: an intro
// chunk, optional Language / Supporting-files chunks (left untouched — they
// only appear when those features are enabled, and then their text is
// needed), a large rules chunk (the stub and skill cover it), and a
// runtime-capabilities chunk (the stub points at the artifact-capabilities
// skill).
//
// Mechanics, two modes. Literal targets: the target is a string literal that
// BEGINS with its anchor — find anchor occurrences whose preceding char is a
// quote, scan to the unescaped closing delimiter, and splice in the
// replacement as a JSON string (valid wherever the original literal sat,
// including in place of a template literal); per-target length windows filter
// out short UI labels that share an anchor. blankUse targets: the chunk's
// template literal contains ${} interpolations whose nested strings hold
// unescaped backticks, so it can't be bounded by an end-scan — instead derive
// the chunk's minified variable name from its definition and delete the
// ${name} use in the assembly template, leaving the definition behind as a
// dead string. Anything unexpected fails loudly so the wrapper aborts before
// repack and the binary stays untouched.
//
// Content drift: each target carries the sha256[:16] of its literal's raw
// source text in the stock bundle. The SKILL.md files are snapshots of that
// text, so when an update rewrites a description without moving the anchors,
// the hash mismatch fails the patch and names the skill to refresh — layout
// drift and content drift both abort loudly, binary untouched. After
// refreshing a SKILL.md from the new text (diff hint: unpack old and new
// binaries and compare the literals at the anchors below), update its hash
// here; the mismatch error prints the new value.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const TARGETS = [
  {
    label: "Workflow description",
    skill: "workflow-tool",
    hash: "54a255eba06f67ac",
    min: 3000, // the real description is ~20k chars
    max: 60000,
    anchor:
      "Execute a workflow script that orchestrates multiple subagents deterministically.",
    replacement: `Execute a workflow script that orchestrates multiple subagents deterministically (loops, conditionals, fan-out). Runs in the background: returns a task ID and the persisted script path; a <task-notification> arrives when it completes.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration: the keyword "ultracode" (or an ultracode-on session reminder), the user asking for a workflow / agent fan-out in their own words, a skill that instructs it, or a named saved workflow. A task that would merely benefit from parallelism does NOT count — use the Agent tool instead, or describe what a workflow could do and ask.

REQUIRED before writing or editing any workflow script: invoke the Skill tool with skill: "workflow-tool" to load the full scripting API (export const meta, agent()/parallel()/pipeline()/phase()/log(), args, budget, nested workflow(), resume semantics) and the orchestration patterns. Scripts are plain JavaScript, not TypeScript, and Date.now()/Math.random()/argless new Date() throw.`,
  },
  {
    label: "Artifact intro chunk",
    skill: "artifact-tool",
    hash: "6d161738624d6976",
    min: 800, // UI labels reusing this phrase are <300 chars; the chunk is ~1.5k
    max: 5000,
    anchor: "Render an HTML or Markdown file to an Artifact",
    replacement: `Render an HTML or Markdown file to an Artifact — a default-private web page hosted on claude.ai that the user can later choose to share. Write the page content to a file, then call Artifact with its path; action: "list" enumerates existing artifacts.

REQUIRED before any publish: invoke the Skill tool with skill: "artifact-tool" to load the full reference (update flows — same file path redeploys to the same URL, updating an artifact from an earlier conversation needs its url; listing and sharing semantics; title/description/favicon rules; runtime capabilities via the artifact-capabilities skill), and load the artifact-design skill before writing the page.

Hard rules that always apply: pages must be fully self-contained — a strict CSP blocks every external host, so inline all CSS/JS and embed assets as data: URIs; write bare page content (no <!DOCTYPE>/<html>/<head>/<body> tags — a skeleton wraps the file at publish time); Read any file you did not write completely before publishing it; never publish pages impersonating a real person or organization, fabricated records presented as genuine, or credential/payment-collecting flows — and if publishing is refused, do not suggest other ways to host the page.

`,
  },
  {
    label: "Artifact rules chunk",
    skill: "artifact-tool",
    hash: "662e12606a519911",
    anchor:
      "**To update**: Edit the file, then call Artifact again with the same file path",
    blankUse: true,
  },
  {
    label: "Artifact capabilities chunk",
    skill: "artifact-tool",
    hash: "b96d2fa287c9dc8b",
    anchor: "**Runtime capabilities** (optional): depending on what is enabled",
    blankUse: true,
  },
];

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: defer-tool-descriptions.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

const drift = [];
for (const target of TARGETS) {
  if (target.blankUse) blankUseSite(target);
  else replaceLiteral(target);
}
if (drift.length) {
  console.error("ERROR: upstream description text changed — refresh each SKILL.md below from the new text, then update its hash here:");
  for (const line of drift) console.error("  " + line);
  process.exit(1);
}
writeFileSync(jsPath, js);

function checkHash({ label, skill, hash }, text) {
  const actual = createHash("sha256").update(text).digest("hex").slice(0, 16);
  if (actual !== hash)
    drift.push(`${label}: hash ${actual} != expected ${hash} — refresh ~/.agents/skills/${skill}/SKILL.md`);
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
    if (j === -1) {
      console.error(`ERROR: ${label}: unterminated literal at ${i}`);
      process.exit(1);
    }

    const len = j - i;
    if (len < min) continue; // short lookalike (UI label), not the target
    if (len > max) {
      console.error(`ERROR: ${label}: literal at ${i} is ${len} chars (> ${max}) — bundle layout changed, refusing`);
      process.exit(1);
    }
    const next = js[j + 1];
    if (!",;})]".includes(next)) {
      console.error(`ERROR: ${label}: unexpected char ${JSON.stringify(next)} after literal at ${i} — refusing`);
      process.exit(1);
    }
    checkHash(target, js.slice(i, j));

    const encoded = JSON.stringify(replacement);
    js = js.slice(0, i - 1) + encoded + js.slice(j + 1);
    from = i - 1 + encoded.length;
    replaced++;
    console.log(`${label}: ${len} chars -> ${encoded.length} at ${i}`);
  }
  if (replaced !== 1) {
    console.error(`ERROR: ${label}: replaced ${replaced} literals, expected exactly 1 — bundle layout changed, refusing`);
    process.exit(1);
  }
}

function blankUseSite(target) {
  const { label, anchor } = target;
  const i = js.indexOf(anchor);
  if (i === -1) {
    console.error(`ERROR: ${label}: anchor not found`);
    process.exit(1);
  }
  if (js.indexOf(anchor, i + 1) !== -1) {
    console.error(`ERROR: ${label}: anchor appears more than once — refusing`);
    process.exit(1);
  }
  const quote = js[i - 1];
  if (quote !== '"' && quote !== "'" && quote !== "`") {
    console.error(`ERROR: ${label}: anchor not at a literal start`);
    process.exit(1);
  }
  const end = literalEnd(i, quote);
  if (end === -1) {
    console.error(`ERROR: ${label}: unterminated literal at ${i}`);
    process.exit(1);
  }
  checkHash(target, js.slice(i, end));
  const m = js.slice(Math.max(0, i - 40), i - 1).match(/([$A-Za-z_][$\w]*)=$/);
  if (!m) {
    console.error(`ERROR: ${label}: could not derive the chunk's variable name from its definition`);
    process.exit(1);
  }
  const use = "${" + m[1] + "}";
  const first = js.indexOf(use);
  if (first === -1) {
    console.error(`ERROR: ${label}: no ${use} use site found`);
    process.exit(1);
  }
  if (js.indexOf(use, first + 1) !== -1) {
    console.error(`ERROR: ${label}: multiple ${use} use sites — refusing`);
    process.exit(1);
  }
  js = js.slice(0, first) + js.slice(first + use.length);
  console.log(`${label}: removed ${use} from the assembly template`);
}
