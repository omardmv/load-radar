# Deployment

One Linux server ("dev": Ubuntu 24.04, Ryzen 7 3700U 4C/8T, 14 GB RAM, no GPU) runs everything in Docker. The Mac only holds the code and opens the UIs through an SSH tunnel.

```
Mac                                   Server (Docker Compose, ~/load-radar)
 browser ──► localhost:3000..16686 ─SSH─► 127.0.0.1:<port> ─► grafana, langfuse-web, prometheus, jaeger, minio
 code    ──► rsync ──────────────────────► ~/load-radar ─► app (node:26, on demand): engine, simulators, eval
                                                          ├─► gliner2 :7100   (GLiNER2, CPU)
                                                          ├─► ollama  :11434  (Qwen 2.5 1.5B, CPU)
                                                          └─► otel-collector :4318 ─► jaeger / langfuse / prometheus
```

Every port is published on the server's 127.0.0.1 only, so nothing is open on the LAN or Tailscale; access goes through SSH.

## Ship a change

```bash
rsync -az --delete --exclude node_modules --exclude 'out*' --exclude .git --exclude ml/.venv \
  --exclude ml/dedup/data --exclude .env ./ dev:~/load-radar/
ssh dev 'cd ~/load-radar && docker compose up -d --build'
```

`.env` is copied once by hand (`scp .env dev:~/load-radar/ && ssh dev chmod 600 ~/load-radar/.env`), never by rsync.

## First setup on a new server

```bash
ssh dev 'cd ~/load-radar && docker compose up -d --build \
  && docker compose exec -T ollama ollama pull qwen2.5:1.5b-instruct-q8_0 \
  && docker compose run --rm -T app npm ci --omit=dev'
```

## Tunnel from the Mac

`ops/macos/com.loadradar.tunnel.plist` is a launchd agent: it starts at login, restarts ssh whenever it drops, and forwards 3000, 3001, 9090, 16686, 9095, 4318, 7100, and the server's Ollama on local 11435. Install and remove commands are in the file.

## Restarts

All long-running services have `restart: unless-stopped` / `always`, so they come back after a server reboot. The `app` container runs only for the duration of a command.
