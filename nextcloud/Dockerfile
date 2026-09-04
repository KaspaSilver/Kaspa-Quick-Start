# Nextcloud image for the one-click stack.
#
# The official image plus ffmpeg, which is what OC\Preview\Movie shells out to
# for video thumbnails. Image previews, iPhone HEIC included, are handled by the
# separate Imaginary container; previews.config.php is what actually switches
# both of them on, since Nextcloud enables neither by default.
FROM nextcloud:stable

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.title="kaspa-quick-start-nextcloud" \
      org.opencontainers.image.source="https://github.com/KaspaSilver/Kaspa-Quick-Start"
