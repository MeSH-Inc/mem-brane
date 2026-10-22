FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npx esbuild scripts/check-production.ts scripts/backup-bundle.ts scripts/verify-bundle.ts scripts/backup-remote.ts --bundle --format=esm --platform=node --target=node24 --packages=external --outdir=dist-ops && npm prune --omit=dev

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates gosu && rm -rf /var/lib/apt/lists/*
COPY --from=litestream/litestream:0.5.17-scratch /usr/local/bin/litestream /usr/local/bin/litestream
COPY deploy/litestream.yml /etc/litestream.yml
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 DATABASE_PATH=/data/mem-brane.sqlite ASSET_DIRECTORY=/data/assets
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist-ops ./dist-ops
COPY --from=build /app/migrations ./migrations
COPY deploy/entrypoint.sh /usr/local/bin/mem-brane
ENTRYPOINT ["/bin/sh", "/usr/local/bin/mem-brane"]
