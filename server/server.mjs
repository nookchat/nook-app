import { createServer } from 'node:http'
import { handle } from './src/api.mjs'
import { startCluster } from './src/cluster.mjs'
import { ANY_ORIGIN, CLUSTERED, HAS_TURN, ORIGINS, PEERS, PORT, TURN_ONLY, TURN_URLS, VERSION } from './src/config.mjs'
import { migrate, pool, ready } from './src/db.mjs'
import { importFiles } from './src/import.mjs'
import { closeAll, upgrade } from './src/sockets.mjs'

await ready()
await migrate()
await importFiles()

const server = createServer((req, res) => void handle(req, res))
server.on('upgrade', upgrade)
// Cluster long polls wait up to 25 s; keep their sockets open past that.
server.keepAliveTimeout = 65_000
server.headersTimeout = 66_000

server.listen(PORT, () => {
  console.log(
    `[nook] ${VERSION} on :${PORT}, keeping spaces in Postgres, ` +
      `${HAS_TURN ? `TURN at ${TURN_URLS.join(' ')}${TURN_ONLY ? ' for every call' : ''}` : 'no TURN'}, ` +
      `${ANY_ORIGIN ? 'any page' : `pages from ${ORIGINS.join(' ')}`}, ` +
      `${CLUSTERED ? `cluster of ${PEERS.length + 1}` : 'no cluster'}`,
  )
  startCluster()
})

// Node as PID 1 ignores SIGTERM unless it is handled.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    closeAll()
    server.close(() => void pool.end().finally(() => process.exit(0)))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
