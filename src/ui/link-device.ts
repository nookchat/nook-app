/**
 * Linking a device, as the screen shows it.
 *
 * On the device you use: Settings, Link a device. It shows a QR code for a
 * phone's camera, a link to send yourself, and a code and its server to type,
 * and they all do the same thing for ten minutes, once.
 *
 * On the new one: point its camera at the QR code, open the link, or choose
 * "I have an account", then "Use my other device", and type the code. It
 * becomes you, with your spaces, your messages and your name. See
 * net/link.ts for what travels and how it is sealed.
 *
 * A backup is the same account in a file, for when there is no other device.
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

/** Where this page is, the way a person types it into another device. */
const here = (): string => window.location.host

/** A labelled box to read from, beside the field of the same name on the other device. */
function readout(label: string, value: string, extra: string): HTMLElement {
  return h('div', { class: 'link-readout' }, [
    h('span', { class: 'eyebrow', text: label }),
    h('div', { class: `share-code ${extra}`, text: value }),
  ])
}

/** On the device you use: make a link, and show it three ways. */
export function showLinkCode(): void {
  const body = h('div', { class: 'link-offer' }, [h('div', { class: 'tiny faint', text: 'Making a link…' })])
  const left = h('div', { class: 'tiny faint' })
  let timer = 0
  const close = dialog('Link a device', [body, left], () => window.clearInterval(timer))

  void offerLink().then(
    (offer) => {
      const frame = h('div', { class: 'qr-frame' })
      try {
        frame.append(qrSvg(offer.link, { pixels: 200 }))
      } catch {
        frame.append(h('div', { class: 'small', text: 'That link will not fit in a QR code.' }))
      }
      const copy = h('button', { class: 'ghost' }, [icon('link', 15), 'Copy link'])
      copy.addEventListener('click', async () => {
        const ok = await copyText(offer.link)
        toast(ok ? 'Link copied. Open it on the other device.' : 'Could not copy it.', ok ? 'info' : 'warn')
      })
      const code = readout('Code', offer.code, 'link-code')
      code.lastElementChild?.setAttribute('data-link', offer.link)
      code.lastElementChild?.setAttribute('data-server', offer.server)
      body.replaceChildren(
        h('p', { class: 'link-lead', text: 'Point the camera of the new device at this code.' }),
        frame,
        h('div', { class: 'link-or tiny faint', text: `or open ${here()} on it, choose “I have an account”, and type these` }),
        h('div', { class: 'link-pair' }, [code, readout('Server', serverTag(offer.server), 'link-server')]),
        copy,
        h('div', { class: 'link-warn tiny' }, [
          icon('shield', 14),
          h('span', { text: 'Only use this on your own device. Whoever uses it becomes you.' }),
        ]),
      )
      const tick = (): void => {
        const seconds = Math.max(0, Math.round((offer.until - Date.now()) / 1000))
        left.textContent = `It works once, for ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} more.`
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

/*
 * When this device last saved a backup. It is this device's own note, for
 * Settings to say, and nothing depends on it.
 */
const SAVED_KEY = 'cathode.backup.v1'

/** The day this device last saved a backup, or null when it never has. */
export function lastBackup(): Date | null {
  try {
    const at = new Date(localStorage.getItem(SAVED_KEY) ?? '')
    return Number.isNaN(at.getTime()) ? null : at
  } catch {
    return null
  }
}

/** Save the account as a file, for the day this browser forgets it. A password is up to you. */
export function showBackup(onSaved?: () => void): void {
  const password = h('input', { type: 'password', ariaLabel: 'Password for the backup', placeholder: 'A password for the file' })
  password.autocomplete = 'new-password'
  const passwordRow = h('div', { class: 'stack tight hidden' }, [
    password,
    h('div', { class: 'tiny faint', text: 'You need it to open the backup. Nobody can get it back if you forget it.' }),
  ])
  const addPassword = h('button', { class: 'ghost small start' }, [icon('plus', 14), 'Add a password (you can skip this)'])
  addPassword.addEventListener('click', () => {
    addPassword.remove()
    passwordRow.classList.remove('hidden')
    password.focus()
  })
  const save = h('button', { class: 'primary big' }, [icon('download', 16), 'Save backup file'])
  const close = dialog('Save a backup', [
    h('div', { class: 'backup-words' }, [
      h('p', { text: 'This puts your account in one small file.' }),
      h('p', {
        class: 'small faint',
        text: `If this browser ever forgets you, open ${here()}, choose “I have an account”, then “Use a backup file”. Your spaces and messages come back.`,
      }),
      h('div', { class: 'link-warn tiny' }, [
        icon('shield', 14),
        h('span', { text: 'Keep the file private. Anybody with it can be you.' }),
      ]),
    ]),
    addPassword,
    passwordRow,
    save,
  ])
  const run = async (): Promise<void> => {
    save.disabled = true
    try {
      const { name, blob } = await backupFile(password.value)
      saveFile(blob, name)
      try {
        localStorage.setItem(SAVED_KEY, new Date().toISOString())
      } catch {
        // A browser that will not keep the note still has the file.
      }
      toast(password.value ? 'Backup saved, with its password.' : 'Backup saved. Keep it somewhere private.', 'good', 5000)
      onSaved?.()
      close()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The backup could not be made.', 'bad', 7000)
      save.disabled = false
    }
  }
  save.addEventListener('click', () => void run())
  password.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') void run()
  })
}

/** A part of a screen that takes you from somewhere, and lets go of the camera when it is put away. */
export interface Taker {
  el: HTMLElement
  stop(): void
}

/** Ask before a device that is somebody already becomes somebody else. */
function mayReplace(who: string): boolean {
  return !nameChosen() || window.confirm(`This device stops being ${loadIdentity().name} and becomes ${who}. Go on?`)
}

/**
 * A backup file, chosen or dropped, and its password when it has one.
 *
 * `take` is for a file dropped somewhere else on the screen, so the whole
 * first screen can be a place to drop it.
 */
export function backupTaker(): Taker & { take(file: File): void } {
  const picker = h('input', { type: 'file', class: 'hidden', ariaLabel: 'Backup file' })
  picker.accept = 'application/json,.json'
  const drop = h('button', { class: 'backup-drop' }, [
    icon('file', 22),
    h('span', { class: 'backup-drop-title', text: 'Choose your backup file' }),
    h('span', { class: 'tiny faint', text: 'or drop it here. Its name starts with “nook-”.' }),
  ])
  const password = h('input', { type: 'password', ariaLabel: 'The backup’s password', placeholder: 'The password you gave it' })
  password.autocomplete = 'current-password'
  const go = h('button', { class: 'primary big', text: 'Restore' })
  const locked = h('div', { class: 'stack tight hidden' }, [
    h('div', { class: 'small', text: '' }),
    h('label', { class: 'welcome-field' }, [h('span', { class: 'eyebrow', text: 'Password' }), password]),
    go,
  ])
  const el = h('div', { class: 'stack' }, [drop, picker, locked])

  let text = ''
  const restore = async (): Promise<void> => {
    const seen = readBackup(text)
    if (!seen || !mayReplace(seen.name || 'the person in the backup')) return
    go.disabled = true
    try {
      restart(await restoreBackup(text, password.value))
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That backup would not open.', 'bad', 7000)
      go.disabled = false
      password.select()
    }
  }
  const take = (file: File): void => {
    void file.text().then((read) => {
      const seen = readBackup(read)
      if (!seen) {
        toast('That file is not a Nook backup. Its name starts with “nook-”.', 'warn', 6000)
        return
      }
      text = read
      if (!seen.locked) {
        void restore()
        return
      }
      locked.firstElementChild!.textContent = `${seen.name ? `The backup of ${seen.name}` : 'This backup'} has a password.`
      locked.classList.remove('hidden')
      password.focus()
    })
  }

  drop.addEventListener('click', () => picker.click())
  picker.addEventListener('change', () => {
    const file = picker.files?.[0]
    picker.value = ''
    if (file) take(file)
  })
  drop.addEventListener('dragover', (ev) => {
    ev.preventDefault()
    drop.classList.add('over')
  })
  drop.addEventListener('dragleave', () => drop.classList.remove('over'))
  drop.addEventListener('drop', (ev) => {
    ev.preventDefault()
    ev.stopPropagation()
    drop.classList.remove('over')
    const file = ev.dataTransfer?.files[0]
    if (file) take(file)
  })
  go.addEventListener('click', () => void restore())
  password.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') void restore()
  })
  return { el, take, stop: () => undefined }
}

interface Reader {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>
}

/**
 * A link from the other device: read by the camera, pasted, or its code and
 * server typed in. A pasted link goes at once, because it has both.
 */
export function linkTaker(done?: () => void): Taker {
  const code = h('input', { type: 'text', ariaLabel: 'The link or code', placeholder: 'XXXX-XXXX-XXXX' })
  code.autocomplete = 'off'
  code.spellcheck = false
  code.setAttribute('autocapitalize', 'characters')
  const server = h('input', { type: 'text', ariaLabel: 'The server', placeholder: 'For example, nook.example.org' })
  server.autocomplete = 'off'
  server.spellcheck = false
  server.setAttribute('autocapitalize', 'off')
  server.value = serverTag(newSpaceServer())
  const serverField = h('label', { class: 'welcome-field' }, [h('span', { class: 'eyebrow', text: 'Server' }), server])
  const go = h('button', { class: 'primary big', text: 'Link this device' })
  const scan = h('button', { class: 'big' }, [icon('qr', 16), 'Scan the QR code'])
  const video = h('video', { class: 'scan-video hidden' })
  video.muted = true
  video.playsInline = true
  const el = h('div', { class: 'stack' }, [
    scan,
    video,
    h('label', { class: 'welcome-field' }, [h('span', { class: 'eyebrow', text: 'Code' }), code]),
    serverField,
    go,
  ])

  const isLink = (text: string): boolean => text.includes('link=')

  // A code is shaped as it is typed; a link, or `code@server`, is left as it is.
  const paint = (): void => {
    const typed = code.value
    if (!/[#/=@.:]/.test(typed) && code.selectionStart === typed.length) {
      const bare = typed.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 12)
      const shaped = (bare.match(/.{1,4}/g) ?? []).join('-')
      if (shaped !== typed) code.value = shaped
    }
    serverField.classList.toggle('hidden', isLink(code.value) || code.value.includes('@'))
    go.disabled = !readOffer(code.value, server.value)
  }

  let busy = false
  const take = async (text: string): Promise<void> => {
    const offer = readOffer(text, server.value)
    if (busy) return
    if (!offer) {
      toast(server.value.trim() ? 'That is not a code. A code is three groups of four.' : 'Type the server too. It is under the code.', 'warn')
      return
    }
    if (!mayReplace('you on the other device')) return
    busy = true
    go.disabled = true
    go.textContent = 'Linking…'
    try {
      const name = await takeOffer(offer)
      stop()
      done?.()
      restart(name)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That did not work.', 'bad', 7000)
      busy = false
      go.disabled = false
      go.textContent = 'Link this device'
    }
  }
  code.addEventListener('input', () => {
    paint()
    if (isLink(code.value)) void take(code.value)
  })
  server.addEventListener('input', paint)
  go.addEventListener('click', () => void take(code.value))
  for (const field of [code, server]) {
    field.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') void take(code.value)
    })
  }
  paint()

  let stream: MediaStream | null = null
  let stopped = false
  // Put away: the camera is let go, and the scan button is there for the next time.
  const stop = (): void => {
    stopped = true
    for (const track of stream?.getTracks() ?? []) track.stop()
    stream = null
    video.classList.add('hidden')
    scan.classList.remove('hidden')
  }

  const Detector = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Reader }).BarcodeDetector
  if (!Detector) {
    scan.remove()
    return { el, stop }
  }
  scan.addEventListener('click', async () => {
    scan.classList.add('hidden')
    stopped = false
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      if (stopped) {
        stop()
        return
      }
      video.classList.remove('hidden')
      video.srcObject = stream
      await video.play()
    } catch {
      scan.classList.remove('hidden')
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
  return { el, stop }
}

/**
 * On a device that is somebody already, from Settings: become who you are on
 * another device, by its code or a backup.
 */
export function enterLinkCode(): void {
  const backup = backupTaker()
  const link = linkTaker(() => close())
  const close = dialog(
    'Enter a code',
    [
      h('p', { class: 'small faint', text: 'On the other device: Settings, Link a device.' }),
      link.el,
      h('div', { class: 'link-or tiny faint', text: 'or' }),
      backup.el,
    ],
    () => link.stop(),
  )
  link.el.querySelector<HTMLInputElement>('input[aria-label="The link or code"]')?.focus()
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
    const on = h('button', { class: 'primary big welcome-go', text: 'Skip' })
    card.append(on)
    await new Promise<void>((done) => on.addEventListener('click', () => done()))
    return false
  }
}

export { clear }
