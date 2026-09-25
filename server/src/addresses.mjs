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
  ['::', 127],
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
