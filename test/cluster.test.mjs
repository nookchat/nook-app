import { check, finish, poll, stoppedEarly, wait } from './harness.mjs'
import { startServer } from './pg.mjs'

const until = (test, ms = 15_000) => poll(test, ms, 150)

const SECRET = 'a-cluster-secret-for-tests'
const A = 'http://localhost:8801'
const B = 'http://localhost:8802'
const cluster = (self, peer) => ({ CATHODE_PUBLIC_URL: self, CATHODE_PEERS: peer, CATHODE_CLUSTER_SECRET: SECRET })

let a = await startServer(8801, cluster(A, B))
const b = await startServer(8802, cluster(B, A))
const room = 'c'.repeat(32)

function socket(base) {
  const got = []
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/v1/spaces/${room}/socket`)
  ws.onmessage = (e) => got.push(JSON.parse(e.data))
  return new Promise((ok) => (ws.onopen = () => ok({ ws, got })))
}
const lines = (got) => got.filter((m) => m.t === 'ev' || m.t === 'page').flatMap((m) => m.lines)
const read = async (base) => (await (await fetch(`${base}/api/v1/spaces/${room}/events?after=0`)).json()).events

try {
  const health = await (await fetch(`${A}/api/v1/health`)).json()
  check('each server names the whole cluster', health.cluster.join() === [A, B].join(), health.cluster.join(' '))

  const onB = await socket(B)
  onB.ws.send(JSON.stringify({ t: 'hello', from: 0 }))
  const onA = await socket(A)
  onA.ws.send(JSON.stringify({ t: 'hello', from: 0 }))
  await wait(200)

  const started = Date.now()
  onA.ws.send(JSON.stringify({ t: 'put', id: '1', lines: ['sealed one', 'sealed two'], w: 'token' }))
  const crossed = await until(() => lines(onB.got).includes('sealed two'))
  check('a line written on one server reaches a reader on the other, live', crossed, `${Date.now() - started} ms`)

  const claimed = await until(async () => {
    const res = await fetch(`${B}/api/v1/spaces/${room}/events`, {
      method: 'POST',
      headers: { 'x-cathode-write': 'not the token' },
      body: JSON.stringify({ events: ['junk'] }),
    })
    return res.status === 403
  }, 10_000)
  check('the space is claimed on both servers by the one token', claimed)

  onB.ws.send(JSON.stringify({ t: 'put', id: '2', lines: ['from b'], w: 'token' }))
  check('and back the other way', await until(() => lines(onA.got).includes('from b')))

  const me = 'f'.repeat(64)
  await fetch(`${A}/api/v1/people/${me}`, {
    method: 'PUT',
    headers: { 'x-cathode-write': 'mine' },
    body: JSON.stringify({ blob: 'my sealed spaces' }),
  })
  check(
    "a person's record crosses",
    await until(async () => (await (await fetch(`${B}/api/v1/people/${me}`)).json()).blob === 'my sealed spaces'),
  )

  await wait(1500)
  const onEach = [await read(A), await read(B)]
  check(
    'every line is kept once on each server',
    onEach.every((l) => l.length === 3 && new Set(l).size === 3),
    onEach.map((l) => l.length).join(' and '),
  )

  onA.ws.close()
  a.child.kill()
  await wait(500)
  for (let i = 0; i < 50; i++) {
    onB.ws.send(JSON.stringify({ t: 'put', id: `x${i}`, lines: [`while a was down ${i}`], w: 'token' }))
  }
  await until(async () => (await read(B)).length === 53)
  a = await startServer(8801, { ...cluster(A, B), DATABASE_URL: a.database })
  const caught = await until(async () => (await read(A)).length === 53, 30_000)
  check('a server that was down catches up on what it missed', caught, `${(await read(A)).length} of 53`)
} catch (err) {
  stoppedEarly(err)
} finally {
  a.child.kill()
  b.child.kill()
}

finish()
