/**
 * The first thing somebody new sees: what to call them, and a picture.
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
import { icon } from './icons'
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

  const page = h('main', { class: 'welcome' }, [
    h('div', { class: 'welcome-card' }, [
      h('h1', { class: 'welcome-title', text: invited ? 'You have been invited' : 'Welcome to Cathode' }),
      h('p', {
        class: 'welcome-text',
        text: 'Choose the name people will see. You can change it, and your picture, in Settings.',
      }),
      h('div', { class: 'welcome-picture' }, [face, h('div', { class: 'row' }, [pictureButton, removeButton]), picker]),
      h('label', { class: 'welcome-field' }, [h('span', { class: 'eyebrow', text: 'Your name' }), name]),
      go,
    ]),
  ])
  paint()
  mount.replaceChildren(page)
  name.focus()

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
