# The Trommi hub for protocol v2: one static binary on an empty image.
# Build from the repository root:
#   docker build -f hub/Dockerfile --build-arg COMMIT=$(git rev-parse HEAD) -t trommi-hub .
FROM rust:1.99-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY core core
COPY hub hub
COPY tests tests
# Only the hub is built; the lockfile pins every dependency.
RUN cargo build --release --locked -p trommi-hub \
 && mkdir -p /out/data && cp target/release/trommi-hub /out/trommi-hub

FROM scratch
ARG COMMIT=unknown
ENV COMMIT=$COMMIT \
    HUB_PORT=8790 \
    HUB_DATA=/data \
    HUB_URL=https://hub.trommi.com \
    HUB_ORIGINS=https://app.trommi.com
COPY --from=build /out/trommi-hub /trommi-hub
# The empty image has no mkdir: the data directory comes from the build stage, owned by the user the hub runs as.
COPY --from=build --chown=1000:1000 /out/data /data
USER 1000:1000
VOLUME /data
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s CMD ["/trommi-hub", "healthcheck"]
ENTRYPOINT ["/trommi-hub"]
