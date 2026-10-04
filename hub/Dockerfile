# The thin hub (hub/server.mjs). Build from the repository root:
#   docker build -f hub/Dockerfile --build-arg COMMIT=$(git rev-parse HEAD) -t trommi-hub .
FROM node:26-alpine
ARG COMMIT=unknown
# Extra CORS origins baked in by the deploy (the tailnet design preview; .github/workflows/deploy.yml).
ARG PREVIEW_ORIGINS=
ENV COMMIT=$COMMIT \
    HUB_PREVIEW_ORIGINS=$PREVIEW_ORIGINS \
    NODE_ENV=production \
    HUB_PORT=8790 \
    HUB_DATA=/data \
    HUB_URL=https://hub.trommi.com \
    HUB_TRUST_CF=1
WORKDIR /app
COPY core/zcrypto.mjs core/hub.mjs core/session-grants.mjs core/codec.mjs core/
COPY hub/server.mjs hub/store.mjs hub/attachments.mjs hub/push.mjs hub/accounts.mjs hub/mail.mjs hub/admin.mjs hub/admin-view.mjs hub/
COPY hub/ops hub/ops
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8790/healthz >/dev/null || exit 1
CMD ["node", "hub/server.mjs"]
