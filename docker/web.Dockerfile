# Next.js dashboard. Build from the repo root:
#   docker build -f docker/web.Dockerfile -t avg-web --build-arg NEXT_PUBLIC_API_URL=https://api.example.com .
FROM node:22-bookworm-slim AS build
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @avg/web...
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN pnpm --filter @avg/contracts build && pnpm --filter @avg/web build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo
COPY --from=build /repo ./
RUN useradd --create-home --uid 10001 web && chown -R web:web /repo
USER web
EXPOSE 3000
CMD ["pnpm", "--filter", "@avg/web", "start"]
