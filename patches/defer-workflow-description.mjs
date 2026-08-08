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
// The skill is a build product. Before editing the bundle the patch renders the
// literal it is about to remove — escapes decoded, ${} interpolations resolved
// to the values the bundle assigns them — and writes the whole SKILL.md, fixed
// header and all. A description rewritten upstream therefore reaches the skill
// on the next build and prints SKILL SNAPSHOT CHANGED, so it lands as a diff to
// review in the skills directory instead of as guidance quietly dropped.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ID = "defer-workflow-description";
const SKILL = "workflow-tool";
const SKILL_PATH = join(homedir(), ".claude", "skills", SKILL, "SKILL.md");
const MIN = 3000; // the real description is ~20k chars
const MAX = 60000;
const ANCHOR =
  "Execute a workflow script that orchestrates multiple subagents deterministically.";
const REPLACEMENT = `Execute a workflow script that orchestrates multiple subagents deterministically (loops, conditionals, fan-out). Runs in the background: returns a task ID and the persisted script path; a <task-notification> arrives when it completes.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration: the keyword "ultracode" (or an ultracode-on session reminder), the user asking for a workflow / agent fan-out in their own words, a skill that instructs it, or a named saved workflow. A task that would merely benefit from parallelism does NOT count — use the Agent tool instead, or describe what a workflow could do and ask.

REQUIRED before writing or editing any workflow script: invoke the Skill tool with skill: "workflow-tool" to load the full scripting API (export const meta, agent()/parallel()/pipeline()/phase()/log(), args, budget, nested workflow(), resume semantics) and the orchestration patterns. Scripts are plain JavaScript, not TypeScript, and Date.now()/Math.random()/argless new Date() throw.`;

// Everything above the snapshot in SKILL.md. The patch owns the whole file, so
// this is the only place to edit the skill's framing.
const HEADER = `---
name: workflow-tool
description: Full reference for the Workflow tool — scripting API (meta, agent/parallel/pipeline/phase/log/args/budget/workflow), orchestration patterns, opt-in rules, resume. Load before writing or editing any Workflow script.
---

# Workflow tool reference

The Workflow tool's inline description is a short stub (patched into the Claude Code binary by \`~/.agents/claude-patching\`) that points here; this skill holds the full original guidance. Everything below is the tool's complete usage text.

The ${ID} patch writes this file from the binary it defers, so edit the patch rather than this file. Values the binary interpolates are inlined; an expression the patch cannot resolve to a literal is left as \`\${...}\`.

This machine configures a small workflow size guideline: keep workflows under ~5 agents unless the user's prompt calls for a different scale.

---

`;

const jsPath = process.argv[2];
if (!jsPath) {
  console.error(`usage: ${ID}.mjs <unpacked-cli.js>`);
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

const fail = (msg) => {
  console.error(`ERROR: ${ID}: ${msg}`);
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

// The text the model receives for the literal running from `start` to `end`:
// escapes decoded and ${} interpolations resolved.
function renderLiteral(start, end, quote) {
  if (quote !== "`") return decode(js.slice(start, end), quote);
  let out = "";
  let seg = start;
  let i = start;
  while (i < end) {
    if (js[i] === "\\") { i += 2; continue; }
    if (js[i] === "$" && js[i + 1] === "{") {
      const close = scanExpression(i + 2); // first index after the "}"
      out += decode(js.slice(seg, i), "`") + interpolate(js.slice(i + 2, close - 1));
      i = seg = close;
      continue;
    }
    i++;
  }
  return out + decode(js.slice(seg, end), "`");
}

// Literal source to runtime text, decoded by the engine that wrote the escapes.
// A template segment holds no unescaped backtick or "${", so it re-parses as a
// template literal of its own.
function decode(src, quote) {
  return new Function(`return ${quote}${src}${quote}`)();
}

// The text one ${...} produces. Its identifiers are looked up in the bundle and
// the expression evaluated over them; an expression reading anything the bundle
// does not fix to a literal stays verbatim, so the snapshot shows what varies.
function interpolate(expr) {
  const names = identifiers(expr);
  const values = names.map(constValue);
  if (values.some((v) => v === undefined)) return "${" + expr + "}";
  try {
    const out = new Function(...names, `return (${expr})`)(...values);
    return typeof out === "string" || typeof out === "number"
      ? String(out)
      : "${" + expr + "}";
  } catch {
    return "${" + expr + "}";
  }
}

// The identifiers an expression reads, skipping literal contents and the
// property names after a ".".
function identifiers(expr) {
  const names = new Set();
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < expr.length && expr[i] !== c) i += expr[i] === "\\" ? 2 : 1;
    } else if (/[$A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < expr.length && /[$\w]/.test(expr[j])) j++;
      if (expr[i - 1] !== ".") names.add(expr.slice(i, j));
      i = j - 1;
    }
  }
  return [...names];
}

// The value the bundle fixes a minified name to, when exactly one assignment
// gives it a string, number or boolean literal.
function constValue(name) {
  const re = new RegExp(`(?:^|[^$\\w.])${name.replace(/\$/g, "\\$")}=(?!=)`, "g");
  let at = -1;
  let m;
  while ((m = re.exec(js))) {
    if (at !== -1) return undefined; // assigned in more than one place
    at = m.index + m[0].length;
  }
  if (at === -1) return undefined;
  const quote = js[at];
  if (quote === '"' || quote === "'") {
    const end = literalEnd(at + 1, quote);
    return end === -1 ? undefined : decode(js.slice(at + 1, end), quote);
  }
  const rest = js.slice(at, at + 32);
  const num = rest.match(/^-?\d+(\.\d+)?(?![$\w.])/);
  if (num) return Number(num[0]);
  const bool = rest.match(/^!([01])(?![$\w])/);
  return bool ? bool[1] === "0" : undefined;
}

// Rewrite SKILL.md and say so when it moved. Content never fails the build —
// a changed description is news to review, not a reason to withhold the binary.
function writeSnapshot(text) {
  const content = HEADER + text + "\n";
  const existing = existsSync(SKILL_PATH) ? readFileSync(SKILL_PATH, "utf8") : null;
  if (existing === content) {
    console.log(`${ID}: skill snapshot unchanged (${SKILL_PATH})`);
    return;
  }
  mkdirSync(dirname(SKILL_PATH), { recursive: true });
  writeFileSync(SKILL_PATH, content);
  console.log(
    existing === null
      ? `${ID}: SKILL SNAPSHOT CREATED — ${SKILL_PATH}`
      : `${ID}: SKILL SNAPSHOT CHANGED — review the diff at ${SKILL_PATH}`,
  );
}

let snapshot = null;
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

  snapshot = renderLiteral(i, j, quote);

  const encoded = JSON.stringify(REPLACEMENT);
  js = js.slice(0, i - 1) + encoded + js.slice(j + 1);
  from = i - 1 + encoded.length;
  replaced++;
  console.log(`${ID}: ${len} chars -> ${encoded.length} at ${i}`);
}
if (replaced !== 1)
  fail(`replaced ${replaced} literals, expected exactly 1 — bundle layout changed, refusing`);

writeSnapshot(snapshot);
writeFileSync(jsPath, js);
