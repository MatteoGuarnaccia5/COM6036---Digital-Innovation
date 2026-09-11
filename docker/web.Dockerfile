# syntax=docker/dockerfile:1

# Debian slim rather than Alpine: bcrypt is a native module and ships prebuilt
# binaries for glibc, so the image needs no compiler toolchain.
FROM node:22-bookworm-slim AS base
WORKDIR /app

# ---------------------------------------------------------------------------
# Build stage: install the whole workspace, compile TypeScript, build the SPA.
# ---------------------------------------------------------------------------
FROM base AS build
ENV NODE_ENV=development

# Manifests first so `npm ci` is cached independently of source changes.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/data/package.json packages/data/
COPY apps/web/package.json apps/web/
COPY apps/scheduler/package.json apps/scheduler/
RUN npm ci

COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app

EXPOSE 3000

# No curl in the image; Node's built-in fetch does the job.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/dist/server/index.js"]
