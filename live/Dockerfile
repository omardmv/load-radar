# Live mode: the UI (built with Vite) + the always-on world, engine and live scorer (Node 26, no build step).
FROM node:26-slim AS ui
WORKDIR /ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui/ ./
RUN npm run build

FROM node:26-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src src
COPY sim sim
COPY sims sims
COPY live live
COPY cluster cluster
COPY ml/dedup/model.json ml/dedup/model.json
COPY --from=ui /ui/dist ui/dist
EXPOSE 8080 9464
ENTRYPOINT ["node", "live/server.ts"]
