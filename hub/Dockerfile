# The thin hub (hub/server.mjs). Build from the repository root:
#   docker build -f hub/Dockerfile --build-arg COMMIT=$(git rev-parse HEAD) -t trommi-hub .
FROM node:26-alpine
ARG COMMIT=unknown
ENV COMMIT=$COMMIT \
    NODE_ENV=production \
    HUB_PORT=8790 \
    HUB_DATA=/data \
    HUB_URL=https://hub.trommi.com
WORKDIR /app
COPY crypto/zcrypto.mjs crypto/hub.mjs crypto/
COPY hub/server.mjs hub/store.mjs hub/attachments.mjs hub/push.mjs hub/
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8790/healthz >/dev/null || exit 1
CMD ["node", "hub/server.mjs"]
