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
//   capabilities  ditto, appended after a blank line
//   Language / Supporting-files chunks are left alone: they only appear when
//   those features are enabled, and then their text is needed.
//
// Two mechanics, because the chunks differ. A literal target BEGINS with its
// anchor: find anchor occurrences preceded by a quote, scan to the unescaped
// closing delimiter, and splice in the replacement as a JSON string; the length
// window rejects short UI labels sharing the anchor. A blankUse target's
// template literal contains ${} interpolations whose nested strings hold
// unescaped backticks, so it cannot be bounded by an end-scan — instead derive
// the chunk's minified name from its definition, a binding or a function
// returning the literal, and delete its ${name} / ${name(args)} use from the
// assembly template, leaving the definition behind as dead code.
//
// The skill is a build product. Before editing the bundle the patch renders
// every chunk it is about to defer — escapes decoded, ${} interpolations
// resolved to the values the bundle assigns them — joins them in the order
// prompt() would have, and writes the whole SKILL.md, fixed header and all. A
// description rewritten upstream therefore reaches the skill on the next build
// and prints SKILL SNAPSHOT CHANGED, so it lands as a diff to review in the
// skills directory instead of as guidance quietly dropped.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ID = "defer-artifact-description";
const SKILL = "artifact-tool";
const SKILL_PATH = join(homedir(), ".claude", "skills", SKILL, "SKILL.md");

const TARGETS = [
  {
    label: "intro chunk",
    min: 800, // UI labels reusing this phrase are <300 chars; the chunk is ~1.5k
    max: 5000,
    anchor: "Render an HTML file to an Artifact",
    replacement: `Render an HTML file to an Artifact — a default-private web page hosted on claude.ai that the user can later choose to share. Author the page as .html even from a markdown source (publish a .md only when a loaded skill instructs it), write it to a file, then call Artifact with its path; action: "list" enumerates existing artifacts.

REQUIRED before any publish: invoke the Skill tool with skill: "artifact-tool" to load the full reference (update flows — same file path redeploys to the same URL, updating an artifact from an earlier conversation needs its url; reading, listing, and sharing semantics; title/description/favicon rules; runtime capabilities via the artifact-capabilities skill), and load the artifact-design skill before writing the page.

Hard rules that always apply: pages must be fully self-contained — a strict CSP blocks every external host except Google Fonts (fonts.googleapis.com stylesheets and the fonts.gstatic.com files they pull), so inline all other CSS/JS and embed assets as data: URIs; write bare page content (no <!DOCTYPE>/<html>/<head>/<body> tags — a skeleton wraps the file at publish time); Read any file you did not write completely before publishing it; never publish pages impersonating a real person or organization, fabricated records presented as genuine, or credential/payment-collecting flows — and if publishing is refused, do not suggest other ways to host the page.

`,
  },
  {
    label: "rules chunk",
    anchor: "**To update**: Edit the file, then call Artifact again with the same file path",
    blankUse: true,
  },
  {
    label: "capabilities chunk",
    anchor: "**Runtime capabilities** (optional): depending on what is enabled",
    lead: "\n\n", // prompt() appends this chunk after a blank line
    blankUse: true,
  },
];

// Everything above the snapshot in SKILL.md. The patch owns the whole file, so
// this is the only place to edit the skill's framing.
const HEADER = `---
name: artifact-tool
description: Full reference for the Artifact tool — publish/update/read/list flows, cross-session URL targeting, sharing semantics, favicon/title rules, runtime capabilities, publishing constraints. Load before any Artifact call.
---

# Artifact tool reference

The Artifact tool's inline description is a short stub (patched into the Claude Code binary by \`~/.agents/claude-patching\`) that points here; this skill holds the full original guidance. Everything below is the tool's complete usage text.

The ${ID} patch writes this file from the binary it defers, so edit the patch rather than this file. Values the binary interpolates are inlined; an expression the patch cannot resolve to a literal is left as \`\${...}\`.

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

for (const target of TARGETS) {
  if (target.blankUse) blankUseSite(target);
  else replaceLiteral(target);
}
writeSnapshot(TARGETS.map((t) => (t.lead ?? "") + t.text).join(""));
writeFileSync(jsPath, js);

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
    target.text = renderLiteral(i, j, quote);

    const encoded = JSON.stringify(replacement);
    js = js.slice(0, i - 1) + encoded + js.slice(j + 1);
    from = i - 1 + encoded.length;
    replaced++;
    console.log(`${ID}: ${label}: ${len} chars -> ${encoded.length} at ${i}`);
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
  target.text = renderLiteral(i, end, quote);

  // A chunk is either bound to a name (`name=`) or returned by a function of
  // the conditions it varies on (`function name(args){return`), so its use in
  // the assembly template is `${name}` or `${name(args)}`.
  const before = js.slice(Math.max(0, i - 80), i - 1);
  const def =
    before.match(/([$A-Za-z_][$\w]*)=$/) ??
    before.match(/function ([$A-Za-z_][$\w]*)\([^()]*\)\{return$/);
  if (!def) fail(`${label}: could not derive the chunk's name from its definition`);
  const name = def[1];

  const uses = [];
  for (let at = js.indexOf("${" + name); at !== -1; at = js.indexOf("${" + name, at + 1)) {
    const after = js[at + 2 + name.length];
    // Anything else is a longer identifier that merely starts with the name.
    if (after === "}" || after === "(") uses.push([at, scanExpression(at + 2)]);
  }
  if (uses.length !== 1)
    fail(`${label}: ${uses.length} \${${name}} use sites, expected exactly 1 — refusing`);
  const [from, to] = uses[0];
  console.log(`${ID}: ${label}: removed ${js.slice(from, to)} from the assembly template`);
  js = js.slice(0, from) + js.slice(to);
}
