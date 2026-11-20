# syntax=docker/dockerfile:1
FROM debian:bookworm-slim AS cc-connect
ARG CC_CONNECT_VERSION=1.5.2
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/cc
RUN set -eu; \
    asset="cc-connect-v${CC_CONNECT_VERSION}-linux-${TARGETARCH}.tar.gz"; \
    base="https://github.com/chenhg5/cc-connect/releases/download/v${CC_CONNECT_VERSION}"; \
    curl -fsSL --retry 3 "$base/$asset" -o "$asset"; \
    curl -fsSL --retry 3 "$base/checksums.txt" -o checksums.txt; \
    grep " $asset\$" checksums.txt | sha256sum -c -; \
    tar -xzf "$asset"; \
    install -m 0755 "${asset%.tar.gz}" /usr/local/bin/cc-connect

FROM node:22-bookworm-slim
ARG CODEX_VERSION=0.170.0
ENV NODE_ENV=production \
    DECK_HOST=0.0.0.0 \
    PORT=3030 \
    DECK_DATA_DIR=/data \
    DECK_HOME=/data/home \
    HOME=/data/home \
    CODEX_HOME=/data/codex \
    DECK_WORKSPACE_ROOT=/workspaces
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git openssh-client bash ripgrep tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --ignore-scripts "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force
COPY --from=cc-connect /usr/local/bin/cc-connect /usr/local/bin/cc-connect
COPY scripts/install-codex-platform.mjs /tmp/install-codex-platform.mjs
RUN node /tmp/install-codex-platform.mjs "$CODEX_VERSION" \
    && codex --version && rm /tmp/install-codex-platform.mjs
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY LICENSE ./LICENSE
RUN mkdir -p /data/home /data/codex /workspaces && chown -R node:node /data /workspaces
USER node
EXPOSE 3030
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3030/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
