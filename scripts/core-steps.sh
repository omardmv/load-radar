#!/usr/bin/env bash
# Engine scale-out test: the same live world with 1 vs 2 engine workers (one core each), run from the Mac over SSH.
# Each step: restart live with the given workers and dispatchers, 2 min warm-up, 5 min measured, then read Prometheus.
#   scripts/core-steps.sh "1:8000" "2:8000" "2:12000"
set -uo pipefail
LOADS=${LOADS:-100000}
q() { ssh dev "curl -s --get localhost:9090/api/v1/query --data-urlencode 'query=$1'" 2>/dev/null | python3 -c 'import json,sys; r=json.load(sys.stdin)["data"]["result"]; print(round(float(r[0]["value"][1]),3) if r else "n/a")'; }
for step in "$@"; do
  w=${step%%:*}; u=${step##*:}
  ssh dev "cd ~/load-radar && LIVE_USERS=$u LIVE_LOADS_PER_DAY=$LOADS LIVE_ENGINE_WORKERS=$w docker compose up -d live" >/dev/null 2>&1
  start=$(date +%s); echo "STEP workers=$w dispatchers=$u started $(date -r $start +%H:%M:%S)"
  sleep 420
  echo "  window $(date -r $((start+120)) +%H:%M:%S) - $(date +%H:%M:%S)"
  echo "  board req/s           $(q 'sum(rate(upstream_requests_total{job="load-radar-engine"}[5m]))')"
  echo "  alerts <= 60 s        $(q 'slo:alert_fast:ratio_rate5m')"
  echo "  post->alert p50 s     $(q 'histogram_quantile(0.5, sum by (le) (rate(post_to_alert_seconds_bucket{job="load-radar-engine"}[5m])))')"
  echo "  post->alert p95 s     $(q 'histogram_quantile(0.95, sum by (le) (rate(post_to_alert_seconds_bucket{job="load-radar-engine"}[5m])))')"
  echo "  loads alerted         $(q 'slo:alert_complete:ratio_rate5m')"
  echo "  process CPU cores     $(q 'max(rate(process_cpu_seconds_total{job="load-radar-engine"}[5m]))')"
  echo "  engine loop p99 s     $(q 'max(max_over_time(nodejs_eventloop_lag_p99_seconds{job="load-radar-engine"}[5m]))')"
  echo "  world loop p99 s      $(q 'max_over_time(world_eventloop_lag_p99_seconds[5m])')"
  echo "  polls waiting         $(q 'sum(avg_over_time(engine_gauge{job="load-radar-engine",name="polls_waiting_for_login"}[5m]))')"
  echo "  429 share             $(q '1 - slo:board_not_limited:ratio_rate5m')"
  echo "  banned logins         $(q 'slo:logins_banned')"
  echo "  machine CPU busy      $(ssh dev "top -bn1 | grep '%Cpu'" 2>/dev/null)"
done
ssh dev "cd ~/load-radar && docker compose up -d live" >/dev/null 2>&1
echo "restored live to defaults $(date +%H:%M:%S)"
