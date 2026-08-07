#!/usr/bin/env bash
# Stand-in for the tier-2 port agent when testing the background-port plumbing:
# performs a known-good, zero-drift port of <ver> by writing the previous
# version's index as the patches-local overlay for <ver>. No model call.
#
#   stub-port-agent.sh <ver> <from-ver>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VER="$1"
FROM="${2:?usage: stub-port-agent.sh <ver> <from-ver>}"

mkdir -p "$ROOT/patches-local/$VER"
jq --arg v "$VER" '.version = $v' "$ROOT/repo/patches/$FROM/index.json" \
  > "$ROOT/patches-local/$VER/index.json"
echo "ported $VER from $FROM: $ROOT/patches-local/$VER/index.json"
