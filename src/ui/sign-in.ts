import { serverTag } from '../backend'
import { adoptBundle, receiveServer, sayLinked, startWaiting, waitForLink, type Bundle, type Waiting } from '../net/link'
import { makePasskey, passkeys, passkeysAvailable, removePasskey, signInWithPasskey } from '../net/passkey'
import { dropVault, formatRecoveryKey, makeRecoveryKey, readRecoveryKey, records, signInWithRecoveryKey } from '../net/vault'
import { confirmDanger } from './ask'
import { copyText, h } from './dom'
import { icon } from './icons'
import { backupTaker, dialog, here, linkTaker, mayReplace, readout, restart } from './link-device'
import { card, note } from './settings-shell'
import { toast } from './toast'

interface Taker {
  el: HTMLElement
  stop(): void
}

/** Makes this device the account a bundle holds, after asking when it would replace one. */
async function become(bundle: Bundle): Promise<boolean> {
  if (!(await mayReplace(bundle.n || 'the person in this account'))) return false
  restart(adoptBundle(bundle))
  return true
}

/** One tap: the passkey sealed the account on the server, and a fingerprint or a face opens it. */
export function passkeyButton(): HTMLButtonElement {
  const button = h('button', { class: 'primary big welcome-go' }, [icon('shield', 16), 'Sign in with a passkey'])
  button.addEventListener('click', async () => {
    button.disabled = true
    try {
      await become(await signInWithPasskey())
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The passkey did not work.', 'warn', 7000)
    }
    button.disabled = false
  })
  return button
}

export function recoveryTaker(): Taker {
  const key = h('input', { type: 'text', ariaLabel: 'The recovery key', placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX' })
  key.autocomplete = 'off'
  key.spellcheck = false
  key.setAttribute('autocapitalize', 'characters')
  const server = h('input', { type: 'text', ariaLabel: 'The server for the recovery key', placeholder: 'For example, nook.example.org' })
  server.autocomplete = 'off'
  server.spellcheck = false
  server.value = serverTag(receiveServer())
  const serverField = h('label', { class: 'welcome-field hidden' }, [h('span', { class: 'eyebrow', text: 'Server' }), server])
  const other = h('button', { class: 'ghost small start', text: 'The key was made on another server' })
  const go = h('button', { class: 'primary big', text: 'Sign in' })
  const el = h('div', { class: 'stack' }, [
    h('label', { class: 'welcome-field' }, [h('span', { class: 'eyebrow', text: 'Recovery key' }), key]),
    serverField,
    other,
    go,
  ])
  let askServer = !server.value
  const shape = (): void => {
    const typed = key.value
    if (!typed.includes('@') && key.selectionStart === typed.length) {
      const bare = typed.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 20)
      const shaped = (bare.match(/.{1,5}/g) ?? []).join('-')
      if (shaped !== typed) key.value = shaped
    }
    const named = key.value.includes('@')
    serverField.classList.toggle('hidden', named || !askServer)
    other.classList.toggle('hidden', named || askServer)
    go.disabled = !readRecoveryKey(key.value, server.value)
  }
  let busy = false
  const run = async (): Promise<void> => {
    if (busy || go.disabled) return
    busy = true
    go.disabled = true
    go.textContent = 'Signing in…'
    try {
      await become(await signInWithRecoveryKey(key.value, server.value))
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That did not work.', 'bad', 7000)
      askServer = true
    }
    busy = false
    go.textContent = 'Sign in'
    shape()
  }
  other.addEventListener('click', () => {
    askServer = true
    shape()
    server.focus()
  })
  key.addEventListener('input', shape)
  server.addEventListener('input', shape)
  go.addEventListener('click', () => void run())
  for (const field of [key, server]) {
    field.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') void run()
    })
  }
  shape()
  return { el, stop: () => undefined }
}

/**
 * The easiest way for somebody with no camera: this device shows a code, and the device that is
 * signed in types it. That one has a keyboard and a screen big enough to be glad of one.
 */
export function receiveCode(): Taker & { start(): void } {
  const body = h('div', { class: 'stack' })
  const el = h('div', { class: 'stack' }, [body])
  let waiting: Waiting | null = null
  let watch: { arrived: Promise<Bundle>; stop(): void } | null = null

  const stop = (): void => {
    watch?.stop()
    watch = null
    waiting = null
  }

  const start = (): void => {
    stop()
    const mine = (waiting = startWaiting())
    const waits = (watch = waitForLink(mine))
    body.replaceChildren(
      h('p', { class: 'link-lead', text: 'On your other device, open Settings, Devices & backup, then Link a device. Type this code there.' }),
      h('div', { class: 'link-pair' }, [readout('Code', mine.code, 'link-code receive-code'), readout('Server', serverTag(mine.server), 'link-server')]),
      h('div', { class: 'tiny faint', text: 'Waiting for your other device…' }),
    )
    waits.arrived.then(
      async (bundle) => {
        if (waiting !== mine) return
        const yes = await mayReplace(bundle.n || 'you on the other device')
        // The device that typed the code hears how it went.
        if (!yes) {
          await sayLinked({ code: mine.bare, server: mine.server }, false)
          start()
          return
        }
        const name = adoptBundle(bundle)
        await sayLinked({ code: mine.bare, server: mine.server }, true)
        restart(name)
      },
      (err: unknown) => {
        if (waiting !== mine) return
        const again = h('button', { class: 'primary', text: 'Make a new code' })
        again.addEventListener('click', start)
        body.replaceChildren(h('div', { class: 'small', text: err instanceof Error ? err.message : 'That did not work.' }), again)
      },
    )
  }
  return { el, start, stop }
}

/** Every way back in, for somebody whose device is signed out. */
export function enterLinkCode(): void {
  const receive = receiveCode()
  const link = linkTaker(() => close())
  const recovery = recoveryTaker()
  const backup = backupTaker()
  const parts: HTMLElement[] = []
  if (passkeysAvailable()) parts.push(passkeyButton(), h('div', { class: 'link-or tiny faint', text: 'or' }))
  parts.push(
    h('p', { class: 'small faint', text: 'Show a code here and type it on your other device:' }),
    receive.el,
    h('div', { class: 'link-or tiny faint', text: 'or type the code your other device shows' }),
    link.el,
    h('div', { class: 'link-or tiny faint', text: 'or use a recovery key' }),
    recovery.el,
    h('div', { class: 'link-or tiny faint', text: 'or a backup file' }),
    backup.el,
  )
  const close = dialog('Sign in', parts, () => {
    link.stop()
    receive.stop()
  })
  receive.start()
}

const when = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

function showRecoveryKey(made: { key: string; server: string }, again: () => void): void {
  const shown = formatRecoveryKey(made.key.replace(/-/g, ''))
  const whole = `${shown}@${serverTag(made.server)}`
  const copy = h('button', { class: 'primary' }, [icon('copy', 15), 'Copy the key'])
  copy.addEventListener('click', async () => {
    const ok = await copyText(whole)
    toast(ok ? 'Copied. Put it in your password manager.' : 'Could not copy it.', ok ? 'good' : 'warn')
  })
  const done = h('button', { class: 'ghost', text: 'I have saved it' })
  const close = dialog('Your recovery key', [
    h('p', { class: 'small', text: 'Put this in your password manager. It is the one way back in if you lose every device.' }),
    readout('Recovery key', shown, 'link-code recovery-key'),
    readout('Server', serverTag(made.server), 'link-server'),
    h('div', { class: 'link-warn tiny' }, [
      icon('shield', 14),
      h('span', { text: 'This is shown once and Nook keeps no copy. Anybody who has it can be you.' }),
    ]),
    h('div', { class: 'row wrap' }, [copy, done]),
  ])
  done.addEventListener('click', () => {
    close()
    again()
  })
}

/** Settings, Devices & backup: make a passkey or a recovery key, and see or take back what was made. */
export function signInCard(): HTMLElement {
  const body = h('div', { class: 'stack settings-stack' })
  const paint = (): void => {
    const rows: HTMLElement[] = []
    if (passkeysAvailable()) {
      const mine = passkeys()
      for (const each of mine) {
        const gone = h('button', { class: 'ghost', text: 'Remove' })
        gone.addEventListener('click', async () => {
          if (
            !(await confirmDanger(
              'Remove this passkey?',
              'Nook stops keeping your account for it. The passkey stays in your password manager or keychain until you delete it there.',
              'Remove',
            ))
          )
            return
          try {
            await removePasskey(each)
          } catch (err) {
            toast(err instanceof Error ? err.message : 'That did not work.', 'bad')
          }
          paint()
        })
        rows.push(
          h('div', { class: 'row spread' }, [
            h('span', { class: 'small', text: `Passkey made ${when(each.at)}` }),
            gone,
          ]),
        )
      }
      const make = h('button', { class: mine.length ? 'ghost' : '' }, [icon('shield', 15), mine.length ? 'Make another passkey' : 'Make a passkey'])
      make.addEventListener('click', async () => {
        make.disabled = true
        try {
          await makePasskey()
          toast('Passkey made. On a new device, choose Sign in with a passkey.', 'good', 6000)
        } catch (err) {
          toast(err instanceof Error ? err.message : 'The passkey could not be made.', 'bad', 7000)
        }
        paint()
      })
      rows.push(make)
    }
    body.replaceChildren(
      note(
        passkeysAvailable()
          ? 'Sign in on a new device with a fingerprint or a face. No camera, no code, and your other device does not need to be open.'
          : 'This browser cannot make a passkey. A recovery key works anywhere.',
      ),
      ...rows,
    )
    const key = records('recovery')[0]
    const make = h('button', { class: key ? 'ghost' : '' }, [icon('shield', 15), key ? 'Make a new recovery key' : 'Make a recovery key'])
    make.addEventListener('click', async () => {
      make.disabled = true
      try {
        showRecoveryKey(await makeRecoveryKey(), paint)
      } catch (err) {
        toast(err instanceof Error ? err.message : 'The key could not be made.', 'bad', 7000)
      }
      make.disabled = false
    })
    const takeBack = h('button', { class: 'ghost', text: 'Remove' })
    takeBack.addEventListener('click', async () => {
      if (!key || !(await confirmDanger('Remove the recovery key?', 'It stops working. Make a new one when you want one.', 'Remove'))) return
      await dropVault(key).catch(() => undefined)
      paint()
    })
    body.append(
      note(
        key
          ? `A recovery key is in use, made ${when(key.at)}. It works from any browser, with ${here()} open.`
          : 'A recovery key is a code to keep in your password manager. It is the way back in if you lose every device.',
      ),
      h('div', { class: 'row wrap' }, key ? [make, takeBack] : [make]),
    )
  }
  paint()
  return card('Sign in without another device', body)
}
