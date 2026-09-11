# syntax=docker/dockerfile:1

# The scheduler is built from the same workspace as the web app - it shares the
# business logic and data access layers - but it is a separate image with a
# separate lifecycle. Rebuilding or restarting one does not touch the other.
FROM node:22-bookworm-slim AS base
WORKDIR /app

FROM base AS build
ENV NODE_ENV=development

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/data/package.json packages/data/
COPY apps/web/package.json apps/web/
COPY apps/scheduler/package.json apps/scheduler/
RUN npm ci

COPY . .
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app

CMD ["node", "apps/scheduler/dist/index.js"]
