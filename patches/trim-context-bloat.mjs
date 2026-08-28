#!/usr/bin/env node
// trim-context-bloat: drop standing context from every session's system
// prompt.
//
//   userEmail    "The user's email address is ..." — the model does not need it
//   currentDate  "Today's date is ..." — a date with no time, stale in any
//                session that outlives midnight. A UserPromptSubmit hook that
//                echoes the live date and time is strictly better; see the
//                README.
//   model family "The most recent Claude models are ..." plus the full model-ID
//                table — guidance for writing code against the Claude API, paid
//                for in every session regardless of what the session is doing.
//   Platform     "Platform: linux" — process.platform, a strict subset of the
//                "OS Version:" line right below it, which is os.type() plus
//                os.release() on POSIX ("Linux 7.0.0-30-generic", "Darwin
//                24.6.0") and os.version() plus os.release() on Windows. The
//                platform is always legible from the line that stays.
//   Shell        "Shell: bash" — the raw login $SHELL, classified by nothing
//                but includes("zsh") and includes("bash"), so a fish or nushell
//                login shell is reported verbatim and invites syntax the Bash
//                tool cannot run: its executor only ever resolves a bash or zsh
//                binary (CLAUDE_CODE_SHELL is rejected unless its path names
//                one, and the fallback detection probes only those two). For a
//                bash or zsh user the line adds nothing the Bash tool
//                description does not already say. The builder also has
//                win32-only PowerShell variants, and this repo builds only for
//                macOS and Linux, so dropping the line unconditionally is safe.
//
// Four anchor sites. The first is the user-context builder, whose returned
// object carries the userEmail and currentDate entries; removing the entries
// removes the blocks, since the renderer walks whatever keys the object has
// (userEmail is already conditional there). The second is the model-family
// paragraph: its builder is found by the paragraph's own opening words, and the
// call to it — an entry in the environment preamble array, which is
// null-filtered — is replaced with null.
//
// The last two carry the environment block, both in one module and each the
// platform and shell text of one prompt arm: the <env> template literal, where
// the shell is a call that renders its own line, and the "# Environment" array,
// where platform and shell are sibling entries formatted from the environment
// snapshot. Both anchors span the platform text, the shell beside it and the
// "OS Version: " line that follows, and the spliced-out span leaves the block
// flowing straight from the working-directory lines into "OS Version:". That
// adjacency is also what excludes the bundle's other "Platform: ${...platform}"
// — the bug-report body template, which has no shell text next to it and is
// left untouched.
import { readFileSync, writeFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: trim-context-bloat.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

const fail = (msg) => {
  console.error(`ERROR: trim-context-bloat: ${msg}`);
  process.exit(1);
};

function matchesOf(label, regex, expected) {
  const matches = [...js.matchAll(regex)];
  if (matches.length !== expected)
    fail(
      `${label}: ${matches.length} matches, expected exactly ${expected} — bundle layout changed, refusing`,
    );
  return matches;
}

function splice(match, replacement) {
  js = js.slice(0, match.index) + replacement + js.slice(match.index + match[0].length);
}

// 1. The conditional userEmail entry, deleted whole.
splice(
  matchesOf(
    "userEmail context entry",
    /,\.\.\.([$\w]+)&&\{userEmail:`The user's email address is \$\{\1\}\.[^`]*`\}/g,
    1,
  )[0],
  "",
);

// 2. The unconditional currentDate entry, which closes the context object.
splice(
  matchesOf(
    "currentDate context entry",
    /,currentDate:`Today's date is \$\{[$\w]+\(\)\}\.`\}/g,
    1,
  )[0],
  "}",
);

// 3. The model-family paragraph. Its builder is a function declaration under a
// minified name; take the name from the definition, then neutralize its call
// sites — each one an entry in the environment preamble array, pinned by the
// sentence that follows it there.
const paragraph = matchesOf(
  "model-family paragraph",
  /function ([$\w]+)\(\)\{let [$\w]+=[$\w]+\(\)\.latest_per_family;return`The most recent Claude models are /g,
  1,
)[0][1];
splice(
  matchesOf(
    "model-family paragraph call site",
    new RegExp(
      `${paragraph.replace(/\$/g, "\\$")}\\(\\),"Claude Code is available as a CLI in the terminal`,
      "g",
    ),
    1,
  )[0],
  'null,"Claude Code is available as a CLI in the terminal',
);

// 4. The Platform and Shell lines in the <env> template literal, removed as one
// span so the block runs from the working-directory lines to "OS Version:".
splice(
  matchesOf(
    "env template platform and shell lines",
    /Platform: \$\{[$\w]+\.platform\}\n\$\{[$\w]+\(\)\}\nOS Version: /g,
    1,
  )[0],
  "OS Version: ",
);

// 5. The same two lines as consecutive entries in the "# Environment" array,
// each formatted from the environment snapshot the array renders.
splice(
  matchesOf(
    "env array platform and shell entries",
    /`Platform: \$\{([$\w]+)\(([$\w]+)\.platform\)\}`,`Shell: \$\{\1\(\2\.shell\)\}`,`OS Version: /g,
    1,
  )[0],
  "`OS Version: ",
);

writeFileSync(jsPath, js);
console.log(
  "trim-context-bloat: userEmail, currentDate, the model-family paragraph and the env Platform and Shell lines removed from the system prompt",
);
