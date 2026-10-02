#!/usr/bin/env bash
set -euo pipefail

# Lets the code lane push again. Read state/paused first: if the watchdog
# wrote it, it says which commit was reverted and why.

WATCHDOG_HOME="${FINANCE_WATCHDOG_HOME:-$HOME/.finance-watchdog}"
PAUSED="$WATCHDOG_HOME/state/paused"

if [ -f "$PAUSED" ]; then
  echo "Was paused:"
  cat "$PAUSED"
  rm -f "$PAUSED"
  echo "Unpaused."
else
  echo "Not paused."
fi
