#!/usr/bin/env bash
# Engine cluster scale test, run from the Mac over SSH. Each step is "workers:routing", routing = hash (nginx hashes
# the dispatcher id, the design) or rr (round robin, only to measure what breaks without it). Fresh world, engines,
# load balancer and dispatchers every step; 2 min warm-up, 5 min measured. Live mode is stopped meanwhile.
#   scripts/cluster-steps.sh 1:hash 2:hash 3:hash 3:rr        (CLUSTER_DISPATCHERS=6000 by default)
set -uo pipefail
D=${CLUSTER_DISPATCHERS:-6000}
dc() { ssh dev "cd ~/load-radar && $*" >/dev/null 2>&1; }
q() { ssh dev "curl -s --get localhost:9090/api/v1/query --data-urlencode 'query=$1'" 2>/dev/null | python3 -c 'import json,sys; r=json.load(sys.stdin)["data"]["result"]; print(round(float(r[0]["value"][1]),4) if r else "n/a")'; }
dc docker compose stop live
for step in "$@"; do
  w=${step%%:*}; routing=${step##*:}
  dc docker compose --profile cluster stop dispatchers engine-lb engine cluster-world
  dc docker compose --profile cluster up -d --force-recreate cluster-world
  dc docker compose --profile cluster up -d --force-recreate --no-deps --scale engine=$w engine
  # One server line per running replica (by its real name; recreating renumbers them), max_fails=0.
  hashline=$([ "$routing" = hash ] && echo 'hash $dispatcher consistent;' || echo '# round robin')
  ssh dev "cd ~/load-radar && { echo '$hashline'; docker compose --profile cluster ps --format '{{.Name}}' engine | sed 's/.*/server &:8080 max_fails=0;/'; } > cluster/upstreams.conf" 2>/dev/null
  dc docker compose --profile cluster up -d --force-recreate --no-deps engine-lb
  sleep 5
  dc CLUSTER_DISPATCHERS=$D docker compose --profile cluster up -d --force-recreate --no-deps dispatchers
  start=$(date +%s); echo "STEP engines=$w routing=$routing dispatchers=$D started $(date -r $start +%H:%M:%S)"
  sleep 120
  # CPU over the measured 5 minutes: /proc/stat for the whole machine, docker stats every 15 s per container.
  ssh dev "head -1 /proc/stat > /tmp/cpu0; rm -f /tmp/cstats; for i in \$(seq 1 19); do docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' >> /tmp/cstats; sleep 14; done" >/dev/null 2>&1 &
  sleep 300
  wait
  echo "  window $(date -r $((start+120)) +%H:%M:%S) - $(date +%H:%M:%S)"
  echo "  board requests/s      $(q 'sum(rate(upstream_requests_total{job="cluster-engine"}[5m]))')"
  echo "  busiest / quietest    $(q 'max(sum by (instance) (rate(upstream_requests_total{job="cluster-engine"}[5m])))') / $(q 'min(sum by (instance) (rate(upstream_requests_total{job="cluster-engine"}[5m])))')"
  echo "  dispatchers per eng   $(q 'max(engine_dispatchers_owned)') max, $(q 'sum(engine_dispatchers_owned)') total"
  echo "  alerts within 60 s    $(q 'sum(rate(post_to_alert_seconds_bucket{job="cluster-engine",le=~"60(\\.0)?"}[5m])) / sum(rate(post_to_alert_seconds_count{job="cluster-engine"}[5m]))')"
  echo "  post->alert p50/p95 s $(q 'histogram_quantile(0.5, sum by (le) (rate(post_to_alert_seconds_bucket{job="cluster-engine"}[5m])))') / $(q 'histogram_quantile(0.95, sum by (le) (rate(post_to_alert_seconds_bucket{job="cluster-engine"}[5m])))')"
  echo "  loads alerted         $(q 'sum(increase(answer_key_settled_total{job="cluster-world",outcome="delivered"}[5m])) / sum(increase(answer_key_settled_total{job="cluster-world",outcome=~"delivered|missed_open"}[5m]))')"
  echo "  duplicate alerts      $(q 'sum(increase(answer_key_other_total{job="cluster-world",kind="duplicate"}[5m])) / sum(increase(answer_key_settled_total{job="cluster-world",outcome="delivered"}[5m]))')"
  echo "  429 share             $(q '(sum(rate(upstream_requests_total{job="cluster-engine",status="429"}[5m])) or vector(0)) / sum(rate(upstream_requests_total{job="cluster-engine"}[5m]))')"
  echo "  banned logins         $(q 'max(boards_banned_logins)')"
  echo "  CPU per engine (max)  $(q 'max(rate(process_cpu_seconds_total{job="cluster-engine"}[5m]))')"
  echo "  engine loop p99 (max) $(q 'max(max_over_time(nodejs_eventloop_lag_p99_seconds{job="cluster-engine"}[5m]))')"
  echo "  world loop p99        $(q 'max_over_time(world_eventloop_lag_p99_seconds[5m])')"
  ssh dev 'head -1 /proc/stat > /tmp/cpu1; python3 - <<PY
c0=[int(x) for x in open("/tmp/cpu0").read().split()[1:]]; c1=[int(x) for x in open("/tmp/cpu1").read().split()[1:]]
d=[b-a for a,b in zip(c0,c1)]; total=sum(d[:8]); idle=d[3]+d[4]; secs=total/100/8
import collections; acc=collections.defaultdict(list)
for line in open("/tmp/cstats"):
    n,p=line.split(); acc[n].append(float(p.rstrip("%"))/100)
avg={n:sum(v)/len(v) for n,v in acc.items()}
grp=lambda f: sum(v for n,v in avg.items() if f(n))
eng=grp(lambda n: n.startswith("load-radar-engine-") and not n.startswith("load-radar-engine-lb"))
print("  CPU cores: engines %.2f | world %.2f | nginx %.2f | dispatchers %.2f | cluster total %.2f | other containers %.2f" % (eng, grp(lambda n: "cluster-world" in n), grp(lambda n: "engine-lb" in n), grp(lambda n: "dispatchers" in n), grp(lambda n: any(k in n for k in ("load-radar-engine","cluster-world","dispatchers"))), grp(lambda n: not any(k in n for k in ("load-radar-engine","cluster-world","dispatchers")))))
print("  CPU cores: whole machine %.2f of 8 hardware threads (%.0f%% busy)" % ((total-idle)/100/secs, 100*(total-idle)/total))
PY' 2>/dev/null
  echo "  API requests/s        $(q 'sum(rate(dispatcher_api_requests_total[5m]))')"
  echo "  API 404 share         $(q '(sum(rate(dispatcher_api_requests_total{status="404"}[5m])) or vector(0)) / sum(rate(dispatcher_api_requests_total[5m]))')"
  echo "  API p99 s             $(q 'histogram_quantile(0.99, sum by (le) (rate(dispatcher_api_seconds_bucket[5m])))')"
done
dc docker compose --profile cluster stop dispatchers engine-lb engine cluster-world
ssh dev "cd ~/load-radar && git checkout cluster/upstreams.conf" 2>/dev/null
dc docker compose up -d live
echo "cluster stopped, live restarted $(date +%H:%M:%S)"
