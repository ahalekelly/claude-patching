#!/usr/bin/env node
/**
 * Patch: pin the built-in Explore agent back to haiku.
 *
 * Background (CC 2.1.198 regression):
 *   The changelog for 2.1.198 reads:
 *     "The built-in Explore agent now inherits the main session's model
 *      (capped at opus) instead of running on haiku"
 *
 *   Historically (see the ~2.1.120 leaked source) the Explore agent's model was
 *     model: process.env.USER_TYPE === 'ant' ? 'inherit' : 'haiku'
 *   i.e. external users always got haiku — fast, cheap, and correct for a
 *   read-only search agent that shouldn't be reasoning. By 2.1.209 that ternary
 *   is gone and the definition is unconditionally `model:"inherit"`, so Explore
 *   rides the main session's model (capped at opus). That's expensive and
 *   pointless: explorers fan out over files and report back — they don't reason.
 *
 * Fix:
 *   Flip the Explore agent definition's `model:"inherit"` to `model:"haiku"`.
 *   The definition is uniquely anchored by `agentType:"Explore"`; there are
 *   other `model:"inherit"` sites in the bundle (default subagent model, etc.)
 *   that we deliberately leave alone. Runtime resolution (getAgentModel) treats
 *   a concrete alias like "haiku" as an explicit choice, and the
 *   CLAUDE_CODE_SUBAGENT_MODEL env override still wins if you want to force
 *   something else globally.
 *
 * Usage:
 *   node patch-explore-haiku.js <cli.js path>
 *   node patch-explore-haiku.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-explore-haiku.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// Match the Explore agent definition through its model field. Non-greedy across
// the intervening props (whenToUse, disallowedTools, source, baseDir); `[^}]`
// keeps us inside the single object literal, so we can't skip into a later one.
const pattern = /(agentType:"Explore",[^}]*?model:)"inherit"/;
const match = content.match(pattern);

if (!match) {
  output.error('Could not find Explore agent model field', [
    'Expected: agentType:"Explore",...,model:"inherit"',
    'The built-in agent definition shape may have changed, or Explore may already be pinned'
  ]);
  process.exit(1);
}

output.discovery('Explore agent model', 'inherit', {
  'target': 'haiku',
  'anchor': 'agentType:"Explore"'
});

const replacement = `${match[1]}"haiku"`;

output.modification('Explore agent model', 'model:"inherit"', 'model:"haiku"');

if (dryRun) {
  output.result('dry_run', 'Explore agent model field found — ready to pin to haiku');
  process.exit(0);
}

content = content.replace(match[0], () => replacement);

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Pinned Explore agent to haiku in ${targetPath}`);
  output.info('Restart Claude Code — the Explore subagent will run on haiku again.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}
