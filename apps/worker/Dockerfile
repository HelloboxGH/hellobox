# Build context: repository root. Applies database migrations, then runs the worker.
FROM oven/bun:1.4.2-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/config/package.json ./packages/config/
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
CMD ["sh", "-c", "bun packages/db/src/migrate.ts && exec bun apps/worker/src/index.ts"]
