#!/usr/bin/env node
/**
 * Patch: gate sub-agent nesting behind an opt-in env var (default OFF).
 *
 * Background:
 *   A CC changelog entry reads:
 *     "Sub-agents can now spawn their own sub-agents (up to 5 levels deep)"
 *
 *   The runtime enforces this with a depth cap:
 *     let g = i3(agentContext);            // current agent's depth (main = 0)
 *     if (g >= KFr) throw …subagent_depth_cap…   // KFr = 5
 *   The main session is depth 0, a subagent it spawns is depth 1, etc. With the
 *   cap at 5, any agent up to depth 4 may spawn another — i.e. subagents can
 *   recurse. That's often undesirable: runaway fan-out, cost, and subagents
 *   reasoning about orchestration instead of doing their one job.
 *
 * Knob (default off):
 *   We replace the constant cap `KFr` with `process.env.CLAUDE_CODE_NESTED_SUBAGENTS ? KFr : 1`.
 *     - unset (default): effective cap = 1 → main (depth 0) still spawns
 *       subagents freely, but any subagent (depth >= 1) hits the cap and cannot
 *       nest. This restores pre-feature behavior.
 *     - CLAUDE_CODE_NESTED_SUBAGENTS=1 (any truthy value): effective cap = KFr
 *       (5) → original nested behavior.
 *
 *   The cap is the authoritative spawn gate: when a subagent tries to launch a
 *   child at depth >= cap, CC throws its own `subagent_depth_cap` error (the
 *   exact path already exercised when the real 5-deep limit is hit), so this is
 *   a sanctioned code path, not a novel failure mode.
 *
 * Usage:
 *   node patch-subagent-nesting-knob.js <cli.js path>
 *   node patch-subagent-nesting-knob.js --check <cli.js path>  (dry run)
 *
 *   # allow nested subagents again (up to 5 deep):
 *   CLAUDE_CODE_NESTED_SUBAGENTS=1 claude
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-subagent-nesting-knob.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// Anchor on the unique depth-cap throw. Capture the depth var + cap constant +
// error fn so we survive minifier renames.
//   DEPTH >= CAP)throw ERRFN("subagent_launch","subagent_depth_cap")
const pattern = /([$\w]+)>=([$\w]+)\)throw ([$\w]+)\("subagent_launch","subagent_depth_cap"\)/;
const match = content.match(pattern);

if (!match) {
  output.error('Could not find subagent depth-cap gate', [
    'Expected: DEPTH>=CAP)throw ERRFN("subagent_launch","subagent_depth_cap")',
    'The subagent nesting guard may have changed structure'
  ]);
  process.exit(1);
}

const [original, depthVar, capVar, errFn] = match;

output.discovery('subagent depth-cap gate', original.slice(0, 60) + '...', {
  'depth var': depthVar,
  'cap const': capVar,
  'error fn': errFn,
  'env knob': 'CLAUDE_CODE_NESTED_SUBAGENTS'
});

// Effective cap = env ? CAP : 1. Default off → subagents (depth>=1) cannot nest.
const replacement =
  `${depthVar}>=(process.env.CLAUDE_CODE_NESTED_SUBAGENTS?${capVar}:1))throw ${errFn}("subagent_launch","subagent_depth_cap")`;

output.modification('subagent nesting knob',
  `if(${depthVar}>=${capVar})throw …`,
  `if(${depthVar}>=(env?${capVar}:1))throw … (default cap 1)`);

if (dryRun) {
  output.result('dry_run', 'Subagent depth-cap gate found — ready to gate behind CLAUDE_CODE_NESTED_SUBAGENTS');
  process.exit(0);
}

content = content.replace(original, () => replacement);

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Gated subagent nesting behind CLAUDE_CODE_NESTED_SUBAGENTS in ${targetPath}`);
  output.info('Default: subagents cannot spawn subagents. Set CLAUDE_CODE_NESTED_SUBAGENTS=1 to allow up to 5-deep nesting.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}
