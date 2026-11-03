#!/usr/bin/env bash
# Continuous deploy, pull-based: cron runs this every minute on the server. If GitHub's main has a new
# commit, fast-forward and rebuild what changed. The server only talks out to GitHub: no secrets, no open ports.
#   install: (crontab -l 2>/dev/null; echo '* * * * * ~/load-radar/ops/server/deploy.sh >> ~/load-radar-deploy.log 2>&1') | crontab -
set -euo pipefail
cd "$(dirname "$0")/../.."
exec 9>/tmp/load-radar-deploy.lock
flock -n 9 || exit 0                                   # a deploy is still running
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0
from=$(git rev-parse --short HEAD)
git merge -q --ff-only origin/main
echo "$(date -Is) deploy $from -> $(git rev-parse --short HEAD): $(git log -1 --format=%s)"
if git diff --name-only "$from" HEAD | grep -qE '^(package(-lock)?\.json)$'; then
  docker compose run --rm -T app npm ci --omit=dev --no-audit --no-fund
fi
docker compose up -d --build --remove-orphans 2>&1 | grep -vE 'Running|Waiting|Healthy' || true
# Config files are bind-mounted, so compose does not notice edits: restart the services that read them.
changed=$(git diff --name-only "$from" HEAD)
grep -q '^ops/prometheus.yml$' <<<"$changed" && docker compose restart prometheus
grep -q '^ops/otel-collector.yaml$' <<<"$changed" && docker compose restart otel-collector
grep -q '^ops/grafana/' <<<"$changed" && docker compose restart grafana
echo "$(date -Is) deploy done"
