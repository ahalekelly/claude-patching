#!/usr/bin/env node
/**
 * Patch to suppress duplicate background agent notifications (2.1.107+)
 *
 * When a background agent completes, its notification is enqueued
 * before TaskOutput can read the output (due to polling delay).
 * If the model calls TaskOutput during its turn, the notification
 * is still queued and fires after the turn — duplicating context.
 *
 * This patch uses a globalThis Set to coordinate between TaskOutput
 * and the notification consumers:
 *
 * 1. TaskOutput flags task IDs whose output was successfully read
 * 2. dispatch function filters flagged items from bulk-dequeued array
 * 3. Main loop consumer checks the flag before creating system message
 *
 * If the model never calls TaskOutput, notifications fire normally.
 *
 * Changes from 2.1.107:
 * - Patch Point 2 rewritten: the dispatch function (xu9) was restructured.
 *   The bulk-dispatch tail is now `ep6(K),H(K).finally(()=>HB6(K)),{...}`
 *   instead of plain `H(K),{...}`, and the inline `agentId===void 0` peek
 *   filter is gone. We now match the `let MODE=$.mode,ARR=...;if(ARR.length
 *   ===0)return{processed:!1};` head plus the full return tail in one regex,
 *   capturing the mode + array vars and re-emitting the return verbatim.
 * - Points 1 and 3 unchanged from 2.1.107.
 *
 * Usage:
 *   node patch-quiet-notifications.js <cli.js path>
 *   node patch-quiet-notifications.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-quiet-notifications.js [--check] <cli.js path>');
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

// ── Patch Point 1: TaskOutput — flag task IDs whose output was read ──
//
// Pattern: $.taskRegistry.update(TASKID,(D)=>({...D,notified:!0})),{data:{retrieval_status:"success",task:await TASKFN(VAR)}}
// Occurs twice: non-blocking and blocking success paths in TaskOutput.call()
//
// We chain a globalThis Set add after the taskRegistry.update() call.

const taskOutputPattern = /([$\w]+)\.taskRegistry\.update\(([$\w]+),\(([$\w]+)\)=>\(\{\.\.\.\3,notified:!0\}\)\),(\{data:\{retrieval_status:"success",task:await ([$\w]+)\([$\w]+\)\}\})/g;

const taskOutputMatches = content.match(taskOutputPattern);

if (!taskOutputMatches || taskOutputMatches.length < 2) {
  output.error('Could not find TaskOutput success return patterns', [
    'Expected 2 matches for taskRegistry.update + retrieval_status:"success"',
    `Found: ${taskOutputMatches?.length ?? 0}`,
    'This might be an unsupported Claude Code version'
  ]);
  process.exit(1);
}

output.discovery('TaskOutput success paths', `${taskOutputMatches.length} matches`, {
  'first': taskOutputMatches[0].slice(0, 60) + '...',
  'second': taskOutputMatches[1].slice(0, 60) + '...'
});

content = content.replace(taskOutputPattern, (match, stateVar, taskId, inner, dataBlock, taskFn) => {
  patchCount++;
  const patched = `${stateVar}.taskRegistry.update(${taskId},(${inner})=>({...${inner},notified:!0})),(globalThis.__taskOutputRead=globalThis.__taskOutputRead||new Set).add(${taskId}),${dataBlock}`;
  output.modification(`TaskOutput success #${patchCount}`, match.slice(0, 50) + '...', patched.slice(0, 50) + '...');
  return patched;
});

// ── Patch Point 2: dispatch — filter suppressed items from bulk dequeue ──
//
// In 2.1.177 the dispatch function (xu9) looks like:
//   function xu9({executeInput:H}){
//     let $=g2q(Ak);
//     if(!$)return{processed:!1};
//     if(bu9($)||$.mode==="bash"){let f=[zCH(Ak)];return ep6(f),H(f).finally(()=>HB6(f)),{processed:!0}}
//     let q=$.mode,K=lWH((_)=>Ak(_)&&!bu9(_)&&_.mode===q);   // bulk dequeue
//     if(K.length===0)return{processed:!1};
//     return ep6(K),H(K).finally(()=>HB6(K)),{processed:!0}
//   }
//
// We match the `let MODE=$.mode,ARR=...;if(ARR.length===0)return{...};` head
// together with the full return tail (anchored by the trailing `var`), capture
// the mode + array vars, and inject the task-notification filter between the
// length check and the return — re-emitting the return verbatim.

const dispatchPattern = /(let ([$\w]+)=[$\w]+\.mode,([$\w]+)=[^;]+;if\(\3\.length===0\)return\{processed:!1\};)(return .+?\{processed:!0\}\})(var )/;

const dispatchMatch = content.match(dispatchPattern);

if (!dispatchMatch) {
  output.error('Could not find dispatch bulk-dequeue tail pattern', [
    'Expected: let MODE=$.mode,ARR=...;if(ARR.length===0)return{processed:!1};return ...,{processed:!0}}var ...',
    'This might be an unsupported Claude Code version'
  ]);
  process.exit(1);
}

const dispatchHead = dispatchMatch[1]; // let MODE=$.mode,ARR=...;if(ARR.length===0)return{processed:!1};
const modeVar = dispatchMatch[2];      // mode var (q)
const arrayVar = dispatchMatch[3];     // bulk-dequeued array (K)
const returnTail = dispatchMatch[4];   // return ep6(K),H(K).finally(()=>HB6(K)),{processed:!0}}
const varKeyword = dispatchMatch[5];   // var

output.discovery('dispatch tail', dispatchMatch[0].slice(0, 100) + '...', {
  'mode var': modeVar,
  'array var': arrayVar
});

// When mode is "task-notification", filter out already-read task IDs.
const filterBlock = [
  `if(${modeVar}==="task-notification"&&globalThis.__taskOutputRead?.size){`,
    `${arrayVar}=${arrayVar}.filter(function(_q){`,
      `var _t=typeof _q.value==="string"&&_q.value.match(/<task-id>([^<]+)<\\/task-id>/);`,
      `if(_t&&globalThis.__taskOutputRead.has(_t[1])){globalThis.__taskOutputRead.delete(_t[1]);return!1}`,
      `return!0`,
    `});`,
    `if(${arrayVar}.length===0)return{processed:!1}`,
  `}`,
].join('');

const dispatchPatched = dispatchHead + filterBlock + returnTail + varKeyword;

output.modification('dispatch tail',
  dispatchMatch[0].slice(0, 60) + '...',
  (dispatchHead.slice(0, 30) + filterBlock.slice(0, 30) + '...')
);

content = content.replace(dispatchMatch[0], () => dispatchPatched);
patchCount++;

// ── Patch Point 3: Main loop consumer — suppress if output already read ──
//
// The task-notification block uses a single `let` with comma-separated declarations:
//   let TEXT=...,TASKID=TEXT.match(/<task-id>.../),OUTPUT=TEXT.match(/<output-file>.../),...;
//   ENQUEUE({...});continue}
//
// IMPORTANT: We must NOT inject inside the let block (that breaks the comma chain).
// Instead, match through the entire let block's terminating semicolon, then inject
// the suppression check between the semicolon and the enqueue call.

const mainLoopPattern = /(if\([$\w]+\.mode==="task-notification"\)\{let [$\w]+=typeof [$\w]+\.value==="string"\?[$\w]+\.value:"",([$\w]+)=[$\w]+\.match\(\/<task-id>\(\[\^<\]\+\)<\\\/task-id>\/\),[^;]+;)/;

const mainLoopMatch = content.match(mainLoopPattern);

if (!mainLoopMatch) {
  output.error('Could not find main loop task-notification consumer pattern', [
    'Expected: if(VAR.mode==="task-notification"){let VAR=...;ENQUEUE({...})',
    'This might be an unsupported Claude Code version'
  ]);
  process.exit(1);
}

output.discovery('main loop consumer', mainLoopMatch[0].slice(0, 80) + '...');

const taskIdVar = mainLoopMatch[2]; // The variable holding the task-id match result

const mainLoopOriginal = mainLoopMatch[0];
// Inject after the let block's semicolon, before the enqueue call
const mainLoopSuppression = `if(${taskIdVar}&&globalThis.__taskOutputRead?.has(${taskIdVar}[1])){globalThis.__taskOutputRead.delete(${taskIdVar}[1]);continue}`;
const mainLoopPatched = mainLoopOriginal + mainLoopSuppression;

output.modification('main loop consumer', mainLoopOriginal.slice(0, 60) + '...', mainLoopPatched.slice(0, 60) + '...');

content = content.replace(mainLoopOriginal, () => mainLoopPatched);
patchCount++;

// ── Write result ──

if (dryRun) {
  output.result('dry_run', `All ${patchCount} patch points found`);
  process.exit(0);
}

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Applied ${patchCount} modifications to ${targetPath}`);
  output.info('Background agent notifications will be suppressed when TaskOutput has already read the output.');
  output.info('Restart Claude Code to apply the change.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}
