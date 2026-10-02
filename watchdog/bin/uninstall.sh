#!/usr/bin/env bash
set -euo pipefail

# Stops the daily run. The home folder stays: it holds the logs, the run
# folders and config.json.

LABEL="com.lockridge.finance-watchdog"
WATCHDOG_HOME="${FINANCE_WATCHDOG_HOME:-$HOME/.finance-watchdog}"
PLIST_TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST_TARGET"
echo "launchd: $LABEL removed. Nothing runs at 6:30 any more."
echo "Kept: $WATCHDOG_HOME (delete it by hand if you want it gone)."
