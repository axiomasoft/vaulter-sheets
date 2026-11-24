ARG NODE_VERSION=26.13.1
FROM node:${NODE_VERSION}-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/*
RUN node -e "process.exit(0)"
WORKDIR /build
COPY package.json package-lock.json ./
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/vue/package.json packages/vue/package.json
COPY packages/realtime/package.json packages/realtime/package.json
COPY packages/tiptap/package.json packages/tiptap/package.json
COPY patches/ patches/
COPY scripts/patch-univer.mjs scripts/patch-univer.mjs
RUN npm ci --ignore-scripts --workspace @vaulter/sheets-runtime --workspace @vaulter/sheets-realtime --include-workspace-root=false
COPY contracts/ contracts/
COPY packages/runtime/ packages/runtime/
COPY packages/realtime/ packages/realtime/
RUN node scripts/patch-univer.mjs \
    && npm run build --workspace @vaulter/sheets-runtime && npm run build --workspace @vaulter/sheets-realtime \
    && npm prune --omit=dev --ignore-scripts --workspace @vaulter/sheets-runtime --workspace @vaulter/sheets-realtime --include-workspace-root=false \
    && node scripts/patch-univer.mjs \
    && node -e 'const fs=require("node:fs"); const patch=fs.readFileSync("patches/@univerjs__engine-formula@1.5.2.patch","utf8"); for (const section of patch.split(/^--- a\//m).slice(1)) { const [rel,...lines]=section.trimEnd().split("\n"); const added=lines.find(line=>/^\+\s/.test(line))?.slice(1); const removed=lines.find(line=>/^-\s/.test(line))?.slice(1); const text=fs.readFileSync("node_modules/@univerjs/engine-formula/"+rel,"utf8"); if (!added || !removed || !text.includes(added) || text.includes(removed)) { console.error("patch #7936 missing after prune: "+rel); process.exit(1);} }'

FROM node:${NODE_VERSION}-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/*
RUN node -e "process.exit(0)"
WORKDIR /app
ENV NODE_ENV=production PORT=3101
COPY --from=build /build/node_modules/ws/ ./node_modules/ws/
COPY --from=build /build/packages/realtime/dist/ ./dist/
COPY --from=build /build/packages/realtime/package.json ./package.json
USER node
EXPOSE 3101
CMD ["node", "dist/server.js"]
