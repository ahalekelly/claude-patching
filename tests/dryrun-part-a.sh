#!/usr/bin/env bash
# Dry-run gate for mcp-per-subagent.mjs: applies the patch to a scratch copy of
# each unpacked bundle, checks the result parses, and checks that each guard
# fires when its precondition is broken.
#
#   dryrun-part-a.sh <unpacked-cli.js> [...]
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCH="$ROOT/patches/mcp-per-subagent.mjs"
W="$(mktemp -d "${TMPDIR:-/tmp}/dryrun-part-a.XXXXXX")"
trap 'rm -rf "$W"' EXIT
fails=0

expect_fail() { # <label> <js-file>
  if node "$PATCH" "$2" >/dev/null 2>"$W/err"; then
    echo "FAIL: $1 — patch applied, expected refusal"; fails=$((fails + 1))
  else
    echo "ok:   $1 — refused: $(head -c 120 "$W/err" | tr -d '\n')"
  fi
}

for src in "$@"; do
  name="$(basename "$src")"
  echo "=== $name"

  cp "$src" "$W/clean.js"
  if node "$PATCH" "$W/clean.js" && node --check "$W/clean.js"; then
    echo "ok:   $name — applies and parses"
  else
    echo "FAIL: $name — apply or node --check failed"; fails=$((fails + 1))
  fi
  if [[ "$(grep -c 'CLAUDE_MCP_PER_AGENT:"1"' "$W/clean.js")" != 1 ]]; then
    echo "FAIL: $name — canary not present exactly once"; fails=$((fails + 1))
  fi
  expect_fail "$name — anchor already patched (idempotence refusal)" "$W/clean.js"

  # Guard: anchor missing
  sed 's/isNewlyCreated:!0}/isNewlyCreatedX:!0}/' "$src" > "$W/g1.js"
  expect_fail "$name — anchor gone" "$W/g1.js"

  # Guard: key normalizer restructured
  sed 's/configErrorReason:i,\.\.\.s}=e/configErrorReason:i,foo:z,...s}=e/' "$src" > "$W/g2.js"
  expect_fail "$name — normalizer destructure changed" "$W/g2.js"

  # Guard: normalizer starts stripping env before hashing
  sed 's/delete a\.tools,/delete a.env,delete a.tools,/' "$src" > "$W/g3.js"
  expect_fail "$name — normalizer strips env" "$W/g3.js"

  # Guard: only one stdio spawn site left
  perl -0pe 's/CLAUDE_CODE_SESSION_ID:(\w+)\(\),CLAUDECODE:"1",\.\.\.(\w+)\.env\}/CLAUDE_CODE_SESSION_ID:$1(),CLAUDECODE:"1"}/' "$src" > "$W/g4.js"
  expect_fail "$name — no stdio spawn site spreads config.env" "$W/g4.js"
done

if [[ $fails -eq 0 ]]; then echo "PASS: part A dry-run"; else echo "FAILED: $fails check(s)"; fi
exit $((fails > 0))
