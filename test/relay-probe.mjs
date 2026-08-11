/**
 * Checks which Nostr relays really carry a Cathode handshake.
 *
 * A TCP connection proves nothing. A relay has to accept our ephemeral event
 * kind and hand it straight to a live subscriber. This publishes one event and
 * waits to receive it back on a second connection, which is exactly what a host
 * and a viewer do.
 *
 *   node test/relay-probe.mjs
 */

import { schnorr } from '@noble/curves/secp256k1'
import { createHash } from 'node:crypto'

const KIND = 20666
const TIMEOUT_MS = 9000

const CANDIDATES = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.snort.social',
  'wss://offchain.pub',
  'wss://relay.nostr.band',
  'wss://nostr.wine',
  'wss://relay.mostr.pub',
  'wss://purplerelay.com',
]

const hex = (b) => Buffer.from(b).toString('hex')
const priv = schnorr.utils.randomSecretKey()
const pub = hex(schnorr.getPublicKey(priv))

function signEvent(topic, content) {
  const created_at = Math.floor(Date.now() / 1000)
  const tags = [['t', topic]]
  const serial = JSON.stringify([0, pub, created_at, KIND, tags, content])
  const id = createHash('sha256').update(serial).digest('hex')
  const sig = hex(schnorr.sign(Buffer.from(id, 'hex'), priv))
  return { id, pubkey: pub, created_at, kind: KIND, tags, content, sig }
}

function probe(url) {
  return new Promise((resolve) => {
    const topic = 'cathode-probe-' + Math.random().toString(36).slice(2, 10)
    const payload = 'hello-' + Math.random().toString(36).slice(2, 10)
    const started = Date.now()
    let settled = false
    let notice = ''

    const done = (ok, detail) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        sub.close()
        pubws.close()
      } catch {
        /* already closing */
      }
      resolve({ url, ok, detail, ms: Date.now() - started })
    }

    const timer = setTimeout(() => done(false, notice || 'no delivery inside the timeout'), TIMEOUT_MS)

    let sub
    let pubws
    try {
      sub = new WebSocket(url)
      pubws = new WebSocket(url)
    } catch (err) {
      done(false, String(err))
      return
    }

    sub.onerror = () => done(false, 'the subscriber socket failed')
    pubws.onerror = () => done(false, 'the publisher socket failed')

    sub.onopen = () => {
      sub.send(JSON.stringify(['REQ', 'probe', { kinds: [KIND], '#t': [topic] }]))
    }

    sub.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg[0] === 'EVENT' && msg[2]?.content === payload) done(true, 'delivered')
      if (msg[0] === 'CLOSED') done(false, `subscription refused: ${msg[2] ?? ''}`)
      if (msg[0] === 'NOTICE') notice = `notice: ${msg[1] ?? ''}`
      if (msg[0] === 'EOSE') {
        // The subscription is live now, so it is safe to publish.
        if (pubws.readyState === 1) pubws.send(JSON.stringify(['EVENT', signEvent(topic, payload)]))
      }
    }

    pubws.onopen = () => {
      // Some relays send no EOSE for an unknown kind, so publish anyway.
      setTimeout(() => {
        if (!settled && pubws.readyState === 1) {
          pubws.send(JSON.stringify(['EVENT', signEvent(topic, payload)]))
        }
      }, 1200)
    }

    pubws.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg[0] === 'OK' && msg[2] === false) done(false, `event refused: ${msg[3] ?? ''}`)
      if (msg[0] === 'NOTICE') notice = `notice: ${msg[1] ?? ''}`
    }
  })
}

const results = await Promise.all(CANDIDATES.map(probe))
results.sort((a, b) => Number(b.ok) - Number(a.ok) || a.ms - b.ms)

console.log('Relays that carry a Cathode handshake:\n')
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.url.padEnd(30)} ${String(r.ms).padStart(5)} ms  ${r.detail}`)
}
const good = results.filter((r) => r.ok)
console.log(`\n${good.length} of ${results.length} usable.`)
console.log('Suggested list:', good.slice(0, 3).map((r) => r.url).join(', '))
process.exit(good.length >= 2 ? 0 : 1)
