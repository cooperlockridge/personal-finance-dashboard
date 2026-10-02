#!/usr/bin/env bash
set -euo pipefail

# Pauses the code lane. Requests that only change numbers still go through;
# a request that needs a code change waits until unpause.sh is run.
#
#   pause.sh "why"

WATCHDOG_HOME="${FINANCE_WATCHDOG_HOME:-$HOME/.finance-watchdog}"
REASON="${1:-}"

if [ -z "$REASON" ]; then
  echo 'Usage: pause.sh "<reason>"' >&2
  exit 1
fi

mkdir -p "$WATCHDOG_HOME/state"
printf '%s\n%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$REASON" > "$WATCHDOG_HOME/state/paused"
echo "Paused: $REASON"
