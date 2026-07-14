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
 * Changes for 2.1.209 (background-agent notification rework):
 * - The notification pipeline was rebuilt. CC now has its OWN atomic dedup at
 *   enqueue time (`if(task.notified)return` before enqueuePendingNotification),
 *   but that only blocks FUTURE enqueues — the race this patch targets
 *   (notification enqueued *before* TaskOutput reads the output, due to polling
 *   lag) still leaves an already-queued notification that must be filtered.
 * - Point 1 unchanged: still sets notified + our __taskOutputRead set.
 * - Point 2 unchanged: the mode-based bulk-dequeue dispatch still exists.
 * - Point 3 REWRITTEN: the old main-loop consumer that regex-extracted
 *   <task-id> from the queued string and enqueued a system message is gone.
 *   Task-notifications are now drained in the query loop via
 *   getQueuedCommandAttachments() — minified `Vnn`, whose
 *   `let r=e.filter((n)=>SET.has(n.mode))` selects prompt/task-notification
 *   items to convert into attachments. We inject the read-set suppression INTO
 *   that filter. Critically, the caller computes what to removeFromQueue() from
 *   the pre-filter snapshot, NOT from this filtered result — so dropping an item
 *   here suppresses the duplicate attachment WITHOUT wedging it in the queue
 *   (it is still removed as consumed). We can therefore safely delete the id
 *   from __taskOutputRead on suppression.
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

// ── Patch Point 3: attachment drain — suppress if output already read ──
//
// getQueuedCommandAttachments (minified Vnn) selects prompt + task-notification
// queue items to turn into attachment messages:
//   let r=e.filter((n)=>SET.has(n.mode));return Promise.all(r.map(...))
// The queued item's `.value` still carries the `<task-id>…</task-id>` XML, so we
// extend the filter callback: drop any task-notification whose task-id is in the
// read set. The caller's removeFromQueue() works off the pre-filter snapshot, so
// suppressed items are still consumed/removed — no queue wedge, and we can delete
// the id from the set here.

const drainPattern = /let ([$\w]+)=([$\w]+)\.filter\(\(([$\w]+)\)=>([$\w]+)\.has\(\3\.mode\)\)/;

const drainMatch = content.match(drainPattern);

if (!drainMatch) {
  output.error('Could not find attachment-drain notification filter pattern', [
    'Expected: let R=ARR.filter((n)=>SET.has(n.mode))',
    'The background-agent notification drain (getQueuedCommandAttachments) may have changed'
  ]);
  process.exit(1);
}

const drainResultVar = drainMatch[1]; // filtered result (r)
const drainArrVar = drainMatch[2];    // input array (e)
const drainItemVar = drainMatch[3];   // item param (n)
const drainSetVar = drainMatch[4];    // INLINE_NOTIFICATION_MODES set (Jg_)

output.discovery('attachment drain filter', drainMatch[0], {
  'item var': drainItemVar,
  'mode set var': drainSetVar
});

const drainReplacement =
  `let ${drainResultVar}=${drainArrVar}.filter((${drainItemVar})=>{` +
    `if(!${drainSetVar}.has(${drainItemVar}.mode))return!1;` +
    `if(${drainItemVar}.mode==="task-notification"&&${drainItemVar}.value&&globalThis.__taskOutputRead?.size){` +
      `var _m=(""+${drainItemVar}.value).match(/<task-id>([^<]+)<\\/task-id>/);` +
      `if(_m&&globalThis.__taskOutputRead.has(_m[1])){globalThis.__taskOutputRead.delete(_m[1]);return!1}` +
    `}` +
    `return!0})`;

output.modification('attachment drain filter', drainMatch[0], drainReplacement.slice(0, 60) + '...');

content = content.replace(drainMatch[0], () => drainReplacement);
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
