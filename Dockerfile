FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@10.29.2 --activate
WORKDIR /app

# Install dependencies
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/jobs/package.json packages/jobs/
COPY packages/scrapers/package.json packages/scrapers/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source and build
COPY packages/core/ packages/core/
COPY packages/server/ packages/server/
COPY packages/jobs/ packages/jobs/
COPY packages/scrapers/ packages/scrapers/
COPY packages/web/ packages/web/
COPY scripts/ scripts/
RUN pnpm -r build

# Production image
FROM node:20-slim AS runtime
RUN corepack enable && corepack prepare pnpm@10.29.2 --activate

# Run as non-root user
RUN groupadd --gid 1001 everycal && \
    useradd --uid 1001 --gid everycal --shell /bin/sh --create-home everycal

WORKDIR /app

COPY --from=base /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=base /app/packages/core/package.json packages/core/
COPY --from=base /app/packages/core/dist packages/core/dist
COPY --from=base /app/packages/server/package.json packages/server/
COPY --from=base /app/packages/server/dist packages/server/dist
COPY --from=base /app/packages/jobs/package.json packages/jobs/
COPY --from=base /app/packages/jobs/dist packages/jobs/dist
COPY --from=base /app/packages/scrapers/package.json packages/scrapers/
COPY --from=base /app/packages/scrapers/dist packages/scrapers/dist
COPY --from=base /app/packages/web/dist packages/web/dist
COPY --from=base /app/scripts scripts/
COPY --from=base /app/node_modules node_modules
COPY --from=base /app/packages/core/node_modules packages/core/node_modules
COPY --from=base /app/packages/server/node_modules packages/server/node_modules
COPY --from=base /app/packages/jobs/node_modules packages/jobs/node_modules
COPY --from=base /app/packages/scrapers/node_modules packages/scrapers/node_modules

COPY docker-entrypoint.sh /app/
RUN chmod +x /app/docker-entrypoint.sh

# Create data directory owned by non-root user
RUN mkdir -p /data /app/uploads && chown -R everycal:everycal /data /app/uploads /app

USER everycal

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/everycal.db
ENV UPLOAD_DIR=/app/uploads
EXPOSE 3000

VOLUME /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/healthz').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["/app/docker-entrypoint.sh"]
