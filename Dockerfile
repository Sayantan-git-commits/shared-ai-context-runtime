# Shared AI Context Runtime - Production Dockerfile
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package manifests
COPY package.json package-lock.json ./
COPY packages/schemas/package.json ./packages/schemas/
COPY packages/serializers/package.json ./packages/serializers/
COPY packages/client-adapters/package.json ./packages/client-adapters/
COPY apps/api/package.json ./apps/api/
COPY apps/mcp-server/package.json ./apps/mcp-server/
COPY apps/cli/package.json ./apps/cli/

# Install dependencies
RUN npm ci

# Copy full source
COPY . .

# Build all packages in order
RUN npm run build

# --- Production Image for API Service ---
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

COPY --from=builder /app /app

EXPOSE 3000

CMD ["node", "apps/api/dist/index.js"]
