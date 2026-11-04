#!/usr/bin/env bash
# The full agent comparison on the server, one step after another (each step needs the whole CPU).
#   nohup ml/agent/run_all.sh > ml/agent/run_all.log 2>&1 &
set -u
cd "$(dirname "$0")/../.."
while docker ps --format '{{.Names}}' | grep -q load-radar-app-run; do sleep 30; done   # an eval already running
ev() { docker compose run --rm -T app node ml/agent/eval.ts --ollama http://ollama:11434 --otlp http://otel-collector:4318/v1/traces --langfuse http://langfuse-web:3000 "$@" 2>&1 | grep -E '^\|'; }
ev --models qwen2.5:1.5b-instruct-q8_0,qwen2.5:3b-instruct,qwen2.5:7b-instruct --modes rules,hybrid
ev --models qwen2.5:1.5b-instruct-q8_0,qwen2.5:3b-instruct,qwen2.5:7b-instruct --modes rules,hybrid --cases ml/agent/cases_messy.jsonl
ev --models qwen2.5:7b-instruct --modes context,tools
docker compose run --rm -T app node ml/agent/report.ts > /dev/null
echo "all done $(date -Is)"
