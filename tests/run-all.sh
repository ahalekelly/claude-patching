#!/usr/bin/env bash
# Functional suite for a candidate Claude Code binary: one behavioral test per
# applied patch, asserting the patched behavior rather than the patch's
# application, so a patch that anchors onto a lookalike site fails here.
#
#   run-all.sh <binary> [dropped-patch-id ...]
#
# Dropped ids are reported as skipped instead of run. Exit 0 = every test that
# ran passed and every applied patch had one. Run it against a stock binary as
# the negative control: every test must fail there, or it is not discriminating.
set -uo pipefail
TESTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${1:?usage: run-all.sh <binary> [dropped-patch-id ...]}"
shift
DROPPED=" $* "

# Each suite names what it can test, and each tests/<id>/run.py is a live-model
# test for that id — no second hand-maintained list to drift out of. An empty
# listing is a broken environment (uv, PATH), not an empty suite: refuse rather
# than run nothing and let the coverage check blame the patches.
PROXY_TESTS="$("$TESTS/proxy-suite.py" --list)"
PTY_TESTS="$("$TESTS/pty-suite.py" --list)"
LIVE_TESTS="$(for t in "$TESTS"/*/run.py; do basename "$(dirname "$t")"; done)"
for suite in PROXY_TESTS PTY_TESTS LIVE_TESTS; do
  [[ -n "${!suite}" ]] || { echo "FAIL  the $suite listing came back empty — suite runner broken?"; exit 1; }
done

pass=0 fail=0 skip=0

report() { # <status> <id> <detail>
  case "$1" in
    pass) pass=$((pass + 1)); printf 'pass  %s\n' "$2";;
    skip) skip=$((skip + 1)); printf 'skip  %-26s %s\n' "$2" "$3";;
    *)    fail=$((fail + 1)); printf 'FAIL  %-26s %s\n' "$2" "$3";;
  esac
}

# The reason a test gives, not the last line of its output: several tests dump a
# rendered screen or a message stream after the reason, to make a failure
# diagnosable.
reason() { printf '%s\n' "$1" | grep -m1 '^FAIL' || printf '%s\n' "$1" | tail -1; }

run() { # <runner> <id>
  local runner="$1" id="$2" out
  case "$DROPPED" in *" $id "*) report skip "$id" "patch dropped for this build"; return;; esac
  if out="$("$runner" "$BIN" "$id" 2>&1)"; then report pass "$id"
  else report fail "$id" "$(reason "$out")"; fi
}

# The README's table is the only description of the patch set, so a patch added
# or removed without it goes undocumented. Silent while it holds, because this
# suite also runs against a stock binary as a negative control, where anything
# that passes has lost its discrimination — a documentation check would show up
# there as exactly that.
readme_ids() { # [marker] — the ids of the table's rows, or only those carrying <marker>
  grep '^| `' "$TESTS/../README.md" | grep -F -- "${1-}" | sed 's/^| `\([^`]*\)`.*/\1/' | sort
}
differing() { comm -3 <(printf '%s\n' "$1") <(printf '%s\n' "$2") | tr -s '[:space:]' ' '; }
patch_ids="$(basename -s .mjs "$TESTS/../patches/"*.mjs | sort)"
off_ids="$(comm -13 <(printf '%s\n' $("$TESTS/../apply-display-patches.sh" --print-default-ids) | sort) \
                    <(printf '%s\n' "$patch_ids"))"
[[ "$(readme_ids)" == "$patch_ids" ]] ||
  report fail README-table "patches/ and the README's table differ on:$(differing "$(readme_ids)" "$patch_ids")"
[[ "$(readme_ids '*(default-off)*')" == "$off_ids" ]] ||
  report fail README-default-off \
    "the table's default-off marks and the default patch set differ on:$(differing "$(readme_ids '*(default-off)*')" "$off_ids")"

for id in $PROXY_TESTS; do run "$TESTS/proxy-suite.py" "$id"; done
for id in $PTY_TESTS; do run "$TESTS/pty-suite.py" "$id"; done

for id in $LIVE_TESTS; do
  case "$DROPPED" in *" $id "*) report skip "$id" "patch dropped for this build"; continue;; esac
  if out="$("$TESTS/$id/run.py" "$BIN" 2>&1)"; then report pass "$id"
  else report fail "$id" "$(reason "$out")"; fi
done

# Coverage. The suite is only a gate if every applied patch reaches it, so the
# applied set decides what must be tested — an untested patch fails here instead
# of silently not being run. tests/waivers is the escape hatch, and each entry
# has to say why a test cannot exist yet.
for id in $("$TESTS/../apply-display-patches.sh" --print-ids); do
  case "$DROPPED" in *" $id "*) continue;; esac
  case " $PROXY_TESTS $PTY_TESTS $LIVE_TESTS " in *[[:space:]]"$id"[[:space:]]*) continue;; esac
  waiver="$(awk -v id="$id" '$1 == id { $1 = ""; sub(/^ +/, ""); print; exit }' "$TESTS/waivers")"
  if [[ -n "$waiver" ]]; then report skip "$id" "no behavioral test — waived: $waiver"
  else report fail "$id" "applied with no behavioral test"; fi
done

printf '\n%d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skip"
exit $((fail > 0))
