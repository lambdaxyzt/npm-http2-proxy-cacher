# syntax=docker/dockerfile:1

FROM node:22-alpine

# Enable pnpm via corepack (version pinned by package.json "packageManager").
RUN corepack enable

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy the rest of the source.
COPY . .

# Cached packages live here; mount a volume to persist them.
ENV STORAGE=/data
VOLUME ["/data"]

EXPOSE 4873

# Run directly with tsx. Env comes from the container environment
# (docker run --env-file .env ...), so no --env-file flag here.
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
