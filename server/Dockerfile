# The Cathode server. One file, no dependencies, no build step.
FROM node:22-alpine

LABEL org.opencontainers.image.title="cathode" \
      org.opencontainers.image.description="Cathode server: sealed history, a WebSocket relay, and TURN credentials"

WORKDIR /app
COPY server.mjs ./

# The server keeps its ciphertext here. Mount a volume over it to keep it.
ENV CATHODE_DATA=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787

# Nothing here needs root.
USER node

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:8787/health || exit 1

CMD ["node", "server.mjs"]
