#!/usr/bin/env node
/**
 * Patch to inject env-var-based feature flag overrides.
 *
 * The GrowthBook flag system has an env-override map that is only populated
 * for Anthropic-internal users. This patch un-gates it and populates it from
 * an env var on first access, giving runtime control over any feature flag
 * without recompilation.
 *
 * Usage:
 *   CLAUDE_CODE_FLAG_OVERRIDES='{"tengu_kairos_cron":true}' claude
 *   CLAUDE_INTERNAL_FC_OVERRIDES='{"tengu_kairos_cron":true}' claude   (CC-native name)
 *
 * The JSON object maps flag names to values. Flags not in the map fall
 * through to GrowthBook as normal. Invalid JSON is silently ignored.
 *
 * 2.1.209 change (major restructure):
 * Pre-2.1.x the override map was a do-nothing getter — `function X(){if(!Y)Y=!0;return Z}` —
 * where Z was always null and we injected the parse. CC now ships its own env-override
 * mechanism (`getEnvOverrides()` reading `CLAUDE_INTERNAL_FC_OVERRIDES`), but it is gated
 * behind `USER_TYPE==="ant"`. In the public build that constant folds to false, so the
 * whole parse branch is dead-code-eliminated down to an early return:
 *
 *   function xOr(){if(KIi)return kQe;return KIi=!0,kQe; <dead parse code…> }
 *                                     ^^^^^^^^^^^^^^^^^^^ always returns the null map
 *
 * where xOr=getter, KIi=parsed-guard, kQe=override map. We replace the dead early-return
 * with a guard-flip + our own JSON parse (honoring both env var names), then `return kQe`.
 * The original parse tail stays as harmless unreachable dead code. Because the native map
 * is fully wired into flag eval (hasGrowthBookEnvOverride / _CACHED_MAY_BE_STALE), populating
 * it is all that's needed.
 *
 * Patch invocation:
 *   node patch-flag-env-override.js <cli.js path>
 *   node patch-flag-env-override.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-flag-env-override.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// Match the dead-code override getter:
//   function X(){if(Y)return Z;return Y=!0,Z;
// X = getter fn, Y = parsed guard, Z = override map (null in public build)
const pattern = /function ([\w$]+)\(\)\{if\(([\w$]+)\)return ([\w$]+);return \2=!0,\3;/;
const match = content.match(pattern);

if (!match) {
  output.error('Could not find flag override getter function', [
    'Expected: function X(){if(Y)return Z;return Y=!0,Z;',
    'The GrowthBook override map getter may have changed structure'
  ]);
  process.exit(1);
}

const [original, fnName, guardVar, mapVar] = match;

output.discovery('flag override getter', fnName, {
  'guard variable': guardVar,
  'map variable': mapVar,
  'env vars': 'CLAUDE_CODE_FLAG_OVERRIDES, CLAUDE_INTERNAL_FC_OVERRIDES'
});

// Flip the guard once, parse env var into the map, return it. The original
// dead parse tail after this point stays unreachable and harmless.
// try/catch silently ignores bad JSON — flags fall through to GrowthBook.
const replacement = `function ${fnName}(){if(${guardVar})return ${mapVar};${guardVar}=!0;try{let _e=process.env.CLAUDE_CODE_FLAG_OVERRIDES||process.env.CLAUDE_INTERNAL_FC_OVERRIDES;if(_e)${mapVar}=JSON.parse(_e)}catch{}return ${mapVar};`;

output.modification('flag override getter', original, replacement);

if (dryRun) {
  output.result('dry_run', 'Flag override getter found — ready to patch');
  process.exit(0);
}

content = content.replace(original, replacement);

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Patched flag override getter (${fnName}) in ${targetPath}`);
  output.info('Set CLAUDE_CODE_FLAG_OVERRIDES=\'{"flag_name":value}\' to override any feature flag');
  output.info('Example: CLAUDE_CODE_FLAG_OVERRIDES=\'{"tengu_kairos_cron":true}\' claude');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}
