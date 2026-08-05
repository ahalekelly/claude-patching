#!/usr/bin/env node
/**
 * turn-timestamp — append the turn-end wall-clock time to the completed-turn
 * status line above the input box.
 *
 * CC renders a whimsical past-tense verb + elapsed duration once a turn ends:
 *     "Baked for 2m 17s"
 * This patch appends the turn's authoritative end timestamp in local time:
 *     "Baked for 2m 17s [2026-08-05 13:22:01]"
 *
 * The render lives in component `KNa` (turn_duration message). The line is
 *     children:`${verb} for ${elapsed}`
 * inside `Eo.jsx(y,{dimColor:!0, ...})`. The message object (captured here as
 * `msg`) carries `msg.timestamp` — a `new Date().toISOString()` stamped by the
 * turn_duration factory `lSn` at turn end, so it is the true turn-end moment,
 * not a live render-time clock. We reformat it with `toLocaleString("sv-SE")`,
 * which yields the exact "YYYY-MM-DD HH:MM:SS" shape in the user's local zone.
 *
 * Only the completed-turn branch is touched; the sibling "Waiting for N
 * background agent(s) to finish" branch (still-running state) is left alone.
 *
 * Usage:
 *   node patch-turn-timestamp.js <cli.js path>
 *   node patch-turn-timestamp.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-turn-timestamp.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

let patchCount = 0;
const EXPECTED_PATCHES = 1;

// ── Capture: the turn_duration message variable ──
// `,FPf=IOe.budgetLimit!==void 0` — unique to KNa's render scope. The captured
// identifier is the message object carrying `.timestamp` (and `.durationMs`).
const msgPattern = /([$\w]+)\.budgetLimit!==void 0/;
const msgMatch = content.match(msgPattern);

if (!msgMatch) {
  // Expected: `,FPf=IOe.budgetLimit!==void 0` in component KNa
  output.error('Could not find turn_duration message variable (budgetLimit anchor)');
  process.exit(1);
}

const msg = msgMatch[1];
output.discovery('message variable', msg, [msgMatch[0]]);

// ── Patch Point: append timestamp to the "<verb> for <elapsed>" children ──
// Match: children:`${verb} for ${elapsed}` — capture up to (not incl.) the
// closing backtick, then splice in a nested `${msg.timestamp ? ...}` interp.
const childrenPattern = /(children:`\$\{[$\w]+\} for \$\{[$\w]+\})`/;
const childrenMatch = content.match(childrenPattern);

if (!childrenMatch) {
  // Expected: children:`${OPf} for ${NPf}` inside Eo.jsx(y,{dimColor:!0,...})
  output.error('Could not find completed-turn children template (verb/elapsed line)');
  process.exit(1);
}

output.discovery('children line', childrenMatch[0]);

// Nested template literal — safe inside the outer `${...}` interpolation.
// Guarded so a missing timestamp never renders "Invalid Date".
const inject =
  '${' + msg + '.timestamp?` [${new Date(' + msg + '.timestamp).toLocaleString("sv-SE")}]`:""}';

const before = childrenMatch[0];
const after = childrenMatch[1] + inject + '`';

content = content.replace(childrenPattern, () => after);
patchCount++;

output.modification('append turn-end timestamp', before, after);

// ── Write ──
if (patchCount !== EXPECTED_PATCHES) {
  output.error(`Expected ${EXPECTED_PATCHES} patches, got ${patchCount}`);
  process.exit(1);
}

if (dryRun) {
  output.result('dry_run', `turn-timestamp: ${patchCount}/${EXPECTED_PATCHES} patches verified`);
} else {
  fs.writeFileSync(targetPath, content, 'utf8');
  output.result('success', `turn-timestamp: ${patchCount}/${EXPECTED_PATCHES} patches applied`);
}
