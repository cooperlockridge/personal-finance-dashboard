#!/usr/bin/env bash
set -euo pipefail

# What launchd starts at 6:30. The installed copy lives at
# ~/.finance-watchdog/bootstrap.sh, outside the clone, so nothing an agent
# writes in the clone can change it.
#
# It puts the clone on whatever main is right now and only then starts the
# watchdog. That is why the watchdog always runs the code that is on main:
# its own rules included.

export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin"

WATCHDOG_HOME="${FINANCE_WATCHDOG_HOME:-$HOME/.finance-watchdog}"
cd "$WATCHDOG_HOME/repo"

# Hooks and fsmonitor stay off for every git command here, as they do inside
# the watchdog: a file in .git must never become a program.
GIT=(git -c core.hooksPath=/dev/null -c core.fsmonitor=false)

"${GIT[@]}" fetch -q origin
# -f: a run that died mid-request leaves edits behind, and without it this
# checkout would refuse and the watchdog would never start again.
"${GIT[@]}" checkout -q -f -B watchdog origin/main
"${GIT[@]}" clean -fdq

exec bun watchdog/run.ts
