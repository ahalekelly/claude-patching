#!/usr/bin/env node
// cron-visibility: show scheduled-task prompts in the transcript, and tell the
// model they came from the scheduler.
//
// When a cron task fires, the session queues its prompt through a builder that
// marks the entry isMeta — meta prompts run but never render, so the only
// evidence of a fire is the answer appearing out of nowhere. The model is not
// told either: it sees a bare user turn indistinguishable from something the
// human typed.
//
// The patch clears isMeta and prefixes the prompt with "CronJob: ". One string
// carries both effects: the prefix is part of the queued value, so the rendered
// transcript row and the copy sent to the model agree.
//
// Anchor: the head of the queued-prompt builder's object literal, identified
// by its leading property run (value/mode/agentId/priority/isMeta/
// skipSlashCommands/modelScheduledOrigin). The scheduler's other
// enqueue site — the Kairos cron path — builds the same fields in a different
// order and does not lead with value, so the run is unique to the interactive
// scheduled-tasks fire. Only the two properties the patch changes are
// rewritten, so the builder's trailing fields are irrelevant to the anchor.
import { readFileSync, writeFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: cron-visibility.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

const builder =
  /\{value:([$\w]+),mode:"prompt",agentId:[$\w]+\(\),priority:"later",isMeta:!0,skipSlashCommands:!0,modelScheduledOrigin:!0/g;
const matches = [...js.matchAll(builder)];
if (matches.length !== 1) {
  console.error(
    `ERROR: cron-visibility: ${matches.length} matches for the scheduled-prompt builder, expected exactly 1 — bundle layout changed, refusing`,
  );
  process.exit(1);
}

const m = matches[0];
const prompt = m[1];
const patched = m[0]
  .replace(`{value:${prompt},`, `{value:"CronJob: "+${prompt},`)
  .replace("isMeta:!0,", "isMeta:!1,");
js = js.slice(0, m.index) + patched + js.slice(m.index + m[0].length);

writeFileSync(jsPath, js);
console.log('cron-visibility: fired prompts now render and reach the model as "CronJob: <prompt>"');
