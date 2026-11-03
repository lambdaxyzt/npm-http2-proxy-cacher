# syntax=docker/dockerfile:1

# Base images are pulled through the ArvanCloud Docker Hub mirror by default.
ARG REGISTRY=docker.arvancloud.ir
FROM ${REGISTRY}/node:22-alpine

# Optional SOCKS5 proxy used only while building, to fetch pnpm and the
# dependencies. Leave SOCKS_HOST empty to connect directly. 127.0.0.1/localhost
# mean the build host, so they are mapped to host.docker.internal.
ARG SOCKS_HOST=
ARG SOCKS_PORT=1080
ARG PNPM_VERSION=10.24.0

WORKDIR /app

# Install dependencies first for better layer caching. pnpm-workspace.yaml
# carries the onlyBuiltDependencies allowlist (e.g. esbuild) and must be
# present before install so those build scripts are permitted to run.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# pnpm is installed with npm rather than corepack. npm and pnpm both read the
# npm_config_*proxy variables and support socks5h:// (DNS resolved by the
# proxy). They are only exported for this RUN, so they never reach the image.
RUN if [ -n "$SOCKS_HOST" ]; then \
      case "$SOCKS_HOST" in 127.0.0.1|localhost) SOCKS_HOST=host.docker.internal ;; esac; \
      export npm_config_proxy="socks5h://$SOCKS_HOST:$SOCKS_PORT"; \
      export npm_config_https_proxy="$npm_config_proxy"; \
      echo "fetching packages via $npm_config_proxy"; \
    fi && \
    npm install -g "pnpm@$PNPM_VERSION" --no-audit --no-fund && \
    pnpm install --frozen-lockfile

# Copy the rest of the source.
COPY . .

# Cached packages live here; mount a volume to persist them.
ENV STORAGE=/data
VOLUME ["/data"]

EXPOSE 4873

# Run directly with tsx. Env comes from the container environment
# (docker run --env-file .env ...), so no --env-file flag here.
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
