#!/usr/bin/env bash
set -euo pipefail

# Sets the watchdog up on this Mac. Safe to run again: it only adds what is
# missing, and it never overwrites config.json.

LABEL="com.lockridge.finance-watchdog"
REPO_URL="https://github.com/cooperlockridge/personal-finance-dashboard.git"
WATCHDOG_HOME="${FINANCE_WATCHDOG_HOME:-$HOME/.finance-watchdog}"
MAIN_REPO="${FINANCE_WATCHDOG_MAIN_REPO:-/Users/cooperlockridge/Projects/personal-finance-dashboard}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_SOURCE="$HERE/../$LABEL.plist"
PLIST_TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ ! -d "$MAIN_REPO/node_modules" ]; then
  echo "No node_modules in $MAIN_REPO. Set FINANCE_WATCHDOG_MAIN_REPO to the main checkout." >&2
  exit 1
fi

mkdir -p "$WATCHDOG_HOME/state" "$WATCHDOG_HOME/logs" "$WATCHDOG_HOME/runs"
echo "Home: $WATCHDOG_HOME"

# A plain clone, not a worktree: it shares no index, no stash and no branches
# with the checkouts Cooper works in.
if [ -d "$WATCHDOG_HOME/repo/.git" ]; then
  echo "Clone: already there"
else
  git clone -q "$REPO_URL" "$WATCHDOG_HOME/repo"
  echo "Clone: made from $REPO_URL"
fi

ln -sfn "$MAIN_REPO/node_modules" "$WATCHDOG_HOME/repo/node_modules"
echo "node_modules: linked to $MAIN_REPO/node_modules"

install -m 755 "$HERE/bootstrap.sh" "$WATCHDOG_HOME/bootstrap.sh"
echo "bootstrap.sh: copied"

if [ -f "$WATCHDOG_HOME/config.json" ]; then
  echo "config.json: kept as it is"
else
  # The Resend key lives here, so only this user may read the file.
  (umask 077 && cat > "$WATCHDOG_HOME/config.json" <<'JSON'
{
  "emailTo": "",
  "resendApiKey": "",
  "model": "opus",
  "maxRequestsPerRun": 5
}
JSON
  )
  echo "config.json: written from the template. Fill in emailTo and resendApiKey, or runs are logged and not emailed."
fi

# launchd does not expand ~ or $HOME in a log path, so the real path goes in.
mkdir -p "$HOME/Library/LaunchAgents"
sed "s|__HOME__|$HOME|g" "$PLIST_SOURCE" > "$PLIST_TARGET"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_TARGET"
echo "launchd: $LABEL loaded. It runs every day at 6:30."

echo "Done. Run $HERE/doctor.sh to check the rest."
