# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV npm_config_update_notifier=false
COPY package.json package-lock.json ./
RUN npm ci
COPY . ./
RUN npm run build:selfhost

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    OKRI_DATA_PATH=/var/lib/okri \
    OKRI_DB_PATH=/var/lib/okri/okri.sqlite \
    OKRI_STORAGE_PATH=/var/lib/okri/storage \
    OKRI_BACKUP_PATH=/var/lib/okri/backups
COPY --from=build /app/dist/standalone ./
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts/selfhost-migrate.mjs /app/scripts/selfhost-import-d1.mjs /app/scripts/selfhost-import-r2.mjs /app/scripts/selfhost-backup.mjs /app/scripts/selfhost-unpack-sites-export.mjs ./scripts/
# The official Node image already owns UID/GID 1000 (`node`). Reusing it keeps
# the filesystem contract aligned with the Kubernetes security context.
RUN mkdir -p /var/lib/okri /tmp && chown -R node:node /var/lib/okri /tmp
USER node
EXPOSE 3000
CMD ["node", "--experimental-sqlite", "server.js"]
