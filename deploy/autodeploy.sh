#!/usr/bin/env bash
# Auto-deploy: run every minute by dueboard-autodeploy.timer (installed by setup.sh).
# When main on GitHub has a new commit: run the tests on it, back up the database, deploy it, check the app
# answers, and roll back to the previous commit (its whole setup, units included) if it does not.
# A commit whose tests fail is skipped until a newer one arrives; a deploy that fails for another reason
# (apt, network) is retried up to 3 times. A manual setup.sh run with BRANCH or COMMIT pins the server:
# auto-deploy waits until setup.sh runs again plainly. Logs: journalctl -u dueboard-autodeploy
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/dueboard}"
BRANCH="${BRANCH:-main}"
STATE_DIR="${STATE_DIR:-/var/lib/dueboard-autodeploy}"
ENV_FILE=/etc/dueboard.env
setting() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -n 1; }
PORT="$(setting PORT)"
HEALTH_URL="http://127.0.0.1:${PORT:-3000}/api/me"
DB_PATH="$(setting DB_PATH)"
MAX_TRIES=3

exec 9>/run/dueboard-autodeploy.lock
flock -n 9 || exit 0 # a deploy is already running
export DUEBOARD_DEPLOY_LOCKED=1 # setup.sh, called below, must not wait for the lock this script holds

install -d -m 700 "$STATE_DIR"
[ -f "$STATE_DIR/pinned" ] && exit 0 # someone deployed by hand on purpose
git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
current="$(git -C "$APP_DIR" rev-parse HEAD)"
target="$(git -C "$APP_DIR" rev-parse "origin/$BRANCH")"
[ "$current" = "$target" ] && exit 0
[ "$(cat "$STATE_DIR/failed" 2>/dev/null)" = "$target" ] && exit 0

short="${target:0:7}"
echo "New commit $short: $(git -C "$APP_DIR" log -1 --format='%an: %s' "$target")"

work="$(mktemp -d)"
old="$(mktemp -d)"
trap 'rm -rf "$work" "$old"' EXIT

# Test the new commit in a scratch copy, as an unprivileged user.
git -C "$APP_DIR" archive "$target" | tar -x -C "$work"
chown -R nobody:nogroup "$work"
if ! (cd "$work" && timeout 300 runuser -u nobody -- node --test >"$work.log" 2>&1); then
  tail -n 30 "$work.log"; rm -f "$work.log"
  echo "Tests failed on $short; not deploying it. Still running ${current:0:7}."
  echo "$target" > "$STATE_DIR/failed"
  exit 1
fi
rm -f "$work.log"
echo "Tests passed on $short"

# A copy of the database before the new code touches it (it may add columns); the last 5 are kept.
if [ -n "$DB_PATH" ] && [ -f "$DB_PATH" ] && command -v sqlite3 >/dev/null; then
  backup="$STATE_DIR/before-$short.db"
  sqlite3 "$DB_PATH" ".backup '$backup'" && chmod 600 "$backup" && echo "Database backed up to $backup"
  ls -1t "$STATE_DIR"/before-*.db 2>/dev/null | tail -n +6 | xargs -r rm -f
fi

healthy() {
  for _ in $(seq 1 20); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$HEALTH_URL")" = 401 ] && return 0
    sleep 1
  done
  return 1
}

# setup.sh from the new commit, run from the scratch copy so it is never edited while it runs.
if BRANCH="$BRANCH" COMMIT="$target" bash "$work/deploy/setup.sh" && healthy; then
  rm -f "$STATE_DIR/tries"
  echo "Deployed $short"
  exit 0
fi

# Tests passed, so the failure may be passing (apt lock, network): give the commit a few tries.
tries="$(sed -n "s/^$target //p" "$STATE_DIR/tries" 2>/dev/null || true)"
tries=$(( ${tries:-0} + 1 ))
echo "$target $tries" > "$STATE_DIR/tries"
if [ "$tries" -ge "$MAX_TRIES" ]; then
  echo "$target" > "$STATE_DIR/failed"
  echo "Deploy of $short failed $tries times; skipping it until a newer commit"
else
  echo "Deploy of $short failed (try $tries of $MAX_TRIES); rolling back and trying again next minute"
fi

# Roll back with the previous commit's own setup.sh, so its unit files, this script and Caddy come back too.
echo "Rolling back to ${current:0:7}"
git -C "$APP_DIR" archive "$current" | tar -x -C "$old"
if BRANCH="$BRANCH" COMMIT="$current" bash "$old/deploy/setup.sh" && healthy; then
  echo "Rolled back to ${current:0:7}"
else
  git -C "$APP_DIR" checkout --quiet -B "$BRANCH" "$current"
  systemctl daemon-reload
  systemctl restart dueboard
  healthy && echo "Rolled back to ${current:0:7} (app only)" || echo "Rollback to ${current:0:7} is not answering either"
fi
exit 1
