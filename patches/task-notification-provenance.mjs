#!/usr/bin/env node
// task-notification-provenance: every agent task-notification states what
// triggered the run that just stopped.
//
// Stock behavior: a <task-notification> carries task-id, status, summary and
// result, but not why the agent ran. The notification for an agent finishing
// its launch prompt is indistinguishable from one for an agent the user
// resumed by messaging it directly (agents view / SendMessage). An
// orchestrator reading the second kind cannot tell a user-initiated
// continuation from a rogue self-continuation, and can act against the
// user's actual instruction.
//
// Provenance is recorded when a prompt is DELIVERED to the agent, never when
// one is queued or attempted. A message queued for a still-running agent
// belongs to the run that eventually reads it, not to the run in flight, and a
// resume that throws — the live-agent guard, a stopped-by-user refusal, a
// forked-skill scoping refusal, a missing transcript — delivers nothing at all
// and must leave no trace to misattribute the agent's next genuine stop.
//
// The record lives on the task record as __ccTrigger, so it dies with the task
// and is rebuilt per run: the registry's register() carries a fixed whitelist
// of fields across a re-registration, so a run that never notifies has its
// record dropped by the next run's registration rather than outliving it. Text
// is flattened out of its parent (the concat-then-slice idiom) so a 300-char
// quote cannot pin a multi-megabyte prompt in memory.
//
// Three splices:
//  1. The agent resume entry, after the last of its throwing guards and after
//     the run's task record is registered — the two together are what make
//     "no record" mean "nothing was delivered". Skipped when the caller asks
//     for owner notification to be suppressed, since that run will not notify
//     and its record would only go stale.
//  2. The pending-message drain that hands queued messages to a running agent,
//     recording the last message actually delivered. The queue writer is left
//     alone: writing to the queue is not delivery.
//  3. The notification builder consumes the record into a <trigger> element
//     ahead of the stock <note>, and clears it — it only runs past the point
//     where the notification is known to be claimed. Agent task ids and agent
//     ids are the same key.
//
// Anchors: (1) the resume entry's destructured parameter list — promptOrigin,
// continueInterruptedTurn and suppressOwnerNotification co-occur nowhere else
// — plus, inside it, the suppression call that follows registration; (2) the
// drain's queued_command mapping; (3) the notification body's fixed <note>
// prose and the claimed/task destructure above it. All content-bearing,
// exact-count asserted, spliced by index. Splice 1 additionally asserts its
// position against the guards it must follow and the launch it must precede.
import { readFileSync, writeFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: task-notification-provenance.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

const fail = (msg) => {
  console.error(`ERROR: task-notification-provenance: ${msg}`);
  process.exit(1);
};

const matchOne = (regex, what) => {
  const matches = [...js.matchAll(regex)];
  if (matches.length !== 1)
    fail(
      `${matches.length} matches for ${what}, expected exactly 1 — bundle layout changed, refusing`,
    );
  return matches[0];
};

// End of the block statement opening at `from`.
const blockEnd = (from) => {
  let depth = 0;
  for (let i = js.indexOf("{", from); i < js.length; i++) {
    if (js[i] === "{") depth++;
    else if (js[i] === "}" && --depth === 0) return i;
  }
  fail("unbalanced braces while measuring a function body — refusing");
};

// Both names must be ours alone: one is the element we render, the other the
// field we hang on the task record.
if (js.includes("<trigger>"))
  fail("the bundle already uses a <trigger> element — refusing");
if (js.includes("__ccTrigger"))
  fail("the bundle already uses a __ccTrigger field — refusing");

// The quote is flattened with the concat-then-slice idiom: a bare .slice() of
// a long prompt is a V8 SlicedString that keeps the whole parent alive.
const trigger = (kind, from, text) =>
  `{kind:${kind},from:${from},` +
  `text:(" "+(""+(${text}??"")).slice(0,300)).slice(1),` +
  `cut:(""+(${text}??"")).length>300}`;

// Splice 1: the resume entry records the prompt it is about to deliver.
{
  const m = matchOne(
    /async function [$\w]+\(\{agentId:([$\w]+),prompt:([$\w]+),promptOrigin:([$\w]+),[^{}]*continueInterruptedTurn:([$\w]+),[^{}]*suppressOwnerNotification:([$\w]+),[^{}]*\}(?:,[$\w]+)*\)\{/g,
    "the agent resume entry",
  );
  const [, agent, prompt, origin, cont, suppress] = m;
  const bodyStart = m.index + m[0].length;
  const body = js.slice(bodyStart, blockEnd(bodyStart - 1));

  // The live-agent guard is what makes a recordless notification mean the run
  // was never handed anything.
  if (!body.includes("is already running or being resumed"))
    fail(
      "the resume entry no longer guards against live agents — cannot infer that recordless notifications delivered nothing, refusing",
    );

  const registry = (() => {
    const found = [...body.matchAll(/\{taskRegistry:([$\w]+)\}=/g)];
    if (found.length !== 1)
      fail(
        `${found.length} taskRegistry destructures in the resume entry, expected exactly 1 — refusing`,
      );
    return found[0][1];
  })();

  // Registration is what puts this run's task record in the registry; an
  // update before it silently no-ops. The suppression call sits immediately
  // after it, and is the one statement naming both parameters.
  const suppressCall = (() => {
    const found = [
      ...body.matchAll(
        new RegExp(
          `if\\((?:[$\\w]+\\(\\),)*${suppress.replace(/\$/g, "\\$")}\\)[$\\w]+\\([$\\w]+\\.agentId,${registry.replace(/\$/g, "\\$")}\\);`,
          "g",
        ),
      ),
    ];
    if (found.length !== 1)
      fail(
        `${found.length} suppress-notification calls in the resume entry, expected exactly 1 — refusing`,
      );
    return found[0];
  })();
  const at = suppressCall.index + suppressCall[0].length;

  // Everything that can refuse the resume must already have run. The guards
  // are named individually because each one is a way to leave a stale record,
  // and the throw sweep catches any the bundle grows later. The sweep ends at
  // the launch — the success telemetry and the inline await of the run — since
  // past that point the prompt has been delivered and a throw is the run's own
  // failure travelling outward, which the record attributes correctly.
  const launch = (() => {
    const found = [...body.matchAll(/\("subagent_launch"\),[$\w]+\)try\{await /g)];
    if (found.length !== 1)
      fail(
        `${found.length} run launches in the resume entry, expected exactly 1 — cannot tell delivery from refusal, refusing`,
      );
    return found[0].index;
  })();
  for (const guard of [
    "has a malformed forked-skill scoping record",
    "No transcript found for agent ID",
    "alreadyCompleted",
  ]) {
    const idx = body.indexOf(guard);
    if (idx === -1)
      fail(`the resume entry no longer contains its ${guard} guard — refusing`);
    if (idx > at)
      fail(
        `the resume entry's ${guard} guard now runs after delivery — recording there would survive a refused resume, refusing`,
      );
  }
  if (launch < at)
    fail(
      "the resume entry launches the run before the recording point — refusing",
    );
  if (body.slice(at, launch).includes("throw "))
    fail(
      "the resume entry can still throw between the recording point and the launch — a refused resume would leave a record that misattributes the next stop, refusing",
    );

  js =
    js.slice(0, bodyStart + at) +
    `if(!${suppress})${registry}.update(${agent},(__ccT)=>({...__ccT,__ccTrigger:` +
    trigger(
      `${origin}?.kind??(${cont}?"interrupted-turn":void 0)`,
      `${origin}?.name??${origin}?.from`,
      prompt,
    ) +
    "}));" +
    js.slice(bodyStart + at);
}

// Splice 2: messages handed to an agent mid-run, recorded as they are drained
// for delivery. The last one is the one the run reads last.
{
  const m = matchOne(
    /function [$\w]+\(([$\w]+)\)\{let ([$\w]+)=\1\.agentId;if\(!\2\)return\[\];let ([$\w]+)=[$\w]+\(\2,\1\.taskRegistry\);return [$\w]+\(\3\),\3\.map\(\(([$\w]+)\)=>\(\{type:"queued_command",prompt:\4\.text,source_uuid:[$\w.]+\.randomUUID\(\),origin:\4\.origin,isMeta:\4\.isMeta\}\)\)\}/g,
    "the pending-message drain",
  );
  const [, context, agent, drained] = m;
  const drain = ".taskRegistry);";
  const at = m.index + m[0].indexOf(drain) + drain.length;
  js =
    js.slice(0, at) +
    `if(${drained}.length>0){let __ccM=${drained}[${drained}.length-1];` +
    `${context}.taskRegistry.update(${agent},(__ccT)=>({...__ccT,__ccTrigger:` +
    trigger("__ccM.origin?.kind", "__ccM.origin?.name??__ccM.origin?.from", "__ccM.text") +
    "}))}" +
    js.slice(at);
}

// Splice 3: the notification builder renders the record as <trigger>.
{
  const noteProse =
    "A task-notification fires each time this agent stops with no live background children of its own\\. The user can send it another message and resume it, so the same task-id may notify more than once\\.";
  const m = matchOne(
    new RegExp(
      "[$\\w]+\\(\\{value:[$\\w]+\\(\\{taskId:([$\\w]+),toolUseId:[$\\w]+,[^{}]*status:[$\\w]+,summary:([$\\w]+)\\([$\\w]+\\),body:`\\n<note>" +
        noteProse +
        "</note>",
      "g",
    ),
    "the agent notification builder",
  );
  const [, task, esc] = m;

  // The record and the registry reach the builder through this destructure,
  // which is also what proves the notification was claimed: everything below
  // it returns early when it was not, so clearing here cannot drop a record
  // that no notification carried.
  const scope = [
    ...js
      .slice(m.index - 2000, m.index)
      .matchAll(/let\{claimed:[$\w]+,task:([$\w]+)\}=[$\w]+\([$\w]+,([$\w]+)\)/g),
  ];
  if (scope.length !== 1)
    fail(
      `${scope.length} claimed/task destructures above the notification builder, expected exactly 1 — refusing`,
    );
  const [, record, registry] = scope[0];

  const at = m.index + m[0].indexOf("`\n<note>") + 1;
  js =
    js.slice(0, at) +
    "${(()=>{let __ccQ=" + record + "?.__ccTrigger;" +
    registry + ".update(" + task + ",(__ccT)=>{" +
    'if(!("__ccTrigger" in __ccT))return __ccT;' +
    "let{__ccTrigger:__ccX,...__ccR}=__ccT;return __ccR});" +
    "if(!__ccQ)return`\\n<trigger>first stop of the original run; " +
    "nothing was delivered to this agent after launch</trigger>`;" +
    "let __ccK=__ccQ.kind,__ccD=" +
    '__ccK==="human"?"a user message sent directly to this agent":' +
    '__ccK==="coordinator"?"a message from the main conversation (SendMessage)":' +
    '__ccK==="peer"?`a message from agent "${' + esc + '(""+(__ccQ.from??"unknown"))}" (SendMessage)`:' +
    '__ccK==="task-notification"?"a task-notification from one of its own background tasks":' +
    '__ccK==="observer-activity"?"an observer activity digest":' +
    '__ccK==="interrupted-turn"?"automatic resume of a turn interrupted by a restart":' +
    '__ccK?`a resume of kind "${' + esc + '(__ccK)}"`:' +
    '"an unattributed message or resume";' +
    'if((__ccK==="human"||__ccK==="coordinator"||__ccK==="peer"||!__ccK)&&__ccQ.text)' +
    "__ccD+=`: \"${" + esc + '(__ccQ.text)}${__ccQ.cut?"...":""}\"`;' +
    "return`\\n<trigger>this run was triggered by ${__ccD}</trigger>`})()}" +
    js.slice(at);
}

writeFileSync(jsPath, js);
console.log(
  "task-notification-provenance: agent task-notifications now carry a <trigger> element naming what started the run",
);
