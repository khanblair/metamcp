# Use the official uv image as base
FROM ghcr.io/astral-sh/uv:debian AS base

# Install Node.js and pnpm directly
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm@10.12.0 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED 1

# Copy root package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY turbo.json ./

# Copy package.json files from all workspaces
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/backend/package.json ./apps/backend/
COPY packages/eslint-config/package.json ./packages/eslint-config/
COPY packages/trpc/package.json ./packages/trpc/
COPY packages/typescript-config/package.json ./packages/typescript-config/
COPY packages/zod-types/package.json ./packages/zod-types/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Builder stage
FROM base AS builder
WORKDIR /app

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/frontend/node_modules ./apps/frontend/node_modules
COPY --from=deps /app/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=deps /app/packages ./packages

# Copy source code
COPY . .

# Build all packages and apps
RUN pnpm build

# Patch Next.js's proxy timeout regardless of the exact pnpm dependency-hash
# suffix in the path (it drifts with lockfile resolution, e.g. peer dep
# versions), unlike a hardcoded path which breaks the build on any drift.
RUN find node_modules/.pnpm -path "*/next@*/node_modules/next/dist/server/lib/router-utils/proxy-request.js" \
    -o -path "*/next@*/node_modules/next/dist/esm/server/lib/router-utils/proxy-request.js" \
    | xargs -r sed -i -e "s/30000/600000/"

# Production runner stage
FROM base AS runner
WORKDIR /app

# OCI image labels
LABEL org.opencontainers.image.source="https://github.com/metatool-ai/metamcp"
LABEL org.opencontainers.image.description="MetaMCP - aggregates MCP servers into a unified MetaMCP"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.title="MetaMCP"
LABEL org.opencontainers.image.vendor="metatool-ai"

# Install curl for health checks, and the Docker CLI so docker-based STDIO
# servers (github-mcp-server, sonarqube) can spawn sibling containers via the
# host socket mounted in docker-compose.yml.
RUN apt-get update && apt-get install -y curl postgresql-client docker.io && apt-get clean && rm -rf /var/lib/apt/lists/*

# Create non-root user with proper home directory
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 --home /home/nextjs nextjs && \
    mkdir -p /home/nextjs/.cache/node/corepack /home/nextjs/.cache/uv && \
    chown -R nextjs:nodejs /home/nextjs

# Copy built applications
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/.next ./apps/frontend/.next
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/package.json ./apps/frontend/
COPY --from=builder --chown=nextjs:nodejs /app/apps/backend/dist ./apps/backend/dist
COPY --from=builder --chown=nextjs:nodejs /app/apps/backend/package.json ./apps/backend/
COPY --from=builder --chown=nextjs:nodejs /app/apps/backend/drizzle ./apps/backend/drizzle
COPY --from=builder --chown=nextjs:nodejs /app/apps/backend/drizzle.config.ts ./apps/backend/

# Copy built packages
COPY --from=builder --chown=nextjs:nodejs /app/packages ./packages
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./
COPY --from=builder --chown=nextjs:nodejs /app/pnpm-workspace.yaml ./

# Install production dependencies only
# CI=true avoids ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY — pnpm needs
# this since `docker build` (like detached `docker compose up`) has no TTY.
RUN CI=true pnpm install --prod

# Install drizzle-kit locally in backend for migrations. drizzle-kit is
# already a devDependency there, so `pnpm add` (even with --prod) just
# updates its version in place under devDependencies instead of moving it —
# meaning it stays excluded by the prod-only install above and its binary
# never gets linked into apps/backend/node_modules/.bin. Using --filter from
# the workspace root (not `cd`) with both --save-prod (record under
# dependencies) and --prod (stay in the prod-only resolution mode the
# `pnpm install --prod` above already established, avoiding
# ERR_PNPM_INCLUDED_DEPS_CONFLICT) actually links the binary correctly.
RUN CI=true pnpm --filter backend add drizzle-kit@0.31.1 --save-prod --prod

# Copy startup script
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Not dropping to USER nextjs: the mounted host docker socket (needed for
# docker-based STDIO servers like github-mcp-server/sonarqube) is owned by
# root:root with no group access, and this is a single-user local gateway,
# not a multi-tenant service — matches Dockerfile.dev, which also runs as
# root for the same reason.

# Expose frontend port (Next.js)
EXPOSE 12008

# Health check
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:12008/health || exit 1

# Start both backend and frontend
CMD ["./docker-entrypoint.sh"] 