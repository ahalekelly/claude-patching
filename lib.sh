#!/usr/bin/env bash
# Shared platform seams and patch-set identity.
case "$(uname)" in
  Darwin)
    STAT_ID=(-f '%i %z %m')
    STAT_SIZE=(-f %z)
    STAT_MTIME=(-f %m)
    HASH=shasum
    ;;
  *)
    STAT_ID=(-c '%i %s %Y')
    STAT_SIZE=(-c %s)
    STAT_MTIME=(-c %Y)
    HASH=sha1sum
    ;;
esac

file_id() { stat "${STAT_ID[@]}" "$1"; }
file_size() { stat "${STAT_SIZE[@]}" "$1"; }
file_mtime() { stat "${STAT_MTIME[@]}" "$1"; }
is_porter() { [[ "$(hostname -s)" == "$(<"$ROOT/porter")" ]]; }

trash_existing() {
  local path
  for path; do
    [[ ! -e "$path" ]] || trash "$path" || return
  done
}

fingerprint() {
  find "$ROOT/apply-display-patches.sh" "$ROOT/patches" "$ROOT/patches-local" \
    -type f 2>/dev/null | sort | xargs cat /dev/null | "$HASH"
}

ARCHIVE="$HOME/.local/share/claude/patched"

# A binary is patched iff its sibling stamp names both its current bytes and the
# patch set that produced them.
is_patched() { [[ -f "$1.patched" && "$(<"$1.patched")" == "$(file_id "$1"; fingerprint)" ]]; }

# Newest patched build in the archive, empty when the archive holds none.
newest_archived() { ls "$ARCHIVE" 2>/dev/null | sort -V | tail -1; }

# The one selection policy: the best patched binary to run in place of the
# requested one — itself when its stamp is valid, else the newest archived
# patched build, else itself.
best_patched() {
  local archived
  archived="$(newest_archived)"
  if ! is_patched "$1" && [[ -n "$archived" ]]; then
    printf '%s\n' "$ARCHIVE/$archived"
  else
    printf '%s\n' "$1"
  fi
}
