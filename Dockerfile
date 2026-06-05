# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# Don't pull Chromium for the (optional) Kick library during builds.
ENV PUPPETEER_SKIP_DOWNLOAD=1

# Install deps (incl. dev for tsc); skip optionalDependencies (kick-js/puppeteer).
COPY package.json package-lock.json ./
RUN npm ci --omit=optional

# Compile TypeScript -> dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PUPPETEER_SKIP_DOWNLOAD=1

# su-exec lets the entrypoint fix volume ownership as root, then drop to "node".
RUN apk add --no-cache su-exec

# Production deps only (just `ws`); no dev, no optional.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

# App + static overlay + entrypoint
COPY --from=build /app/dist ./dist
COPY public ./public
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh && mkdir -p /app/data && chown -R node:node /app/data

# The platform injects PORT; default to 8080 for local `docker run`.
ENV PORT=8080
EXPOSE 8080

# NOTE: DATA_DIR is intentionally NOT pinned here so a Railway Volume's mount
# (RAILWAY_VOLUME_MOUNT_PATH) is picked up automatically; the entrypoint defaults
# it to /app/data otherwise. Mount your volume at /app/data for the simplest setup.

# The entrypoint starts as root only to make the (possibly volume-backed) data
# dir writable, then execs the app as the non-root "node" user.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
