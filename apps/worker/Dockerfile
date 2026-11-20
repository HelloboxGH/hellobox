# Build context: repository root. Runs migrations (main app, cloud tables, then creators), then the worker.
FROM oven/bun:1.4.2-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/cloud-creators/package.json ./apps/cloud-creators/
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/cloud-billing/package.json ./packages/cloud-billing/
COPY packages/cloud-db/package.json ./packages/cloud-db/
COPY packages/cloud-demo/package.json ./packages/cloud-demo/
COPY packages/cloud-email/package.json ./packages/cloud-email/
COPY packages/config/package.json ./packages/config/
COPY packages/cloud-creators-db/package.json ./packages/cloud-creators-db/
COPY packages/db/package.json ./packages/db/
COPY packages/email/package.json ./packages/email/
COPY packages/extensions/package.json ./packages/extensions/
COPY packages/providers/package.json ./packages/providers/
COPY packages/mail/package.json ./packages/mail/
COPY packages/nezt/package.json ./packages/nezt/
COPY packages/queue/package.json ./packages/queue/
COPY packages/resend/package.json ./packages/resend/
COPY packages/storage/package.json ./packages/storage/
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app ./
COPY apps/worker ./apps/worker
COPY packages ./packages
USER bun
CMD ["sh", "-c", "bun packages/db/src/migrate.ts && bun packages/cloud-db/src/migrate.ts && bun packages/cloud-creators-db/src/migrate.ts && exec bun apps/worker/src/index.ts"]
