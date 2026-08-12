# One file, no dependencies, no build step.
FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./

# The archive keeps its ciphertext here. Mount a volume over it to keep it.
ENV CATHODE_DATA=/data
VOLUME /data
EXPOSE 8787

# Nothing here needs root.
USER node

CMD ["node", "server.mjs"]
