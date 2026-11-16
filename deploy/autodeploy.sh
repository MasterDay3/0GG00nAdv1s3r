#!/usr/bin/env bash
# Auto-deploy: run every minute by dueboard-autodeploy.timer (installed by setup.sh).
# When main on GitHub has a new commit: run the tests on it, deploy it, check the app answers,
# and roll back to the previous commit if it does not. A commit whose tests fail is skipped
# until a newer one arrives. Logs: journalctl -u dueboard-autodeploy
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/dueboard}"
BRANCH="${BRANCH:-main}"
STATE_DIR="${STATE_DIR:-/var/lib/dueboard-autodeploy}"
HEALTH_URL=http://127.0.0.1:3000/api/me

exec 9>/run/dueboard-autodeploy.lock
flock -n 9 || exit 0 # a deploy is already running

install -d -m 700 "$STATE_DIR"
git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
current="$(git -C "$APP_DIR" rev-parse HEAD)"
target="$(git -C "$APP_DIR" rev-parse "origin/$BRANCH")"
[ "$current" = "$target" ] && exit 0
[ "$(cat "$STATE_DIR/failed" 2>/dev/null)" = "$target" ] && exit 0

short="${target:0:7}"
echo "New commit $short: $(git -C "$APP_DIR" log -1 --format='%an: %s' "$target")"

# Test the new commit in a scratch copy, as an unprivileged user.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
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

healthy() {
  for _ in $(seq 1 20); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$HEALTH_URL")" = 401 ] && return 0
    sleep 1
  done
  return 1
}

# setup.sh from the new commit, run from the scratch copy so it is never edited while it runs.
if BRANCH="$BRANCH" COMMIT="$target" bash "$work/deploy/setup.sh" && healthy; then
  echo "Deployed $short"
  exit 0
fi

echo "Deploy of $short failed; rolling back to ${current:0:7}"
echo "$target" > "$STATE_DIR/failed"
git -C "$APP_DIR" checkout --quiet -B "$BRANCH" "$current"
systemctl restart dueboard
healthy && echo "Rolled back to ${current:0:7}" || echo "Rollback to ${current:0:7} is not answering either"
exit 1
