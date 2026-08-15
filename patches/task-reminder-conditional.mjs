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
//   case"task_reminder":{if(!Eee())return[];let r=e.content.map(...
//   ->                   {if(!Eee()||e.content.length===0)return[];...
// The gate is one or more negated feature checks joined by ||; the patch keeps
// whatever it finds and appends the bail.
import { readFileSync, writeFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: task-reminder-conditional.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

const gate =
  /case"task_reminder":\{if\((!?[$\w]+\(\)(?:\|\|!?[$\w]+\(\))*)\)return\[\];let ([$\w]+)=([$\w]+)\.content\.map\(/g;
const matches = [...js.matchAll(gate)];
if (matches.length !== 1) {
  console.error(
    `ERROR: task-reminder-conditional: ${matches.length} matches, expected exactly 1 — bundle layout changed, refusing`,
  );
  process.exit(1);
}

const m = matches[0];
const [, guards, list, payload] = m;
const patched =
  `case"task_reminder":{if(${guards}||${payload}.content.length===0)return[];` +
  `let ${list}=${payload}.content.map(`;
js = js.slice(0, m.index) + patched + js.slice(m.index + m[0].length);

writeFileSync(jsPath, js);
console.log(
  "task-reminder-conditional: empty-task-list bail added to the task_reminder gate",
);
