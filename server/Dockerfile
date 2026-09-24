# The Nook server. Node and one dependency, the Postgres driver.
FROM node:22-alpine

LABEL org.opencontainers.image.title="cathode" \
      org.opencontainers.image.description="Nook server: end to end encrypted spaces in Postgres, one WebSocket per space, clustered across several operators"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.mjs ./
COPY src ./src

# Uploaded files, in /data/files, and the old file store, read once on upgrade.
ENV CATHODE_DATA=/data
RUN mkdir -p /data && chown node:node /data
EXPOSE 8787

# Nothing here needs root.
USER node

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:8787/api/v1/health || exit 1

CMD ["node", "server.mjs"]
