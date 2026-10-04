const CHUNK = 0x8000

/** The browser's own base64, where it has it (Chrome 140, Firefox 133, Safari 18.2): many times faster. */
interface NativeBase64 {
  fromBase64?: (text: string, options?: { alphabet?: 'base64' | 'base64url' }) => Uint8Array<ArrayBuffer>
}
const native = Uint8Array as unknown as NativeBase64
type ToBase64 = (options?: { alphabet?: 'base64' | 'base64url'; omitPadding?: boolean }) => string
const nativeTo = (Uint8Array.prototype as unknown as { toBase64?: ToBase64 }).toBase64

export function toBase64(bytes: Uint8Array): string {
  if (nativeTo) return nativeTo.call(bytes)
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(binary)
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  if (native.fromBase64) {
    try {
      return native.fromBase64(text)
    } catch {
      // Stricter than atob about what it takes: atob has the last word.
    }
  }
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function toBase64Url(bytes: Uint8Array): string {
  if (nativeTo) return nativeTo.call(bytes, { alphabet: 'base64url', omitPadding: true })
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (native.fromBase64) {
    try {
      return native.fromBase64(text, { alphabet: 'base64url' })
    } catch {
      // Not base64url after all: the old way takes either alphabet.
    }
  }
  return fromBase64(text.replace(/-/g, '+').replace(/_/g, '/'))
}

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export function fromHex(text: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
}
