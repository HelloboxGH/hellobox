# HelloBox's mail server: Haraka with one plugin (plugins/hellobox.js). It keeps no mail and
# has no database: it only talks to HelloBox over HTTPS. Build from the repository root:
#   docker build -f apps/mx/Dockerfile apps/mx
FROM node:22-alpine

# Pinned. Bump by hand, the same day for security releases (github.com/haraka/Haraka/releases).
ARG HARAKA_VERSION=3.4.2
RUN npm install -g --omit=dev "Haraka@${HARAKA_VERSION}" && npm cache clean --force

WORKDIR /app
COPY config/ ./config/
COPY plugins/hellobox.js ./plugins/hellobox.js
COPY entrypoint.sh ./entrypoint.sh
# Where the settings are written at start. Mount a tmpfs here when the filesystem is read-only.
RUN mkdir -p /run/haraka && chown node:node /run/haraka

USER node
EXPOSE 2525
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD nc -z 127.0.0.1 2525 || exit 1
ENTRYPOINT ["/app/entrypoint.sh"]
