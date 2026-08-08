#!/usr/bin/env bash
# Build a patched Claude Code binary from the stock one.
#
#   apply-display-patches.sh <version> <output-binary>
#
# Pure: reads versions/<version>.orig and writes the candidate to
# <output-binary>. It never touches the live launch path — archiving, stamping
# and relinking are background-port.sh's job, after the functional suite passes.
#
# The patch set, in application order. Each id is a script in patches/ with a
# header comment explaining what it changes and why:
#
#   no-collapse-reads          Read/Grep/Glob shown individually, not "Read 3 files"
#   cron-visibility            cron-fired prompts render, and reach the model
#                              with a CronJob prefix
#   tool-defer-whitelist       tools named in CLAUDE_CODE_IMMEDIATE_TOOLS skip
#                              ToolSearch deferral
#   trim-context-bloat         drops userEmail, currentDate and the model-family
#                              paragraph from the system prompt
#   defer-workflow-description Workflow's description becomes a stub pointing at
#                              the workflow-tool skill, which holds the full text
#   defer-artifact-description ditto for Artifact and the artifact-tool skill
#   sticky-prompt-header       the previous-prompt header above the transcript
#                              shows whenever the prompt is off-screen (stock:
#                              only when scrolled up), in readable contrast
#   task-reminder-conditional  the periodic task_reminder nag only fires when
#                              the session's task list is non-empty
#   agents-view-shortcut       a rebindable shortcut opens the agents view from
#                              anywhere; stock only offers left-arrow on an
#                              empty idle prompt
#   mcp-per-subagent           each subagent gets its own process for the stdio
#                              MCP servers its frontmatter declares inline, and
#                              each such server sees CLAUDE_MCP_PER_AGENT=1
#   agent-list-models          the in-session agent list shows each row's
#                              model: subagents as "elapsed · model · tokens",
#                              the main row as a right-aligned "model · tokens"
#   agents-view-models         agents-view job rows show their --model flag
#                              in the age column ("fable · 3m")
#   task-notification-provenance
#                              agent task-notifications carry a <trigger>
#                              element naming what started the run: original
#                              launch, user message, SendMessage, or auto-resume
#
# Default-off, enable via patches-local/enable:
#   toolsearch-visibility      ToolSearch calls render with their query
#   thinking-visibility        thinking blocks render inline in the normal view
#                              (enable the two thinking patches together — pair)
#   thinking-no-fold           thinking stays its own transcript entry instead
#                              of folding into the "Thought for Ns" pill
#   thinking-latest            the collapsed group's pill shows its latest
#                              thinking block in full; click still opens all
#                              (conflicts with thinking-no-fold)
#
# Restore stock binary — copy to a new file and rename, never write the live
# binary in place. macOS caches a Mach-O's code signature per inode, while Linux
# rejects overwriting a running ELF with ETXTBSY:
#   cd <versions-dir> && cp <ver>.orig <ver>.new && mv <ver>.new <ver>
#   ln -f <ver> ~/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCHES="$ROOT/patches"
LOCAL="$ROOT/patches-local"
TWEAKCC="$ROOT/node_modules/.bin/tweakcc"
DEFAULT_PATCH_IDS="no-collapse-reads cron-visibility tool-defer-whitelist
           trim-context-bloat defer-workflow-description defer-artifact-description
           sticky-prompt-header task-reminder-conditional agents-view-shortcut
           mcp-per-subagent agent-list-models agents-view-models task-notification-provenance"

# Machine-local patch selection, id per line, both files optional and living
# in gitignored patches-local/ (so they count toward the promotion stamp's
# fingerprint like any other patch input): patches-local/enable turns on
# patches that ship default-off, patches-local/disable turns default ones off.
ENABLE="$([[ -f "$ROOT/patches-local/enable" ]] && tr '\n' ' ' < "$ROOT/patches-local/enable" || true)"
DISABLE="$([[ -f "$ROOT/patches-local/disable" ]] && tr '\n' ' ' < "$ROOT/patches-local/disable" || true)"
case " $DISABLE " in
  *" mcp-per-subagent "*) echo "ERROR: mcp-per-subagent is mandatory and cannot be disabled" >&2; exit 1;;
esac
PATCH_IDS=""
for id in $DEFAULT_PATCH_IDS $ENABLE; do
  case " $PATCH_IDS " in *" $id "*) continue;; esac
  case " $DISABLE " in *" $id "*) continue;; esac
  PATCH_IDS="$PATCH_IDS $id"
done
case " $PATCH_IDS " in *" thinking-no-fold "*) case " $PATCH_IDS " in *" thinking-latest "*)
  echo "ERROR: thinking-no-fold and thinking-latest conflict — thinking-no-fold keeps thinking out of the groups thinking-latest renders from" >&2
  exit 1;;
esac;; esac

# --print-ids: the effective id list, for the port to derive which suite
# tests to skip. Per-version drops are separate (the port already knows them).
if [[ "${1:-}" == "--print-ids" ]]; then echo $PATCH_IDS; exit 0; fi

VER="${1:?usage: apply-display-patches.sh <version> <output-binary>}"
OUT="${2:?usage: apply-display-patches.sh <version> <output-binary>}"
STOCK="$HOME/.local/share/claude/versions/$VER"

# A patch whose anchors drifted beyond re-anchoring can be listed in
# patches-local/<ver>/dropped so one cosmetic patch never pins the machine to an
# old version. mcp-per-subagent is behavioral and never droppable.
DROPPED=""
if [[ -f "$LOCAL/$VER/dropped" ]]; then DROPPED="$(tr '\n' ' ' < "$LOCAL/$VER/dropped")"; fi
case " $DROPPED " in
  *" mcp-per-subagent "*) echo "ERROR: mcp-per-subagent is mandatory and cannot be dropped" >&2; exit 1;;
esac

# patches-local/<ver>/<id>.mjs is a machine-local re-anchor written by the port
# agent for a version the committed patch no longer fits. Same filename wins.
resolve_patch() {
  local id="$1"
  [[ -f "$LOCAL/$VER/$id.mjs" ]] && echo "$LOCAL/$VER/$id.mjs" || echo "$PATCHES/$id.mjs"
}

# The stock backup is the canonical patch source: back it up on first sight of a
# version, always rebuild from it, so re-running over a patched install is safe.
if [[ ! -f "$STOCK.orig" ]]; then
  if [[ -f "$STOCK.patched" ]]; then
    echo "ERROR: $STOCK carries a .patched stamp — it is a patched binary, not stock; refusing to back it up as .orig" >&2
    exit 1
  fi
  cp "$STOCK" "$STOCK.orig"
  echo "Backed up stock binary to $STOCK.orig"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/claude-patching.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
JS="$WORK/cli-$VER.js"
"$TWEAKCC" unpack "$JS" "$STOCK.orig"

for id in $PATCH_IDS; do
  case " $DROPPED " in *" $id "*) echo "--- $id  DROPPED for $VER"; continue;; esac
  patch="$(resolve_patch "$id")"
  echo "--- $id  ($patch)"
  node "$patch" "$JS"
done

node --check "$JS"
# tweakcc repacks into an existing Claude Code binary, so the candidate starts
# as a copy of the stock one. A fresh file every time, never an overwrite of a
# live binary, per the code-signature and ETXTBSY caveats above.
cp "$STOCK.orig" "$OUT"
"$TWEAKCC" repack "$JS" "$OUT"

# Linux binaries stay unsigned. On macOS tweakcc's repack ad-hoc signs under a
# generated identifier, which makes every promotion a brand new app: TCC keys
# its grants to the signing identity, and an ad-hoc one is just the binary's own
# hash. A constant identifier plus the local certificate setup-signing.sh
# creates gives every patched binary the same identity, so the permissions
# granted once stick. Without that certificate the signature stays ad-hoc — the
# prompts return on each promotion, but at least they name something
# recognizable.
if [[ "$(uname)" == Darwin ]]; then
  if security find-identity -p codesigning -v 2>/dev/null | grep -q '"claude-patching"'; then
    codesign --force --sign claude-patching --identifier claude-patched "$OUT"
  else
    echo "No claude-patching signing identity — ad-hoc signing. Run setup-signing.sh to stop macOS re-asking for permissions after every promotion."
    codesign --force --sign - --identifier claude-patched "$OUT"
  fi
fi
echo "Candidate written to $OUT"
