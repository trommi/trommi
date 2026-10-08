# The thin hub in Rust (hub-rs): one static binary on an empty image. Same port, volume, environment and user as
# hub/Dockerfile, so compose.yaml, apns.env, admin.env and compose.override.yaml on the server stay as they are.
# Build from the repository root:
#   docker build -f hub-rs/Dockerfile --build-arg COMMIT=$(git rev-parse HEAD) -t trommi-hub-rs .
FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY hub-rs/Cargo.toml hub-rs/Cargo.lock hub-rs/
COPY hub-rs/crates hub-rs/crates
RUN cd hub-rs && cargo build --release --locked -p trommi-hub \
 && mkdir -p /out/data && cp target/release/trommi-hub /out/trommi-hub

FROM scratch
ARG COMMIT=unknown
# Extra CORS origins baked in by the deploy (the tailnet design preview), as in hub/Dockerfile.
ARG PREVIEW_ORIGINS=
ENV COMMIT=$COMMIT \
    HUB_PREVIEW_ORIGINS=$PREVIEW_ORIGINS \
    NODE_ENV=production \
    HUB_PORT=8790 \
    HUB_DATA=/data \
    HUB_URL=https://hub.trommi.com \
    HUB_TRUST_CF=1
COPY --from=build /out/trommi-hub /trommi-hub
# uid 1000 is the node user of the Node image: the same /data volume stays writable.
COPY --from=build --chown=1000:1000 /out/data /data
USER 1000:1000
VOLUME /data
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s CMD ["/trommi-hub", "healthcheck"]
ENTRYPOINT ["/trommi-hub"]
