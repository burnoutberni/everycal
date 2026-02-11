FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@10.29.2 --activate
WORKDIR /app

# Install dependencies
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source and build
COPY packages/core/ packages/core/
COPY packages/server/ packages/server/
RUN pnpm -r build

# Production image
FROM node:20-slim AS runtime
RUN corepack enable && corepack prepare pnpm@10.29.2 --activate
WORKDIR /app

COPY --from=base /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=base /app/packages/core/package.json packages/core/
COPY --from=base /app/packages/core/dist packages/core/dist
COPY --from=base /app/packages/server/package.json packages/server/
COPY --from=base /app/packages/server/dist packages/server/dist
COPY --from=base /app/node_modules node_modules
COPY --from=base /app/packages/core/node_modules packages/core/node_modules
COPY --from=base /app/packages/server/node_modules packages/server/node_modules

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/everycal.db
EXPOSE 3000

VOLUME /data

CMD ["node", "packages/server/dist/index.js"]
