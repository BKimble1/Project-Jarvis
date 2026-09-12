# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# The Jarvis Worker.
#
# A long-lived Node process, not a web server: it opens no port and takes no
# inbound traffic. It polls the control plane, claims one mission at a time,
# and works inside /workspaces.
#
# Deliberately runs as a non-root user with no shell login. The agent's tool
# calls execute as this user, so "the container is the sandbox" is only true
# if the user inside it is unprivileged.
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim

# git is the only system dependency the worker itself needs; ca-certificates so
# HTTPS clones work; tini so signals reach Node and SIGTERM drains cleanly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a source change does not reinstall the world.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm install --no-save tsx@4 \
 && npm cache clean --force

COPY tsconfig.json ./
COPY src/domain ./src/domain
COPY src/worker ./src/worker
COPY scripts/worker.ts scripts/worker-health.ts ./scripts/

# The workspace root lives on a volume so preserved work survives a container
# restart — which is the whole reason Jarvis never deletes a workspace itself.
RUN mkdir -p /workspaces && chown -R node:node /workspaces /app
VOLUME ["/workspaces"]

ENV NODE_ENV=production \
    JARVIS_WORKER_WORKSPACE_ROOT=/workspaces \
    NODE_OPTIONS=--enable-source-maps

USER node

# Reports configuration, runtime availability and workspace writability.
# Prints whether each credential is present, never any part of its value.
HEALTHCHECK --interval=60s --timeout=20s --start-period=15s --retries=3 \
  CMD ["npx", "tsx", "scripts/worker-health.ts"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npx", "tsx", "scripts/worker.ts"]
