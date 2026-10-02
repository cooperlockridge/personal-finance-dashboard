#!/usr/bin/env bash
set -euo pipefail

# Checks everything a run needs. Changes nothing. Exits 1 if any check fails.

export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin"

WATCHDOG_HOME="${FINANCE_WATCHDOG_HOME:-$HOME/.finance-watchdog}"
MAIN_REPO="${FINANCE_WATCHDOG_MAIN_REPO:-/Users/cooperlockridge/Projects/personal-finance-dashboard}"
REPO="$WATCHDOG_HOME/repo"
FAILED=0

check() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "ok    $name"
  else
    echo "FAIL  $name"
    FAILED=1
  fi
}

clone_is_clean() {
  [ -z "$(git -C "$REPO" -c core.hooksPath=/dev/null -c core.fsmonitor=false status --porcelain)" ]
}

config_has_email() {
  grep -Eq '"emailTo"[[:space:]]*:[[:space:]]*"[^"]+"' "$WATCHDOG_HOME/config.json" &&
    grep -Eq '"resendApiKey"[[:space:]]*:[[:space:]]*"[^"]+"' "$WATCHDOG_HOME/config.json"
}

for tool in bun claude supabase gh git; do
  check "$tool is on the PATH" command -v "$tool"
done

check "gh is logged in" gh auth status
check "Supabase answers (select 1)" supabase db query --linked --workdir "$MAIN_REPO" "select 1"
check "the clone is there" test -d "$REPO/.git"
check "the clone is clean" clone_is_clean
check "the clone can push to main (dry run)" git -C "$REPO" -c core.hooksPath=/dev/null push --dry-run origin HEAD:main
check "node_modules is linked" test -x "$REPO/node_modules/.bin/tsc"
check "bootstrap.sh is installed" test -x "$WATCHDOG_HOME/bootstrap.sh"
check "config.json has emailTo and resendApiKey" config_has_email

if [ -f "$WATCHDOG_HOME/state/paused" ]; then
  echo "note  the code lane is PAUSED:"
  sed 's/^/        /' "$WATCHDOG_HOME/state/paused"
fi

if [ "$FAILED" -ne 0 ]; then
  echo "Something needs fixing."
  exit 1
fi
echo "All good."
