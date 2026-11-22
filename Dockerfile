# syntax=docker/dockerfile:1
# W0 Node image template (sheets-runtime and sheets-realtime).
# Debian/Ubuntu (bookworm/trixie): package libatomic1, which provides libatomic.
# RHEL/AL2023: package libatomic.
# Alpine: apk add --no-cache libatomic libstdc++.
# This base is bookworm-slim, so the install below is libatomic1.
# No application sources are copied yet. Later waves replace CMD with the service entrypoint.

ARG NODE_VERSION=26.13.1
FROM node:${NODE_VERSION}-bookworm-slim

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends libatomic1 \
    && rm -rf /var/lib/apt/lists/*

# Mandatory smoke: Node must start once libatomic is installed.
RUN node -e "process.exit(0)"

ARG SERVICE_PORT=3100
ENV NODE_ENV=production \
    PORT=${SERVICE_PORT}
EXPOSE ${SERVICE_PORT}
WORKDIR /app
USER node
CMD ["node", "-e", "process.exit(0)"]
