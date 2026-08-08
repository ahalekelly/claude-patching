#!/usr/bin/env bash
# Shared platform seams and patch-set identity.
case "$(uname)" in
  Darwin)
    STAT_ID=(-f '%i %z %m')
    STAT_SIZE=(-f %z)
    STAT_MTIME=(-f %m)
    HASH=shasum
    notify() { osascript -e "display notification \"$2\" with title \"$1\"" 2>/dev/null || true; }
    ;;
  *)
    STAT_ID=(-c '%i %s %Y')
    STAT_SIZE=(-c %s)
    STAT_MTIME=(-c %Y)
    HASH=sha1sum
    notify() { notify-send "$1" "$2" 2>/dev/null || true; }
    ;;
esac

file_id() { stat "${STAT_ID[@]}" "$1"; }
file_size() { stat "${STAT_SIZE[@]}" "$1"; }
file_mtime() { stat "${STAT_MTIME[@]}" "$1"; }

fingerprint() {
  find "$ROOT/apply-display-patches.sh" "$ROOT/patches" "$ROOT/patches-local" \
    -type f 2>/dev/null | sort | xargs cat /dev/null | "$HASH"
}
