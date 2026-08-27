# Stratum bridge image.
#
# Same build strategy as kaspad: on linux/amd64 the official release archive
# already contains a static musl `stratum-bridge`, so the image is Alpine plus
# one file. arm64 has no release asset and compiles from source at the same tag.
#
# The dashboard's HTML/CSS/JS are embedded into the binary with include_dir!,
# so nothing else needs to be copied in for the web UI to work.

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
    unzip -j /tmp/rk.zip 'bin/stratum-bridge' -d /out; \
    rm -f /tmp/rk.zip; \
    chmod +x /out/stratum-bridge

# ---------------------------------------------------------------- arm64 path --
FROM rust:1.91-alpine3.23 AS bin-arm64
ARG KASPAD_VERSION
ARG REPO_URL
RUN apk --no-cache add musl-dev protobuf-dev g++ clang21-dev linux-headers openssl-dev git
WORKDIR /src
RUN git clone --depth 1 --branch "${KASPAD_VERSION}" "${REPO_URL}" .
ENV RUSTFLAGS="-C target-feature=-crt-static" \
    CARGO_REGISTRIES_CRATES_IO_PROTOCOL="sparse"
# No --features rkstratum_cpu_miner: the published release binaries are built
# without it, and matching them keeps behaviour identical across architectures.
RUN cargo build -p kaspa-stratum-bridge --release --bin stratum-bridge \
    && mkdir -p /out \
    && cp target/release/stratum-bridge /out/stratum-bridge

FROM bin-${TARGETARCH} AS binary

# -------------------------------------------------------------------- runtime --
FROM alpine:3.21 AS runtime
ARG KASPAD_VERSION
RUN apk --no-cache add ca-certificates tini libgcc libstdc++ \
    && addgroup -S kaspa \
    && adduser -S -G kaspa -h /home/kaspa -s /sbin/nologin kaspa \
    && mkdir -p /conf /data \
    && chown -R kaspa:kaspa /home/kaspa /data

COPY --from=binary /out/stratum-bridge /usr/local/bin/stratum-bridge

ENV HOME=/home/kaspa
LABEL org.opencontainers.image.title="kaspa-stratum-bridge" \
      org.opencontainers.image.source="https://github.com/kaspanet/rusty-kaspa" \
      io.kaspa.oneclick.version="${KASPAD_VERSION}"

USER kaspa
WORKDIR /data

# Stratum listeners, web dashboard, per-instance Prometheus endpoints.
EXPOSE 5555 3030 2114

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/stratum-bridge"]
# --node-mode external: kaspad runs as its own container in this stack, so the
# bridge must never start a second in-process node against the same database.
CMD ["--config", "/conf/bridge.yaml", "--node-mode", "external"]
