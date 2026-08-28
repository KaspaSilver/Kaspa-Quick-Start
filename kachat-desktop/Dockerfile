# KaChat Desktop: the browser client, served from this machine.
#
# Unlike the indexer, upstream ships no Dockerfile, so this one lives here and
# clones the source itself. The context is therefore this small directory rather
# than a git URL, and KACHAT_DESKTOP_REF selects what gets checked out.
#
# This runs Vite's dev server rather than building static files and putting
# nginx in front, which would be the obvious choice. The app's Nextcloud
# integration is a `configureServer` middleware in vite.config.mjs: the
# /nc-proxy route that works around Nextcloud sending no CORS headers on WebDAV.
# That middleware exists only in the dev server. A static build comes up looking
# perfectly fine and then silently fails every Nextcloud preview and backup,
# which is why upstream's README also tells people to run `npm run dev`.
FROM node:22-alpine

# git to fetch the source; bash because `npm run dev` shells out to
# tools/check-wasm.sh and busybox sh is not bash.
RUN apk add --no-cache git bash

ARG KACHAT_DESKTOP_REPO=https://github.com/KaspaSilver/KaChat-Desktop.git
ARG KACHAT_DESKTOP_REF=main

WORKDIR /app
RUN git clone --depth 1 --branch "${KACHAT_DESKTOP_REF}" "${KACHAT_DESKTOP_REPO}" . \
    || git clone "${KACHAT_DESKTOP_REPO}" . && git checkout "${KACHAT_DESKTOP_REF}"

# The WASM bundles (kaspa/, cipher/) are committed upstream, so there is no Rust
# toolchain here and nothing else to fetch. check-wasm.sh fails loudly at
# startup if that ever stops being true.
RUN npm ci --no-audit --no-fund

EXPOSE 5173

# --host binds beyond loopback, which is what makes it reachable outside the
# container at all. Without it Vite listens only on 127.0.0.1 inside the
# container's own namespace, and the published port answers nothing.
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
