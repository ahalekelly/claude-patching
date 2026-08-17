#!/bin/sh
# Rendezvous between the two probe agents, over the logsrv log they share. It is
# what pins the two facts the test is about: that the probes are alive at the
# same time, and that the waiter's last call happens after its sibling's
# teardown — the moment stock Claude Code kills the connection they share.
#
#   wait-for-sibling.sh <logsrv-log> waiter-here|quick-gone
#
# Labels rather than patterns, so the agent has a command with nothing in it to
# quote or reinterpret. Gives up after 90s and says so rather than hanging: the
# call after it is the assertion, and it is worth making either way.
log="$1"
# quick-gone matches only exits of servers that completed the initialize
# handshake: Claude Code's preflight spawns log exits too, and waiting on those
# would let the waiter ping again before its sibling's server is really down.
case "$2" in
  waiter-here) pattern='"note":"waiter-1"';;
  quick-gone)  pattern='"ev":"exit".*"initialized":true';;
  *) echo "usage: wait-for-sibling.sh <log> waiter-here|quick-gone"; exit 1;;
esac

i=0
while [ "$i" -lt 90 ]; do
  if grep -q "$pattern" "$log" 2>/dev/null; then
    echo "sibling reached $2"
    exit 0
  fi
  sleep 1
  i=$((i + 1))
done
echo "gave up waiting for $2 after 90s"
