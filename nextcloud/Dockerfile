# Nextcloud image for the one-click stack.
#
# Same as upstream KaChat-NextCloud: stock Nextcloud plus ffmpeg, which is what
# lets uploaded videos generate thumbnails. Image previews (including iPhone
# HEIC) are handled by the separate Imaginary container, not here.
FROM nextcloud:stable

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.title="kachat-nextcloud" \
      org.opencontainers.image.source="https://github.com/KaspaSilver/KaChat-NextCloud"
