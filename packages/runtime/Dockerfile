ARG NODE_VERSION=26.13.1
FROM node:${NODE_VERSION}-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/*
RUN node -e "process.exit(0)"
WORKDIR /build
COPY package.json package-lock.json ./
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/vue/package.json packages/vue/package.json
COPY patches/ patches/
COPY scripts/patch-univer.mjs scripts/patch-univer.mjs
RUN npm ci --ignore-scripts --workspace @vaulter/sheets-runtime --include-workspace-root=false && node scripts/patch-univer.mjs
COPY contracts/ contracts/
COPY packages/runtime/ packages/runtime/
RUN npm run build --workspace @vaulter/sheets-runtime \
    && npm prune --omit=dev --ignore-scripts --workspace @vaulter/sheets-runtime --include-workspace-root=false

FROM node:${NODE_VERSION}-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/*
RUN node -e "process.exit(0)"
WORKDIR /app
ENV NODE_ENV=production PORT=3100
COPY --from=build /build/node_modules/ ./node_modules/
COPY --from=build /build/packages/runtime/dist/ ./dist/
COPY --from=build /build/packages/runtime/contracts/ ./contracts/
COPY --from=build /build/packages/runtime/package.json ./package.json
USER node
EXPOSE 3100
CMD ["node", "dist/server.js"]
