# Deployment

One Linux server ("dev": Ubuntu 24.04, Ryzen 7 3700U 4C/8T, 14 GB RAM, no GPU) runs everything in Docker. The Mac only holds the code and opens the UIs through an SSH tunnel.

```
Mac                                        Server (Docker Compose, ~/load-radar)
 browser ──► localhost:{8080,3000,3001,     SSH tunnel      127.0.0.1:<same port> ─► live (UI), grafana, langfuse-web,
              9090,9095,4318,7100,11435} ──────────────►                            prometheus, minio, gliner2, ollama
 code    ──► git push ─► GitHub ─► git pull ► ~/load-radar ─► app (node:26, on demand): engine, simulators, eval
                                                          ├─► gliner2 :7100   (GLiNER2, CPU)
                                                          ├─► ollama  :11434  (Qwen 2.5 1.5B / 3B / 7B, CPU: parser eval, load-decision agent)
                                                          └─► otel-collector :4318 ─► tempo (traces) / loki (logs) / langfuse / prometheus
```

Every port is published on the server's 127.0.0.1 only, so nothing is open on the LAN or Tailscale; access goes through SSH. There is no Jaeger: traces go to Tempo and logs go to Loki, both read from Grafana.

## Ship a change (continuous deploy)

The server's `~/load-radar` is a clone of https://github.com/omardmv/load-radar (public, so no key is needed to pull).
Every minute, cron runs [ops/server/deploy.sh](ops/server/deploy.sh): if `main` on GitHub has a new commit, it
fast-forwards, runs `npm ci` in the `app` container if `package.json`/`package-lock.json` changed, rebuilds what
changed (`docker compose up -d --build`), and restarts `prometheus`, `otel-collector` or `grafana` if their
bind-mounted config under `ops/` changed (compose doesn't notice edits to a bind-mounted file by itself). The
server only talks out to GitHub: no secrets, no runner, no open ports. So shipping is just:

```bash
git push
ssh dev tail -5 ~/load-radar-deploy.log                     # what was deployed, and when
```

`.env` is gitignored and copied once by hand (`scp .env dev:~/load-radar/ && ssh dev chmod 600 ~/load-radar/.env`). Generated data (`out*/`) and live state (volume `live_state`) stay on the server.

## First setup on a new server

```bash
ssh dev 'git clone https://github.com/omardmv/load-radar.git ~/load-radar'
scp .env dev:~/load-radar/ && ssh dev chmod 600 ~/load-radar/.env
ssh dev 'docker volume create gliner2-cache'                 # external volume for the GLiNER2 model download
ssh dev 'cd ~/load-radar && docker compose up -d --build \
  && docker compose exec -T ollama ollama pull qwen2.5:1.5b-instruct-q8_0 \
  && docker compose run --rm -T app npm ci --omit=dev'
ssh dev '(crontab -l; echo "* * * * * ~/load-radar/ops/server/deploy.sh >> ~/load-radar-deploy.log 2>&1") | crontab -'
```

If the repo goes private, add a read-only deploy key: `ssh-keygen -t ed25519 -f ~/.ssh/load_radar_deploy` on the server, then `gh repo deploy-key add` with the `.pub` file, and clone over SSH.

## Tunnel from the Mac

`ops/macos/com.loadradar.tunnel.plist` is a launchd agent: it starts at login, restarts ssh whenever it drops, and forwards live UI 8080, Grafana 3000, Langfuse 3001, Prometheus 9090, MinIO 9095, OTLP 4318, GLiNER2 7100, and the server's Ollama on local 11435 (11434 stays free for a local Ollama on the Mac). Install and remove commands are in the file.

## Restarts

All long-running services have `restart: unless-stopped` / `always`, so they come back after a server reboot. The `app` container runs only for the duration of a command.
