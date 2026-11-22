# Build context: repository root.
FROM oven/bun:1.4.2-slim AS base
COPY --from=node:24-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/config/package.json ./packages/config/
COPY packages/eslint-config/package.json ./packages/eslint-config/
COPY packages/db/package.json ./packages/db/
COPY packages/email/package.json ./packages/email/
COPY packages/extensions/package.json ./packages/extensions/
COPY packages/providers/package.json ./packages/providers/
COPY packages/mail/package.json ./packages/mail/
COPY packages/nezt/package.json ./packages/nezt/
COPY packages/queue/package.json ./packages/queue/
COPY packages/resend/package.json ./packages/resend/
COPY packages/storage/package.json ./packages/storage/
RUN bun install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app ./
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN bun run --filter @hellobox/web build
RUN cp -r apps/web/public apps/web/.next/standalone/apps/web/public && \
    cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
