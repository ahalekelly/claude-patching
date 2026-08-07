#!/bin/zsh
for v in $(env | grep -E '^CLAUDE' | cut -d= -f1); do
  [ "$v" = "CLAUDE_CONFIG_DIR" ] && continue
  unset $v
done
unset CLAUDECODE
cd /Users/akelly/.claude/jobs/87f26767/tmp/expA/proj || exit 1
exec /Users/akelly/.local/bin/claude -p \
  --dangerously-skip-permissions \
  --model sonnet \
  --output-format json \
  "In ONE single message, make TWO Task/Agent tool calls at the same time so they run concurrently: one with subagent_type 'expa' and one with subagent_type 'expb'. Give each the prompt 'Do your task now.' and set run_in_background to false if that parameter exists so you wait for both to finish. Do not use any other tool yourself. When both subagents have returned, reply with their two final messages and nothing else."
