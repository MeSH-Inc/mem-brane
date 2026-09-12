FROM node:24.13.1-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npx esbuild scripts/check-production.ts scripts/backup-bundle.ts scripts/verify-bundle.ts scripts/backup-remote.ts --bundle --format=esm --platform=node --target=node24 --packages=external --outdir=dist-ops && npm prune --omit=dev

FROM node:24.13.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates gosu && rm -rf /var/lib/apt/lists/*
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
