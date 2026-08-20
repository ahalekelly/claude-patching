#!/usr/bin/env node
// mcp-per-subagent: give every concurrently-running subagent its own stdio MCP
// server process for the servers its frontmatter declares inline.
//
// Stock behavior: connectToServer is a lodash memoize whose resolver is
// `${name}-${sha256(normalizedConfig).slice(0,16)}`, and the normalizer strips
// `scope` before hashing. Two subagents whose frontmatter declares a
// byte-identical inline mcpServers block therefore compute the same key, share
// one in-flight promise, and end up on one server process and one MCP session.
// Worse, both are flagged isNewlyCreated, so whichever subagent finishes first
// runs the shared client's cleanup and kills the process out from under its
// sibling.
//
// The config carries `agentSource` — the kind of location the definition came
// from (project settings, user settings, a plugin, an additional directory) —
// and the connect-cache key hashes it. That separates connections across source
// kinds, never across agents or across invocations of one agent, which is the
// collision this patch fixes.
//
// Anchor: the inline-spec branch of the subagent frontmatter resolver, which is
// the only place an agent-declared inline server config is materialized:
//   return{name:o,config:{...i,scope:"dynamic",agentSource:t},isNewlyCreated:!0}
// The patch appends two env vars to stdio configs there. Because the memoize
// key hashes `env`, a per-invocation slot number makes each subagent's config
// hash unique, which is the whole fix — the env vars are also spread into the
// spawned process (the stdio branch of connectToServer ends its env with
// `...config.env`), so CLAUDE_MCP_PER_AGENT doubles as a canary an MCP server
// can read to detect an unpatched harness.
//
// The slot is a monotonic counter, not the subagent's id: agentId is not in
// scope at the resolver, and the resolver runs exactly once per (subagent
// launch x declared server), so a counter separates connections just as well.
//
// Scoped to stdio deliberately: http/sse/claudeai-proxy inline servers have no
// process to duplicate, and `env` never reaches them. Named (string) frontmatter
// specs resolve to the session's own disk config and are left on the shared
// connection, as they should be. The main session's servers never pass through
// this function.
//
// Teardown needs no extra work: the per-agent client is isNewlyCreated, so the
// subagent's finally block closes it, and the client's own onclose handler
// deletes its cache entry from the connect memo — the cache self-heals.
import { readFileSync, writeFileSync } from "node:fs";

const jsPath = process.argv[2];
if (!jsPath) {
  console.error("usage: mcp-per-subagent.mjs <unpacked-cli.js>");
  process.exit(1);
}
let js = readFileSync(jsPath, "utf8");

const fail = (msg) => {
  console.error(`ERROR: mcp-per-subagent: ${msg}`);
  process.exit(1);
};

const regex =
  /return\{name:([$\w]+),config:\{\.\.\.([$\w]+),scope:"dynamic",agentSource:([$\w]+)\},isNewlyCreated:!0\}/g;
const matches = [...js.matchAll(regex)];
if (matches.length !== 1)
  fail(
    `${matches.length} matches for the inline agent MCP spec, expected exactly 1 — bundle layout changed, refusing`,
  );

// Guard 1: the connect-cache key normalizer still hashes `env`. It strips a
// fixed set of fields with a `delete` run before hashing what is left; if `env`
// ever joins that run the patch would still inject the canary while silently no
// longer separating connections, so refuse instead.
const keyNormalizer =
  /let\{scope:[$\w]+,pluginSource:[$\w]+,pluginPath:[$\w]+,agentSource:[$\w]+,declaredIn:[$\w]+,configError:[$\w]+,configErrorReason:[$\w]+,\.\.\.([$\w]+)\}=([$\w]+)/g;
const normalizerMatches = [...js.matchAll(keyNormalizer)];
if (normalizerMatches.length !== 1)
  fail(
    `${normalizerMatches.length} matches for the connect-cache key normalizer, expected exactly 1 — refusing (env may no longer be part of the cache key)`,
  );
const normalizerStart = normalizerMatches[0].index;
const normalizerEnd = js.indexOf('.digest("hex")', normalizerStart);
if (normalizerEnd < 0 || normalizerEnd - normalizerStart > 2000)
  fail(
    "the connect-cache key normalizer no longer ends in a hash of the stripped config — refusing",
  );
const stripped = [
  ...js
    .slice(normalizerStart, normalizerEnd)
    .matchAll(/delete\s+[$\w]+\.([$\w]+)/g),
].map((m) => m[1]);
if (stripped.includes("env"))
  fail(
    "the connect-cache key normalizer now strips `env` before hashing — refusing (per-agent env would no longer separate connections)",
  );

// Guard 2: both stdio spawn sites still spread config.env last, so the injected
// vars reach the child process. Claude Code ships two MCP client trees (v1
// default, v2 behind a flag); a count other than 2 means one was removed or
// restructured and the surviving site needs re-verifying by hand.
const stdioSpawn = /CLAUDE_CODE_SESSION_ID:[$\w]+\(\),CLAUDECODE:"1",\.\.\.([$\w]+)\.env\}/g;
const spawnMatches = [...js.matchAll(stdioSpawn)];
if (spawnMatches.length !== 2)
  fail(
    `${spawnMatches.length} stdio spawn sites spreading config.env, expected 2 (v1 + v2 client trees) — refusing`,
  );

js = js.replace(
  regex,
  'return{name:$1,config:{...$2,scope:"dynamic",agentSource:$3,...($2.type==="stdio"||$2.type===void 0&&"command" in $2?{env:{...$2.env,CLAUDE_MCP_PER_AGENT:"1",CLAUDE_MCP_AGENT_SLOT:"s"+(globalThis.__ccMcpAgentSlot=(globalThis.__ccMcpAgentSlot||0)+1)}}:{})},isNewlyCreated:!0}',
);
writeFileSync(jsPath, js);
console.log(
  "mcp-per-subagent: inline subagent stdio MCP servers now key per-invocation and carry CLAUDE_MCP_PER_AGENT=1",
);
