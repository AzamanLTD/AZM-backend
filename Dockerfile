# syntax=docker/dockerfile:1.7
# §WP-H §8 — reproducible full-suite stack.
# Pinned Node major (package.json engines: 24.x, .nvmrc: 24). Multi-stage so the
# runtime image carries production dependencies only; the Prisma client is
# generated in the build stage, never on boot. No credentials are baked in:
# every secret arrives as a runtime environment variable.
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NODE_ENV=development
COPY package.json package-lock.json ./
# Dependency scripts are ignored here so a postinstall cannot reach the network
# for a database; prisma generate is run explicitly below.
RUN npm ci --ignore-scripts
COPY prisma ./prisma
RUN npx prisma generate
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
# Prisma's query engine needs openssl at runtime; curl backs the healthcheck.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates curl \
 && apt-get clean
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY package.json ./
COPY . .
USER node
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-10000}/healthz" || exit 1
CMD ["node", "server.js"]
