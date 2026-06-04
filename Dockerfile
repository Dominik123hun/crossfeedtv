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

# Production deps only (just `ws`); no dev, no optional.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

# App + static overlay
COPY --from=build /app/dist ./dist
COPY public ./public

# Writable data dir for the user/session store, owned by the runtime user.
# For durable data, mount a persistent disk here (or point DATA_DIR at a real DB host).
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV DATA_DIR=/app/data

# The platform injects PORT; default to 8080 for local `docker run`.
ENV PORT=8080
EXPOSE 8080

# Run as the built-in non-root user.
USER node

CMD ["node", "dist/index.js"]
