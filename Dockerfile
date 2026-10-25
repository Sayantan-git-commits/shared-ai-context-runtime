# Shared AI Context Runtime - Production Multi-Stage Dockerfile
FROM node:22.13.0-alpine AS builder

WORKDIR /app

# Copy package manifests
COPY package.json package-lock.json ./
COPY packages/schemas/package.json ./packages/schemas/
COPY packages/serializers/package.json ./packages/serializers/
COPY packages/client-adapters/package.json ./packages/client-adapters/
COPY apps/api/package.json ./apps/api/
COPY apps/mcp-server/package.json ./apps/mcp-server/
COPY apps/cli/package.json ./apps/cli/

# Install dependencies deterministically
RUN npm ci

# Copy full source
COPY . .

# Build all monorepo workspaces in dependency order
RUN npm run build

# --- Production Image for API Gateway ---
FROM node:22.13.0-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Copy application assets
COPY --from=builder --chown=node:node /app /app

# Run as non-root unprivileged user
USER node

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "apps/api/dist/index.js"]
