# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
WORKDIR /app

FROM base AS dependency-files
ENV ONNXRUNTIME_NODE_INSTALL=skip
COPY package.json pnpm-lock.yaml ./

FROM dependency-files AS build
RUN --mount=type=cache,id=pixelflow-pnpm,target=/pnpm/store,sharing=locked \
    corepack pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN corepack pnpm build

FROM dependency-files AS production-dependencies
RUN --mount=type=cache,id=pixelflow-pnpm,target=/pnpm/store,sharing=locked \
    corepack pnpm install --prod --frozen-lockfile --store-dir /pnpm/store

FROM base AS runtime
ENV NODE_ENV=production \
    PIXELFLOW_HEALTH_FILE=/run/pixelflow/health.json
RUN install -d -m 0755 -o node -g node /data /models /run/pixelflow \
    && install -d -m 0755 /etc/pixelflow
COPY package.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker/pixelflow.yaml /etc/pixelflow/pipelines.yaml
USER node
RUN node --input-type=module -e 'import sharp from "sharp"; import { DatabaseSync } from "node:sqlite"; await import("@huggingface/transformers"); await sharp({create:{width:1,height:1,channels:3,background:"white"}}).webp().toBuffer(); new DatabaseSync(":memory:").close();'
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
    CMD ["node", "/app/dist/infrastructure/healthcheck.js"]
CMD ["node", "/app/dist/main.js", "watch", "--config", "/etc/pixelflow/pipelines.yaml"]
