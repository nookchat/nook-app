/**
 * Moving who you are onto another device.
 *
 * Your identity is a key on this machine and nowhere else, which is what makes
 * a name yours and old messages still yours. It also means a second device is a
 * second person unless the key goes with you. Exporting a file and carrying it
 * across works and nobody does it.
 *
 * So: one device shows the key as a QR code, the other reads it with its
 * camera. No server, no account, no upload. Where a browser has no barcode
 * reader, the same string can be pasted, which is the same thing with more
 * typing.
 *
 * The code on screen is the private key in the clear. It is shown behind a
 * question, it says what it is, and it takes itself away after a minute,
 * because a key left on a screen in an office is a key somebody photographs.
 */

import { h, clear } from './dom'
import { icon } from './icons'
import { qrSvg } from './qr'
import { toast } from './toast'
import { loadIdentity, secretForLinking, takeIdentity } from '../store/identity'
import { loadAvatar, saveAvatar } from './avatar'

/** How long the key stays on screen before it puts itself away. */
const SHOW_FOR_MS = 60_000

const PREFIX = 'cathode1:'

/** What travels: the key, the name, and the picture if it is small enough. */
function payload(): string {
  const secret = secretForLinking()
  if (!secret) throw new Error('This browser will not let a key be read back.')
  const me = loadIdentity()
  const avatar = loadAvatar()
  const body = JSON.stringify({ k: secret, n: me.name, a: avatar || undefined })
  return PREFIX + btoa(unescape(encodeURIComponent(body)))
}

export interface Linked {
  name: string
  avatar: string
}

/** Read one back. Returns null when the text is not one of ours. */
export function readPayload(text: string): Linked | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(PREFIX)) return null
  try {
    const body = JSON.parse(decodeURIComponent(escape(atob(trimmed.slice(PREFIX.length))))) as {
      k?: unknown
      n?: unknown
      a?: unknown
    }
    if (typeof body.k !== 'string' || !/^[0-9a-f]{64}$/.test(body.k)) return null
    takeIdentity(body.k)
    const name = typeof body.n === 'string' ? body.n.slice(0, 24) : ''
    const avatar = typeof body.a === 'string' ? body.a : ''
    if (avatar) saveAvatar(avatar)
    return { name, avatar }
  } catch {
    return null
  }
}

/** A dialog, with the keyboard kept inside it while it is up. */
function dialog(title: string, body: HTMLElement[], onClose?: () => void): () => void {
  const previous = document.activeElement as HTMLElement | null
  const close = (): void => {
    scrim.remove()
    window.removeEventListener('keydown', onKey, true)
    onClose?.()
    previous?.focus?.()
  }
  const closeButton = h('button', {
    class: 'ghost',
    ariaLabel: 'Close',
    title: 'Close',
    on: { click: () => close() },
  })
  closeButton.append(icon('close', 14))

  const box = h('div', { class: 'modal', role: 'dialog', ariaLabel: title }, [
    h('div', { class: 'row spread' }, [h('span', { class: 'eyebrow', text: title }), closeButton]),
    ...body,
  ])
  const scrim = h('div', { class: 'scrim', on: { click: (ev) => ev.target === scrim && close() } }, [
    box,
  ])

  /*
   * The keyboard stays in the dialog while it is open.
   *
   * Without this, tab walks out of it into the room behind, which for somebody
   * who cannot see the screen means the dialog is still there and their focus
   * is somewhere else entirely.
   */
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      close()
      return
    }
    if (ev.key !== 'Tab') return
    const stops = [...box.querySelectorAll<HTMLElement>('button, input, [tabindex="0"], a[href]')]
    if (stops.length === 0) return
    const first = stops[0]
    const last = stops[stops.length - 1]
    const on = document.activeElement
    if (ev.shiftKey && (on === first || !box.contains(on))) {
      last.focus()
      ev.preventDefault()
    } else if (!ev.shiftKey && on === last) {
      first.focus()
      ev.preventDefault()
    }
  }

  document.body.append(scrim)
  window.addEventListener('keydown', onKey, true)
  closeButton.focus()
  return close
}

/**
 * Show the key, as a picture, for a minute.
 *
 * Behind a question first, because what goes on the screen is the thing that
 * signs everything you have ever written here.
 */
export function showLinkCode(): void {
  const ok = window.confirm(
    'Put your key on the screen as a QR code?\n\n' +
      'Anybody who photographs it becomes you: your name, your messages, your ' +
      'spaces. Only do this with your own device, and only when nobody else can ' +
      'see the screen. It clears itself after a minute.',
  )
  if (!ok) return

  let code: string
  try {
    code = payload()
  } catch (err) {
    toast(err instanceof Error ? err.message : 'The key could not be read.', 'bad', 7000)
    return
  }

  const frame = h('div', { class: 'qr-frame' })
  try {
    frame.append(qrSvg(code, { pixels: 240 }))
  } catch {
    frame.append(h('div', { class: 'small', text: 'That key will not fit in a QR code.' }))
  }
  const left = h('div', { class: 'tiny faint' })
  const text = h('div', { class: 'tiny mono', style: { overflowWrap: 'anywhere' }, text: code })
  const reveal = h('details', { class: 'adv' }, [
    h('summary', { text: 'Show it as text instead' }),
    text,
  ])

  const close = dialog(
    'Scan to become you',
    [
      frame,
      h('div', {
        class: 'tiny faint',
        text: 'On the other device: Settings, then Take over from a code.',
      }),
      reveal,
      left,
    ],
    () => window.clearInterval(timer),
  )

  let seconds = Math.round(SHOW_FOR_MS / 1000)
  const tick = (): void => {
    seconds -= 1
    left.textContent = `Clears itself in ${seconds} seconds.`
    if (seconds <= 0) close()
  }
  left.textContent = `Clears itself in ${seconds} seconds.`
  const timer = window.setInterval(tick, 1000)
}

interface Reader {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>
}

/**
 * Read one with the camera.
 *
 * The browser's own barcode reader where there is one, which is most phones and
 * every recent Chrome. Where there is not, the same string can be pasted, and
 * that path is always shown rather than hidden behind a failure.
 */
export function scanLinkCode(onDone: (linked: Linked) => void): void {
  const paste = h('input', {
    type: 'text',
    ariaLabel: 'The code, as text',
    placeholder: 'cathode1:...',
  })
  const take = (text: string): void => {
    const linked = readPayload(text)
    if (!linked) {
      toast('That is not a linking code.', 'warn')
      return
    }
    close()
    onDone(linked)
  }

  const video = h('video', { class: 'scan-video' })
  video.muted = true
  video.playsInline = true
  const note = h('div', { class: 'tiny faint', text: 'Point the camera at the other screen.' })

  let stream: MediaStream | null = null
  let stopped = false
  const close = dialog(
    'Take over from a code',
    [
      video,
      note,
      h('div', { class: 'row' }, [
        paste,
        h('button', { text: 'Use it', on: { click: () => take(paste.value) } }),
      ]),
      h('div', {
        class: 'tiny faint',
        text: 'This replaces who you are on this device with whoever is on the other one. Your spaces here stay where they are.',
      }),
    ],
    () => {
      stopped = true
      for (const track of stream?.getTracks() ?? []) track.stop()
    },
  )

  const Detector = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Reader })
    .BarcodeDetector
  if (!Detector) {
    note.textContent = 'This browser has no barcode reader, so paste the code instead.'
    video.remove()
    paste.focus()
    return
  }

  void (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      if (stopped) {
        for (const track of stream.getTracks()) track.stop()
        return
      }
      video.srcObject = stream
      await video.play()
    } catch {
      note.textContent = 'No camera here, or it was refused. Paste the code instead.'
      video.remove()
      paste.focus()
      return
    }
    const reader = new Detector({ formats: ['qr_code'] })
    const look = async (): Promise<void> => {
      if (stopped) return
      try {
        const found = await reader.detect(video)
        const hit = found.find((f) => f.rawValue.startsWith(PREFIX))
        if (hit) {
          take(hit.rawValue)
          return
        }
      } catch {
        // A frame that could not be read is a frame. Try the next one.
      }
      window.setTimeout(() => void look(), 250)
    }
    void look()
  })()
}

export { clear }
