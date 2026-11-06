#!/usr/bin/env bash
# Push-feed scale test, run from the Mac over SSH: N ingest workers (one core each) behind nginx, fed as fast as
# they accept. Each step is "workers:lb", lb = hash (port 8091, same load -> same worker) or rr (8090, round robin).
# Fresh workers, sink and generator every step; 1 min warm-up, 4 min measured. Live mode is stopped meanwhile.
#   scripts/feed-steps.sh 1:hash 2:hash 3:hash 3:rr
set -uo pipefail
dc() { ssh dev "cd ~/load-radar && $*" >/dev/null 2>&1; }
q() { ssh dev "curl -s --get localhost:9090/api/v1/query --data-urlencode 'query=$1'" 2>/dev/null | python3 -c 'import json,sys; r=json.load(sys.stdin)["data"]["result"]; print(round(float(r[0]["value"][1]),4) if r else "n/a")'; }
dc docker compose stop live
for step in "$@"; do
  w=${step%%:*}; lb=${step##*:}; port=$([ "$lb" = rr ] && echo 8090 || echo 8091)
  dc docker compose --profile feed stop feed-gen
  dc docker compose --profile feed up -d --force-recreate --scale feed-ingest=$w feed-ingest feed-sink
  # One server line per running replica, by its real container name (recreating renumbers them).
  ssh dev "cd ~/load-radar && docker compose --profile feed ps --format '{{.Name}}' feed-ingest | sed 's/.*/server &:7200;/' > feed/upstreams.conf" 2>/dev/null
  dc docker compose --profile feed up -d --force-recreate --no-deps feed-lb   # --no-deps: else compose resets feed-ingest to 1 replica
  sleep 5
  echo "  ingest replicas: $(ssh dev "cd ~/load-radar && docker compose --profile feed ps -q feed-ingest | wc -l" 2>/dev/null)"
  dc FEED_TARGET=http://feed-lb:$port docker compose --profile feed up -d --force-recreate --no-deps feed-gen
  start=$(date +%s); echo "STEP workers=$w lb=$lb started $(date -r $start +%H:%M:%S)"
  sleep 300
  echo "  window $(date -r $((start+60)) +%H:%M:%S) - $(date +%H:%M:%S)"
  echo "  postings/s handled    $(q 'sum(rate(feed_ingest_requests_total[4m]))')"
  echo "  workers reporting     $(q 'count(rate(feed_ingest_requests_total{result="ok"}[4m]))')"
  echo "  busiest worker /s     $(q 'max(sum by (instance) (rate(feed_ingest_requests_total[4m])))')"
  echo "  quietest worker /s    $(q 'min(sum by (instance) (rate(feed_ingest_requests_total[4m])))')"
  echo "  CPU per worker (max)  $(q 'max(rate(process_cpu_seconds_total{job="feed-ingest"}[4m]))')"
  echo "  generator CPU         $(q 'max(rate(process_cpu_seconds_total{job="feed-gen"}[4m]))')"
  echo "  push p50 / p99 s      $(q 'histogram_quantile(0.5, sum by (le) (rate(feed_gen_request_seconds_bucket[4m])))') / $(q 'histogram_quantile(0.99, sum by (le) (rate(feed_gen_request_seconds_bucket[4m])))')"
  echo "  push errors /s        $(q 'sum(rate(feed_gen_requests_total{status!="202"}[4m])) or vector(0)')"
  echo "  alerts/s              $(q 'sum(rate(feed_alerts_emitted_total[4m]))')"
  echo "  alert p50 / p99 s     $(q 'histogram_quantile(0.5, sum by (le) (rate(feed_alert_seconds_bucket[4m])))') / $(q 'histogram_quantile(0.99, sum by (le) (rate(feed_alert_seconds_bucket[4m])))')"
  echo "  duplicate alerts      $(q 'sum(increase(feed_sink_sampled_total{kind="duplicate"}[4m])) / sum(increase(feed_sink_sampled_total[4m]))')"
done
dc docker compose --profile feed stop feed-gen feed-lb feed-ingest feed-sink
ssh dev "cd ~/load-radar && git checkout feed/upstreams.conf" 2>/dev/null
dc docker compose up -d live
echo "feed stopped, live restarted $(date +%H:%M:%S)"
