# The manager is the control plane: it talks to the Docker daemon over the
# mounted socket and drives `docker compose` against the stack directory.
# It deliberately has zero npm dependencies -- everything uses the Node stdlib
# (including the global WebSocket client used to reach kaspad's wRPC port), so
# the image builds offline-friendly and there is no dependency tree to audit.
FROM node:22-alpine

# buildx is not optional: `docker compose build` drives BuildKit, and the kaspad
# Dockerfile selects its build stage from the predefined TARGETARCH arg, which
# the classic builder does not provide.
RUN apk add --no-cache \
    docker-cli \
    docker-cli-compose \
    docker-cli-buildx \
    curl \
    ca-certificates \
    tini

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production \
    PORT=8080 \
    STACK_LOCAL=/stack

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
