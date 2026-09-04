#!/usr/bin/env bash
# Build a patched Claude Code binary from the stock one.
#
#   apply-display-patches.sh <version> <output-binary>
#
# Pure: reads versions/<version>.orig, the committed patches, and machine-local
# selection and drop files, then writes the candidate to <output-binary>. It
# never touches the live launch path — archiving, stamping and relinking are
# background-port.sh's job, after the functional suite passes.
#
# DEFAULT_PATCH_IDS below is the patch set, in application order. The README's
# table documents what each one changes; each patches/<id>.mjs header explains
# its anchor and why that anchor is safe.
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
DEFAULT_PATCH_IDS="cron-visibility tool-defer-whitelist
           trim-context-bloat hook-envelope-strip
           task-reminder-conditional mcp-per-subagent agents-view-models
           task-notification-provenance"

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

# --print-ids: the effective id list, for the port to derive which suite tests
# to skip and which patches must be covered. Per-version drops are separate (the
# port already knows them). --print-default-ids ignores the machine-local
# selection, which is how the suite checks the README's default-off marks.
if [[ "${1:-}" == "--print-ids" ]]; then echo $PATCH_IDS; exit 0; fi
if [[ "${1:-}" == "--print-default-ids" ]]; then echo $DEFAULT_PATCH_IDS; exit 0; fi

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

# patches-local holds only machine-local selection and per-version drops; every
# applied patch comes from the committed patch set.

# The stock backup is the canonical patch source: back it up on first sight of a
# version, always rebuild from it, so re-running over a patched install is safe.
if [[ ! -f "$STOCK.orig" ]]; then
  if [[ -f "$STOCK.patched" ]]; then
    echo "ERROR: $STOCK carries a .patched stamp — it is a patched binary, not stock; refusing to back it up as .orig" >&2
    exit 1
  fi
  # A port can fire while the updater is still writing the 270 MB binary, and a
  # backup taken then would be trusted as stock forever. The updater's finalize
  # step is what makes the file executable, so a binary that runs is a complete
  # one.
  if [[ ! -x "$STOCK" ]] || ! "$STOCK" --version >/dev/null 2>&1; then
    echo "ERROR: $STOCK does not execute — still being installed, or broken; refusing to back it up as .orig" >&2
    exit 1
  fi
  # Copy then rename, so a port killed mid-copy cannot leave a truncated file
  # under the canonical name.
  cp "$STOCK" "$STOCK.orig.new" && mv "$STOCK.orig.new" "$STOCK.orig"
  echo "Backed up stock binary to $STOCK.orig"
fi
[[ -s "$STOCK.orig" ]] || { echo "ERROR: $STOCK.orig is empty — delete it and re-run to back up the stock binary again" >&2; exit 1; }

# Scratch on real disk, beside the port's other state: /tmp can be a small
# memory-backed tmpfs with per-user quotas. A dir a killed run leaves behind
# is pruned with the rest of the version's state once the version is gone.
mkdir -p "$ROOT/port-state"
WORK="$(mktemp -d "$ROOT/port-state/build-$VER.XXXXXX")"
# /bin/rm, not rm: an agent PATH can carry an rm guard shim that exits nonzero,
# and under set -e that turns a successful build into a failed one at exit.
trap '/bin/rm -rf "$WORK"' EXIT
JS="$WORK/cli-$VER.js"
uv run --script "$ROOT/bunbundle.py" unpack "$STOCK.orig" "$JS"

for id in $PATCH_IDS; do
  case " $DROPPED " in *" $id "*) echo "--- $id  DROPPED for $VER"; continue;; esac
  echo "--- $id  ($PATCHES/$id.mjs)"
  node "$PATCHES/$id.mjs" "$JS"
done

# bunbundle repacks into an existing Claude Code binary, so the candidate starts
# as a copy of the stock one. A fresh file every time, never an overwrite of a
# live binary, per the code-signature and ETXTBSY caveats above. Repack syntax
# checks every module a patch touched, so there is no whole-bundle check here:
# the concatenation of many ESM module scopes is not itself a valid module.
cp "$STOCK.orig" "$OUT"
uv run --script "$ROOT/bunbundle.py" repack "$JS" "$OUT"

# Linux binaries stay unsigned. On macOS rewriting the copied binary invalidates
# the signature it inherited from the stock one, and the codesign below is what
# makes the candidate runnable again. TCC keys its grants to the signing
# identity, and an ad-hoc signature is just the binary's own hash, so every
# ad-hoc promotion looks like a brand new app. A constant identifier plus the
# local certificate setup-signing.sh creates gives every patched binary the same
# identity, so the permissions granted once stick. Without that certificate the
# signature stays ad-hoc — the prompts return on each promotion, but at least
# they name something recognizable.
if [[ "$(uname)" == Darwin ]]; then
  if security find-identity -p codesigning -v 2>/dev/null | grep -q '"claude-patching"'; then
    codesign --force --sign claude-patching --identifier claude-patched "$OUT"
  else
    echo "No claude-patching signing identity — ad-hoc signing. Run setup-signing.sh to stop macOS re-asking for permissions after every promotion."
    codesign --force --sign - --identifier claude-patched "$OUT"
  fi
fi
echo "Candidate written to $OUT"
