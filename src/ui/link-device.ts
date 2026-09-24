/**
 * Linking a device, as the screen shows it.
 *
 * On the device you use: Settings, Link another device. It shows a QR code
 * for a phone's camera, a link to send yourself, and a code to type, and they
 * all do the same thing for ten minutes, once.
 *
 * On the new one: open the link, or scan the code with the camera, or type
 * it where the first screen offers "I already use Cathode". It becomes you,
 * with your spaces, your messages and your name. See net/link.ts for what
 * travels and how it is sealed.
 */

import { h, clear, copyText } from './dom'
import { icon } from './icons'
import { qrSvg } from './qr'
import { toast } from './toast'
import { serverTag } from '../backend'
import { backupFile, linkInAddress, offerLink, readBackup, readOffer, restoreBackup, takeOffer } from '../net/link'
import { saveFile } from '../net/files'
import { loadIdentity, nameChosen } from '../store/identity'
import { newSpaceServer } from '../store/server-spaces'

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

/** Start again as whoever this device just became, on a clean address. */
function restart(name: string): void {
  toast(name ? `Linked. Starting again as ${name}.` : 'Linked. Starting again.', 'good', 3000)
  window.setTimeout(() => window.location.replace(`${window.location.origin}${window.location.pathname}`), 900)
}

/** On the device you use: make a link, and show it three ways. */
export function showLinkCode(): void {
  const body = h('div', { class: 'link-offer' }, [h('div', { class: 'tiny faint', text: 'Making a link…' })])
  const left = h('div', { class: 'tiny faint' })
  let timer = 0
  const close = dialog('Link another device', [body, left], () => window.clearInterval(timer))

  void offerLink().then(
    (offer) => {
      const frame = h('div', { class: 'qr-frame' })
      try {
        frame.append(qrSvg(offer.link, { pixels: 220 }))
      } catch {
        frame.append(h('div', { class: 'small', text: 'That link will not fit in a QR code.' }))
      }
      const copy = h('button', { class: 'primary' }, [icon('link', 15), 'Copy link'])
      copy.addEventListener('click', async () => {
        const ok = await copyText(offer.link)
        toast(ok ? 'Link copied. Open it on the other device.' : 'Could not copy it.', ok ? 'info' : 'warn')
      })
      body.replaceChildren(
        h('div', { class: 'tiny faint', text: 'Scan this with the other device’s camera, or open the link there.' }),
        frame,
        copy,
        h('div', { class: 'link-or tiny faint', text: 'or type this code on it' }),
        h('div', { class: 'share-code link-code', text: offer.code, data: { link: offer.link, server: offer.server } }),
        h('div', {
          class: 'tiny faint',
          text: `It waits on ${serverTag(offer.server)} and works once. Whoever uses it becomes you, so only use it on your own device.`,
        }),
      )
      const tick = (): void => {
        const seconds = Math.max(0, Math.round((offer.until - Date.now()) / 1000))
        left.textContent = `Works for ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} more.`
        if (seconds <= 0) close()
      }
      tick()
      timer = window.setInterval(tick, 1000)
    },
    (err: unknown) => {
      body.replaceChildren(h('div', { class: 'small', text: err instanceof Error ? err.message : 'The link could not be made.' }))
    },
  )
}

/** Save the account as a file, for the day this browser forgets it. A password is up to you. */
export function showBackup(): void {
  const password = h('input', { type: 'password', ariaLabel: 'Password for the backup', placeholder: 'A password (you can leave this empty)' })
  password.autocomplete = 'new-password'
  const save = h('button', { class: 'primary' }, [icon('download', 15), 'Download backup'])
  const close = dialog('Back up your account', [
    h('div', { class: 'backup-words' }, [
      h('p', { class: 'small', text: 'This saves your account as one small file. If this browser’s data is ever cleared, open Cathode, choose “I already use Cathode”, and restore it. Your spaces and messages come back.' }),
      h('p', { class: 'tiny faint', text: 'Anybody with the file can be you, so keep it somewhere private, such as a password manager. A password makes it useless to anybody else, but it cannot be recovered if you forget it.' }),
    ]),
    password,
    save,
  ])
  save.addEventListener('click', async () => {
    save.disabled = true
    try {
      const { name, blob } = await backupFile(password.value)
      saveFile(blob, name)
      toast(password.value ? 'Backup saved, with its password.' : 'Backup saved. Keep it somewhere private.', 'good', 5000)
      close()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The backup could not be made.', 'bad', 7000)
      save.disabled = false
    }
  })
}

/** A backup file, picked and read and restored, asking for its password when it has one. */
function restoreFrom(file: File, passwordRow: HTMLElement, password: HTMLInputElement, go: HTMLButtonElement): void {
  void file.text().then((text) => {
    const seen = readBackup(text)
    if (!seen) {
      toast('That file is not a Cathode backup.', 'warn')
      return
    }
    const restore = async (): Promise<void> => {
      if (nameChosen() && !window.confirm(`This device stops being ${loadIdentity().name} and becomes ${seen.name || 'the person in the backup'}. Go on?`)) return
      try {
        restart(await restoreBackup(text, password.value))
      } catch (err) {
        toast(err instanceof Error ? err.message : 'That backup would not open.', 'bad', 7000)
      }
    }
    if (!seen.locked) {
      void restore()
      return
    }
    passwordRow.classList.remove('hidden')
    password.focus()
    go.textContent = 'Restore'
    go.onclick = () => void restore()
  })
}

interface Reader {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>
}

/**
 * On the new device: take a link, pasted or typed or read by the camera.
 *
 * A device that is already somebody (a name chosen, spaces joined) is asked
 * first, because it stops being them: the other device's person replaces them
 * here, and their spaces are no longer on this device's list.
 */
export function enterLinkCode(): void {
  const code = h('input', { type: 'text', ariaLabel: 'The link or code', placeholder: 'Paste the link, or type the code' })
  const server = h('input', { type: 'text', ariaLabel: 'The server', placeholder: 'Its server, such as cathode.example.org' })
  server.value = serverTag(newSpaceServer())
  const serverRow = h('label', { class: 'welcome-field hidden' }, [h('span', { class: 'eyebrow', text: 'Server' }), server])
  const go = h('button', { class: 'primary', text: 'Link this device' })
  const note = h('div', { class: 'tiny faint', text: 'On the device you already use: Settings, Link another device.' })
  const video = h('video', { class: 'scan-video hidden' })
  video.muted = true
  video.playsInline = true
  const scan = h('button', { class: 'ghost' }, [icon('qr', 15), 'Scan with the camera'])
  // Or a backup, for a device that has nothing to link from.
  const picker = h('input', { type: 'file', class: 'hidden', ariaLabel: 'Backup file' })
  picker.accept = 'application/json,.json'
  const restoreButton = h('button', { class: 'ghost start' }, [icon('file', 15), 'Restore from a backup file'])
  const password = h('input', { type: 'password', ariaLabel: 'The backup’s password', placeholder: 'The backup’s password' })
  const passwordRow = h('label', { class: 'welcome-field hidden' }, [h('span', { class: 'eyebrow', text: 'Password' }), password])
  restoreButton.addEventListener('click', () => picker.click())

  // A bare code needs its server; a pasted link carries it.
  const paint = (): void => {
    const text = code.value.trim()
    serverRow.classList.toggle('hidden', !text || text.includes('link=') || text.includes('@'))
  }
  code.addEventListener('input', paint)

  let stream: MediaStream | null = null
  let stopped = false
  const close = dialog(
    'Link this device',
    [note, code, serverRow, h('div', { class: 'row wrap' }, [go, scan]), video, h('div', { class: 'link-or tiny faint', text: 'or' }), restoreButton, picker, passwordRow],
    () => {
      stopped = true
      for (const track of stream?.getTracks() ?? []) track.stop()
    },
  )
  code.focus()
  picker.addEventListener('change', () => {
    const file = picker.files?.[0]
    picker.value = ''
    if (file) restoreFrom(file, passwordRow, password, go)
  })

  const take = async (text: string): Promise<void> => {
    const offer = readOffer(text, server.value)
    if (!offer) {
      toast('That is not a link or a code. A code is three groups of four.', 'warn')
      return
    }
    if (nameChosen() && !window.confirm(`This device stops being ${loadIdentity().name} and becomes you on the other device. Go on?`)) return
    go.disabled = true
    go.textContent = 'Linking…'
    try {
      const name = await takeOffer(offer)
      close()
      restart(name)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That did not work.', 'bad', 7000)
      go.disabled = false
      go.textContent = 'Link this device'
    }
  }
  go.addEventListener('click', () => void take(code.value))
  code.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') void take(code.value)
  })

  const Detector = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Reader }).BarcodeDetector
  if (!Detector) {
    scan.remove()
    return
  }
  scan.addEventListener('click', async () => {
    scan.remove()
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      if (stopped) {
        for (const track of stream.getTracks()) track.stop()
        return
      }
      video.classList.remove('hidden')
      video.srcObject = stream
      await video.play()
    } catch {
      toast('No camera here, or it was refused. Type the code instead.', 'warn')
      return
    }
    const reader = new Detector({ formats: ['qr_code'] })
    const look = async (): Promise<void> => {
      if (stopped) return
      try {
        const hit = (await reader.detect(video)).find((f) => f.rawValue.includes('#link='))
        if (hit) {
          void take(hit.rawValue)
          return
        }
      } catch {
        // A frame that could not be read is a frame. Try the next one.
      }
      window.setTimeout(() => void look(), 250)
    }
    void look()
  })
}

/**
 * The page was opened with a link: link, and start again, before anything
 * else happens. Resolves false when there was nothing to do or it did not
 * work, and the page then carries on as it was.
 */
export async function linkFromAddress(mount: HTMLElement): Promise<boolean> {
  const offer = linkInAddress()
  if (!offer) return false
  const words = h('p', { class: 'welcome-text', text: `Fetching you from ${serverTag(offer.server)}…` })
  const card = h('div', { class: 'welcome-card' }, [h('h1', { class: 'welcome-title', text: 'Linking this device' }), words])
  mount.replaceChildren(h('main', { class: 'welcome' }, [card]))
  const clean = (): void => history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  if (nameChosen() && !window.confirm(`This device stops being ${loadIdentity().name} and becomes you on the other device. Go on?`)) {
    clean()
    return false
  }
  try {
    const name = await takeOffer(offer)
    clean()
    words.textContent = name ? `Linked. Welcome back, ${name}.` : 'Linked.'
    restart(name)
    return true
  } catch (err) {
    clean()
    words.textContent = err instanceof Error ? err.message : 'That did not work.'
    const on = h('button', { class: 'primary big welcome-go', text: 'Carry on without it' })
    card.append(on)
    await new Promise<void>((done) => on.addEventListener('click', () => done()))
    return false
  }
}

export { clear }
