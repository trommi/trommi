# Trommi hub in a container. Build from the repository root:
#
#   docker build -f deploy/Dockerfile -t trommi-hub .
#
# What is copied is limited by deploy/Dockerfile.dockerignore (BuildKit reads
# the ignore file that sits next to the Dockerfile).
#
# Read "Container" in docs/operations.md first: agent sessions link to the hub
# over loopback and hand it attachments by path, so a hub in a container serves
# the pages but cannot be linked from outside the container without host networking.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-alpine
ENV NODE_ENV=production \
    BOARD_HUB_ONLY=1 \
    BOARD_DATA=/data \
    BOARD_HOST=0.0.0.0 \
    BOARD_PORT=8790
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server/server.mjs ./server/server.mjs
COPY client/web ./client/web
# The image ships a user "node" (uid 1000); the data directory is its only writable place.
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8790
# No route answers without a login, so "the server answers at all" is the check:
# 401 on / means healthy. Replace with /healthz once the server has one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.BOARD_PORT || 8790) + '/').then(r => process.exit(r.status < 500 ? 0 : 1), () => process.exit(1))"]
# Exec form, so no shell sits between the signal and node. Run with --init
# (compose: init: true), so PID 1 is an init that forwards SIGTERM and reaps.
CMD ["node", "server/server.mjs"]
