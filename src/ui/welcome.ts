/**
 * The first thing an empty browser shows: somebody new says what to call
 * them, and somebody coming back brings their account from another device or
 * a backup file.
 *
 * It comes before anything else starts, so no space ever hears a name this
 * device made up and then another a moment later, and it is the same screen
 * whether they arrived on the home page or on an invite. Once, per device: a
 * name chosen here, in Settings, or brought from another device by linking
 * it, is a name chosen.
 *
 * The picture is not needed. The name is, because a person in a room is who
 * the room says they are, and that should be their word, not a joke picked for
 * them.
 */

import { cleanName, sillyName } from '../chat'
import { loadIdentity, saveDisplayName } from '../store/identity'
import { loadAvatar, saveAvatar, squareThumb } from './avatar'
import { avatarOf } from './chat-panel'
import { h } from './dom'
import { icon, type IconName } from './icons'
import { backupTaker, linkTaker } from './link-device'
import { toast } from './toast'

export function welcome(mount: HTMLElement, invited: boolean): Promise<void> {
  const me = loadIdentity().pubkey
  let picture = loadAvatar()

  const face = h('button', {
    class: 'welcome-face',
    title: 'Add a picture',
    ariaLabel: 'Add a picture',
  })
  const picker = h('input', { type: 'file', class: 'hidden', ariaLabel: 'Choose a picture' })
  picker.accept = 'image/*'
  const pictureButton = h('button', { class: 'ghost small' })
  const removeButton = h('button', { class: 'ghost small hidden', text: 'Remove' })
  const name = h('input', {
    type: 'text',
    placeholder: `For example, ${sillyName()}`,
    ariaLabel: 'Your name',
  })
  name.maxLength = 24
  name.setAttribute('autocomplete', 'nickname')
  const go = h('button', { class: 'primary big welcome-go', text: invited ? 'Join' : 'Continue' })

  const paint = (): void => {
    const typed = cleanName(name.value)
    face.replaceChildren(avatarOf(me, typed, picture, 72), h('span', { class: 'welcome-face-edit' }, [icon('edit', 14)]))
    pictureButton.textContent = picture ? 'Change picture' : 'Add a picture'
    removeButton.classList.toggle('hidden', !picture)
    go.disabled = !typed
  }

  face.addEventListener('click', () => picker.click())
  pictureButton.addEventListener('click', () => picker.click())
  removeButton.addEventListener('click', () => {
    picture = ''
    paint()
  })
  picker.addEventListener('change', async () => {
    const chosen = picker.files?.[0]
    picker.value = ''
    if (!chosen) return
    try {
      picture = await squareThumb(chosen)
      paint()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That picture would not do.', 'warn')
    }
  })
  name.addEventListener('input', paint)

  /*
   * First, which of the two you are. Somebody who already uses Nook is
   * never asked for a name: they are somebody already, and linking this
   * device or restoring a backup brings that name with them.
   */
  const fresh = h('button', { class: 'primary big welcome-go', text: 'I’m new' })
  const known = h('button', { class: 'big welcome-go', text: 'I have an account' })
  const choose = h('div', { class: 'welcome-step' }, [
    h('h1', { class: 'welcome-title', text: invited ? 'You have been invited' : 'Welcome to Nook' }),
    h('p', {
      class: 'welcome-text',
      text: invited ? 'Somebody sent you an invite to a space.' : 'Chat, voice and screen sharing with your friends.',
    }),
    fresh,
    known,
  ])
  const back = (): HTMLButtonElement => h('button', { class: 'ghost welcome-link', text: 'Back' })
  const naming = h('div', { class: 'welcome-step hidden' }, [
    h('h1', { class: 'welcome-title', text: 'What should people call you?' }),
    h('p', { class: 'welcome-text', text: 'You can change it, and your picture, in Settings.' }),
    h('div', { class: 'welcome-picture' }, [face, h('div', { class: 'row' }, [pictureButton, removeButton]), picker]),
    h('label', { class: 'welcome-field' }, [h('span', { class: 'eyebrow', text: 'Your name' }), name]),
    go,
  ])

  // Somebody who has an account: from the device they already use, or from the file they saved.
  const option = (glyph: IconName, title: string, about: string): HTMLButtonElement =>
    h('button', { class: 'welcome-option' }, [
      h('span', { class: 'welcome-option-icon' }, [icon(glyph, 20)]),
      h('span', { class: 'welcome-option-words' }, [
        h('span', { class: 'welcome-option-title', text: title }),
        h('span', { class: 'welcome-option-about', text: about }),
      ]),
    ])
  const fromDevice = option('device', 'Use my other device', 'A phone or computer where you use Nook now')
  const fromFile = option('file', 'Use a backup file', 'The file you saved from Settings')
  const account = h('div', { class: 'welcome-step hidden' }, [
    h('h1', { class: 'welcome-title', text: 'Welcome back' }),
    h('p', { class: 'welcome-text', text: 'Your spaces and messages come back with you. How do you want to get in?' }),
    fromDevice,
    fromFile,
  ])

  const link = linkTaker()
  const device = h('div', { class: 'welcome-step hidden' }, [
    h('h1', { class: 'welcome-title', text: 'Use my other device' }),
    h('ol', { class: 'welcome-steps' }, [
      h('li', { text: 'On your other device, open Nook.' }),
      h('li', { text: 'Go to Settings, then Link a device.' }),
      h('li', { text: 'Scan the QR code it shows, or type its code and server here.' }),
    ]),
    link.el,
  ])

  const backup = backupTaker()
  const file = h('div', { class: 'welcome-step hidden' }, [
    h('h1', { class: 'welcome-title', text: 'Use a backup file' }),
    h('p', { class: 'welcome-text', text: 'You saved it from Settings, Save a backup. It could be in your downloads, or in a password manager.' }),
    backup.el,
  ])

  /*
   * One step on the card at a time. Back goes to the step before, and a step
   * put away lets go of the camera.
   */
  const steps = [choose, naming, account, device, file]
  const before = new Map<HTMLElement, HTMLElement>([
    [naming, choose],
    [account, choose],
    [device, account],
    [file, account],
  ])
  const show = (step: HTMLElement): void => {
    for (const each of steps) each.classList.toggle('hidden', each !== step)
    link.stop()
    const shown = (el: HTMLElement): boolean => el.offsetParent !== null
    const field = [...step.querySelectorAll<HTMLElement>('input:not([type="file"])')].find(shown)
    ;(field ?? [...step.querySelectorAll<HTMLElement>('button')].find(shown))?.focus()
  }
  for (const [step, previous] of before) {
    const button = back()
    button.addEventListener('click', () => show(previous))
    step.append(button)
  }
  fresh.addEventListener('click', () => show(naming))
  known.addEventListener('click', () => show(account))
  fromDevice.addEventListener('click', () => show(device))
  fromFile.addEventListener('click', () => show(file))

  const page = h('main', { class: 'welcome' }, [h('div', { class: 'welcome-card' }, steps)])

  // A backup dropped anywhere on the first screen is somebody coming back.
  page.addEventListener('dragover', (ev) => ev.preventDefault())
  page.addEventListener('drop', (ev) => {
    ev.preventDefault()
    const dropped = ev.dataTransfer?.files[0]
    if (!dropped) return
    show(file)
    backup.take(dropped)
  })
  paint()
  mount.replaceChildren(page)
  fresh.focus()

  return new Promise((done) => {
    const finish = (): void => {
      const chosen = cleanName(name.value)
      if (!chosen) {
        name.focus()
        return
      }
      saveDisplayName(chosen)
      saveAvatar(picture)
      page.remove()
      done()
    }
    go.addEventListener('click', finish)
    name.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') finish()
    })
  })
}
