import { lookup } from 'node:dns'
import { BlockList, isIP } from 'node:net'

const PRIVATE = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
]) {
  PRIVATE.addSubnet(net, bits, 'ipv4')
}
for (const [net, bits] of [
  // Unspecified, loopback, and IPv4 written inside IPv6 the old way (::a.b.c.d).
  ['::', 96],
  // IPv4 behind NAT64, and 6to4: an IPv4 address inside, which may be a private one.
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['2002::', 16],
  // Discard, and documentation.
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  PRIVATE.addSubnet(net, bits, 'ipv6')
}

export function isPrivateAddress(address) {
  const family = isIP(address)
  if (family === 0) return true
  return PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

/**
 * A DNS lookup for a request this server makes for somebody else: it refuses a name that leads
 * to a private address. The connection uses the address checked here, so a name that changes its
 * answer between a check and the request cannot slip past.
 */
export function publicLookup(allowPrivate = false) {
  return (host, options, done) => {
    lookup(host, { ...options, all: true }, (err, addresses) => {
      if (err) return done(err)
      if (!allowPrivate && addresses.some((a) => isPrivateAddress(a.address))) {
        return done(Object.assign(new Error(`${host} is a private address`), { code: 'EPRIVATE' }))
      }
      if (options.all) done(null, addresses)
      else done(null, addresses[0].address, addresses[0].family)
    })
  }
}
