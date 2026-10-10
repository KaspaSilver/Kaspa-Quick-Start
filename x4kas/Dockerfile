# x4kas (github.com/smartgoo/x4kas, MIT): the Kaspa terminal desktop app, run on a virtual
# screen and streamed to the browser with KasmVNC, so the panel can show it in a tab exactly
# as the downloaded app looks. The official release binary is used, pinned by version and
# checked against the release's SHA256SUMS.
FROM ghcr.io/linuxserver/baseimage-kasmvnc:debianbookworm

ARG X4KAS_VERSION=v0.1.0
ARG TARGETARCH

# OpenGL in software (eframe draws with glow), the keyboard map, TLS, fonts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl libgl1 libegl1 libgl1-mesa-dri libxkbcommon0 libxkbcommon-x11-0 \
      libssl3 fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    # TARGETARCH is only set by BuildKit; the legacy builder gets the image's own arch.
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) target=x86_64-unknown-linux-gnu ;; \
      arm64) target=aarch64-unknown-linux-gnu ;; \
      *) echo "x4kas has no Linux release for $arch" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/smartgoo/x4kas/releases/download/${X4KAS_VERSION}"; \
    file="x4kas-${X4KAS_VERSION}-${target}.tar.gz"; \
    cd /tmp; \
    curl -fsSLo "$file" "$base/$file"; \
    curl -fsSLo SHA256SUMS "$base/SHA256SUMS"; \
    grep " ${file}\$" SHA256SUMS | sha256sum -c -; \
    mkdir -p /opt/x4kas; \
    tar -xzf "$file" -C /opt/x4kas --strip-components=1; \
    find /opt/x4kas -maxdepth 2 -type f \( -name x4kas -o -name x4kas-cli \) -exec install -m 0755 {} /usr/local/bin/ \; ; \
    test -x /usr/local/bin/x4kas; \
    rm -rf /tmp/*

LABEL org.opencontainers.image.title="x4kas" \
      org.opencontainers.image.source="https://github.com/smartgoo/x4kas" \
      org.opencontainers.image.version="${X4KAS_VERSION}"

ENV TITLE=x4kas \
    LIBGL_ALWAYS_SOFTWARE=1 \
    X4KAS_VERSION=${X4KAS_VERSION}

COPY root/ /
