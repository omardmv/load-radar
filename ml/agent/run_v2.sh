#!/usr/bin/env bash
# Prompt v2 for the comment reader on both sets and all sizes, then the 7B whole-decision runs (cut off by a reboot).
set -u
cd "$(dirname "$0")/../.."
ev() { docker compose run --rm -T app node ml/agent/eval.ts --ollama http://ollama:11434 --otlp http://otel-collector:4318/v1/traces --langfuse http://langfuse-web:3000 "$@" 2>&1 | grep -E '^\|'; }
ev --models qwen2.5:1.5b-instruct-q8_0,qwen2.5:3b-instruct,qwen2.5:7b-instruct --modes hybrid
ev --models qwen2.5:1.5b-instruct-q8_0,qwen2.5:3b-instruct,qwen2.5:7b-instruct --modes hybrid --cases ml/agent/cases_messy.jsonl
ev --models qwen2.5:7b-instruct --modes context,tools
docker compose run --rm -T app node ml/agent/report.ts > /dev/null
echo "all done $(date -Is)"
