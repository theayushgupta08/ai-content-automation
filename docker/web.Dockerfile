# Next.js dashboard. NEXT_PUBLIC_* values are inlined at build time, so one image is built per
# environment (see .github/workflows/release.yml). Build from the repo root:
#   docker build -f docker/web.Dockerfile -t avg-web \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.example.com \
#     --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_... .
FROM node:22-bookworm-slim AS build
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @avg/web... --config.confirmModulesPurge=false
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN pnpm --filter @avg/contracts build && pnpm --filter @avg/web build

# The standalone output contains the server, its traced node_modules and the workspace
# packages it imports; static assets are copied next to it.
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
RUN useradd --create-home --uid 10001 web && chown -R web:web /app
USER web
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
