# NestJS control plane. Build from the repo root:
#   docker build -f docker/api.Dockerfile -t avg-api .
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @avg/api... --config.confirmModulesPurge=false
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm --filter @avg/contracts build \
  && pnpm --filter @avg/api prisma:generate \
  && pnpm --filter @avg/api build \
  && pnpm --filter @avg/api deploy --legacy --prod /out \
  && cd /out && node node_modules/prisma/build/index.js generate

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out ./
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/prisma ./prisma
RUN useradd --create-home --uid 10001 api && chown -R api:api /app
USER api
EXPOSE 4000
# Migrations run separately before a rollout (deploy/helm/avg/templates/migrate-job.yaml):
#   node node_modules/prisma/build/index.js migrate deploy
CMD ["node", "dist/main.js"]
