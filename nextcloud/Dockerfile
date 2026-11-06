# Nextcloud image for the one-click stack: KaChat Nextcloud.
#
# The official image plus ffmpeg, which is what OC\Preview\Movie shells out to
# for video thumbnails. The panel (lib/nextcloud.js) switches the preview
# providers on with occ, since Nextcloud enables neither video nor HEIC by
# default.
FROM nextcloud:stable

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.title="kaspa-quick-start-nextcloud" \
      org.opencontainers.image.source="https://github.com/KaspaSilver/Kaspa-Quick-Start"
