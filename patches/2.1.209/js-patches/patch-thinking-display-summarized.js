#!/usr/bin/env node
/**
 * Patch: opt back into summarized thinking text on Opus 4.7.
 *
 * 2.1.153 change:
 *   Anthropic introduced a `showThinkingSummaries` setting (default false) and
 *   gated the implicit `display:"summarized"` assignment on it.
 *
 * 2.1.209 change:
 *   The session-start builder was consolidated into a single display resolver
 *   function:
 *
 *     function wrc({explicitDisplay:e,isNonInteractive:t,outputFormat:r,verbose:n}){
 *       if(e)return e;                            // explicit display wins
 *       if(!t)return ovi()?"summarized":void 0;   // interactive: gated on ovi()
 *       if(r==="text"||r==="json"&&!n)return"omitted";
 *       return
 *     }
 *
 *   where `ovi()=Xn().showThinkingSummaries??!1`. Without the setting the
 *   interactive branch returns undefined and Opus ships thinking summaries
 *   omitted by default — the TUI streams the live reasoning briefly, then the
 *   completed assistant block reverts to a "thought for Ns" widget because no
 *   summary is persisted on the message.
 *
 *   We replace the interactive branch's `return ovi()?"summarized":void 0` with
 *   an unconditional `return"summarized"` so display defaults to "summarized" in
 *   every interactive session (matching pre-2.1.153 behavior). Explicit display
 *   (`if(e)return e`) and non-interactive output-format handling both keep
 *   working since they're separate branches.
 *
 * Site 2 (legacy / SDK path):
 *   The closure builder still computes a local `HH` from `j.thinkingConfig`
 *   that flows into `LG9(maxThinkingTokens, HH)` when an SDK client issues
 *   `set_max_thinking_tokens`. We patch that read with `?? "summarized"` so
 *   the SDK-driven rebuild also defaults to summarized when no display is
 *   inherited from the parent config.
 *
 * Usage:
 *   node patch-thinking-display-summarized.js <cli.js path>
 *   node patch-thinking-display-summarized.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-thinking-display-summarized.js [--check] <cli.js path>');
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

// ── Site 1: drop the ovi() gate on the interactive display default ──
// Minified (inside the wrc resolver):
//   if(!t)return ovi()?"summarized":void 0
// Generalized:
//   if(!<isNonInteractive>)return <settingsGate>()?"summarized":void 0
const site1 = /if\(!([$\w]+)\)return ([$\w]+)\(\)\?"summarized":void 0/;
const m1 = content.match(site1);

if (!m1) {
  output.error('Could not find session-start display gate', [
    'Expected: if(!isNonInteractive)return SETTING()?"summarized":void 0',
    'The thinking-config builder may have changed shape',
  ]);
  process.exit(1);
}

const [s1Original, nonInteractiveVar, settingFn] = m1;
const s1Replacement = `if(!${nonInteractiveVar})return"summarized"`;

output.discovery('session-start display gate', s1Original, {
  'isNonInteractive var': nonInteractiveVar,
  'setting fn': settingFn,
});

output.modification('drop showThinkingSummaries gate', s1Original, s1Replacement);

content = content.replace(s1Original, s1Replacement);
patchCount++;

// ── Site 2: SDK rebuild path — default HH to "summarized" when undefined ──
// Minified shape:
//   <out>=<cfg>.thinkingConfig&&<cfg>.thinkingConfig.type!=="disabled"?<cfg>.thinkingConfig.display:void 0
const site2 = /([$\w]+)=([$\w]+)\.thinkingConfig&&\2\.thinkingConfig\.type!=="disabled"\?\2\.thinkingConfig\.display:void 0/;
const m2 = content.match(site2);

if (!m2) {
  output.error('Could not find SDK rebuild display read (site 2)', [
    'Expected: VAR=VAR.thinkingConfig&&VAR.thinkingConfig.type!=="disabled"?VAR.thinkingConfig.display:void 0',
  ]);
  process.exit(1);
}

const [s2Original, outVar, cfgHolder] = m2;
const s2Replacement = `${outVar}=${cfgHolder}.thinkingConfig&&${cfgHolder}.thinkingConfig.type!=="disabled"?${cfgHolder}.thinkingConfig.display??"summarized":void 0`;

output.discovery('SDK rebuild display read', s2Original, {
  'display var': outVar,
  'config holder': cfgHolder,
});

output.modification('SDK rebuild display default',
  `${cfgHolder}.thinkingConfig.display`,
  `${cfgHolder}.thinkingConfig.display ?? "summarized"`);

content = content.replace(s2Original, s2Replacement);
patchCount++;

// ── Write ──

if (patchCount !== 2) {
  output.error(`Expected 2 patches, got ${patchCount}`);
  process.exit(1);
}

if (dryRun) {
  output.result('dry_run', `thinking-display-summarized: ${patchCount}/2 patches verified`);
  process.exit(0);
}

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `thinking-display-summarized: ${patchCount}/2 patches applied`);
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}
