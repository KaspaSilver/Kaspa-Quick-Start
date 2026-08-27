# kaspad image for the one-click stack.
#
# On linux/amd64 we grab the official release archive from
# github.com/kaspanet/rusty-kaspa -- those binaries are static-pie musl builds,
# so they run unmodified on a bare alpine base and the image builds in seconds.
#
# There is no linux/arm64 release asset, so on arm64 we build kaspad from source
# at the same tag. That is slow (30-60 min) but keeps the stack working on
# Apple Silicon and arm servers.

ARG KASPAD_VERSION=v2.0.1
ARG REPO_URL=https://github.com/kaspanet/rusty-kaspa

# ---------------------------------------------------------------- amd64 path --
FROM alpine:3.21 AS bin-amd64
ARG KASPAD_VERSION
ARG REPO_URL
RUN apk add --no-cache curl unzip ca-certificates
RUN set -eux; \
    mkdir -p /out; \
    url="${REPO_URL}/releases/download/${KASPAD_VERSION}/rusty-kaspa-${KASPAD_VERSION}-linux-amd64.zip"; \
    echo "Downloading ${url}"; \
    curl -fsSL --retry 3 --retry-delay 2 -o /tmp/rk.zip "$url"; \
    unzip -j /tmp/rk.zip 'bin/kaspad' -d /out; \
    rm -f /tmp/rk.zip; \
    chmod +x /out/kaspad; \
    /out/kaspad --version || true

# ---------------------------------------------------------------- arm64 path --
FROM rust:1.91-alpine3.23 AS bin-arm64
ARG KASPAD_VERSION
ARG REPO_URL
RUN apk --no-cache add musl-dev protobuf-dev g++ clang21-dev linux-headers openssl-dev git
WORKDIR /src
RUN git clone --depth 1 --branch "${KASPAD_VERSION}" "${REPO_URL}" .
ENV RUSTFLAGS="-C target-feature=-crt-static" \
    CARGO_REGISTRIES_CRATES_IO_PROTOCOL="sparse"
RUN cargo build --release --bin kaspad \
    && mkdir -p /out \
    && cp target/release/kaspad /out/kaspad

# Selects bin-amd64 / bin-arm64 based on the build platform.
FROM bin-${TARGETARCH} AS binary

# -------------------------------------------------------------------- runtime --
FROM alpine:3.21 AS runtime
ARG KASPAD_VERSION
RUN apk --no-cache add ca-certificates tini libgcc libstdc++ \
    && addgroup -S kaspa \
    && adduser -S -G kaspa -h /home/kaspa -s /sbin/nologin kaspa \
    && mkdir -p /data /conf \
    && chown -R kaspa:kaspa /data /home/kaspa

COPY --from=binary /out/kaspad /usr/local/bin/kaspad
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV HOME=/home/kaspa \
    KASPAD_ARGS_FILE=/conf/kaspad.args \
    KASPAD_APPDIR=/data
LABEL org.opencontainers.image.title="kaspad" \
      org.opencontainers.image.source="https://github.com/kaspanet/rusty-kaspa" \
      io.kaspa.oneclick.version="${KASPAD_VERSION}"

USER kaspa
WORKDIR /data

# P2P, gRPC, wRPC-borsh, wRPC-json (mainnet numbering)
EXPOSE 16111 16110 17110 18110

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
