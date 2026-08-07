#!/usr/bin/env node
// task-reminder-conditional: make the periodic task_reminder system reminder
// fire only when the session's task list is non-empty. Stock Claude Code nags
// "The task tools haven't been used recently..." on a timer regardless of
// whether task tracking is in use; patched, the reminder only appears when
// tasks exist but have gone unattended — the one case where it's useful.
//
// Anchor: the task_reminder dispatch case. The payload's .content is the
// current task list (the stock case appends it to the nag when non-empty), so
// the patch extends the existing gate with an empty-list bail:
//   case"task_reminder":{if(!eP()||Ete())return[];let r=e.content.map(...
//   ->                   {if(!eP()||Ete()||e.content.length===0)return[];...
import { readFileSync, writeFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: task-reminder-conditional.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

const regex =
  /case"task_reminder":\{if\(!([$\w]+)\(\)\|\|([$\w]+)\(\)\)return\[\];let ([$\w]+)=([$\w]+)\.content\.map\(/g;
const matches = [...js.matchAll(regex)];
if (matches.length !== 1) {
  console.error(
    `ERROR: task-reminder-conditional: ${matches.length} matches, expected exactly 1 — bundle layout changed, refusing`,
  );
  process.exit(1);
}
js = js.replace(
  regex,
  'case"task_reminder":{if(!$1()||$2()||$4.content.length===0)return[];let $3=$4.content.map(',
);
writeFileSync(jsPath, js);
console.log(
  "task-reminder-conditional: empty-task-list bail added to the task_reminder gate",
);
