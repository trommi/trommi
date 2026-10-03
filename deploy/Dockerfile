# Trommi hub in a container. Build from the repository root:
#
#   docker build -f deploy/Dockerfile -t trommi-hub .
#
# What is copied is limited by deploy/Dockerfile.dockerignore (BuildKit reads
# the ignore file that sits next to the Dockerfile). The data directory is never
# part of the build context: it holds the token, the admin key and the speech key.
#
# Read "Container" in docs/operations.md first: agent sessions link to the hub
# over loopback and hand it attachments by path, so a hub in a container serves
# the pages but cannot be linked from outside the container without host networking.

# Node 26, the version the hub is developed and tested on (node:sqlite needs 22.13 or newer).
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:26-alpine
# BOARD_DRAWINGS points into the volume: the image's copy of client/web is read-only,
# and a drawings list placed in the data directory overrides the shipped one.
ENV NODE_ENV=production \
    BOARD_HUB_ONLY=1 \
    BOARD_DATA=/data \
    BOARD_HOST=0.0.0.0 \
    BOARD_PORT=8790
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
# The hub: server.mjs with everything it imports (views/, store/, the push, passkey,
# pairing and pad modules) and the crypto it shares with the client.
COPY server ./server
COPY crypto ./crypto
# The web client: pages, css, js (incl. js/pen.js, which the server imports too),
# the Turbo client in t/, vendor/, icons, pad.
COPY client/web ./client/web
# The two pictures the "test cards" menu item attaches.
COPY demo/design-a.png demo/design-b.png ./demo/
# The image ships a user "node" (uid 1000); the data directory is its only writable place.
RUN mkdir -m 700 /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8790
# /healthz answers 200 {"ok":true} without a login.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.BOARD_PORT || 8790) + '/healthz').then(r => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))"]
# Exec form, so no shell sits between the signal and node. Run with --init
# (compose: init: true), so PID 1 is an init that forwards SIGTERM and reaps.
CMD ["node", "server/server.mjs"]
