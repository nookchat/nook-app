import { serverTag } from '../backend'
import { DiscordError, discordTemplateCode, fetchDiscordTemplate, setupFromTemplate, type DiscordSetup } from '../space/discord'
import type { SpaceMaking } from '../space/runtime'
import { SCRATCH, TEMPLATES, type SpaceTemplate } from '../space/templates'
import { MAX_SPACE_PICTURE } from '../store/log'
import { squareThumb } from './avatar'
import { h } from './dom'
import { icon, type IconName } from './icons'
import { spaceFace } from './space-switcher'
import { toast } from './toast'

/**
 * Making a space, in steps as making an account is: a starting point, then its name, picture and
 * password. A starting point is one of Nook's templates, nothing at all, or a Discord server.
 */

export interface NewSpace {
  name: string
  password: string
  server: string
  made: SpaceMaking
}

const ICONS: Record<string, IconName> = {
  scratch: 'plus',
  friends: 'people',
  gaming: 'game',
  study: 'file',
  community: 'star',
  team: 'monitor',
  creators: 'video',
  family: 'home',
}

const MAX_NAME = 32

/** What a starting point makes, as the channel list shows it. */
interface Plan {
  text: string[]
  voice: string[]
  notes: string[]
}

function planOf(template: SpaceTemplate): Plan {
  return {
    text: template.text.map((c) => c.name),
    voice: template.voice.map((c) => c.name),
    notes: template.notes.map((n) => n.title),
  }
}

function planOfDiscord(setup: DiscordSetup): Plan {
  return { text: setup.text.map((c) => c.name), voice: setup.voice.map((c) => c.name), notes: [] }
}

function preview(plan: Plan): HTMLElement {
  const chip = (glyph: IconName, name: string): HTMLElement =>
    h('span', { class: 'plan-chip' }, [icon(glyph, 14), h('span', { class: 'truncate', text: name })])
  return h('div', { class: 'plan' }, [
    ...plan.text.map((name) => chip('hash', name)),
    ...plan.voice.map((name) => chip('volume', name)),
    ...plan.notes.map((name) => chip('file', name)),
  ])
}

/** `discordLink`, when given, starts at the copy of that Discord server. */
export function newSpaceFlow(servers: string[], server: string, discordLink = ''): Promise<NewSpace | null> {
  let template: SpaceTemplate = SCRATCH
  let discord: DiscordSetup | null = null
  let picture = ''
  /** The name a Discord server gave, so a template picked after it does not keep it. */
  let named = ''

  const option = (glyph: IconName, title: string, about: string): HTMLButtonElement =>
    h('button', { class: 'welcome-option' }, [
      h('span', { class: 'welcome-option-icon' }, [icon(glyph, 20)]),
      h('span', { class: 'welcome-option-words' }, [
        h('span', { class: 'welcome-option-title', text: title }),
        h('span', { class: 'welcome-option-about', text: about }),
      ]),
    ])

  // The starting point.
  const choices = TEMPLATES.map((each) => {
    const button = option(ICONS[each.id] ?? 'hash', each.title, each.about)
    button.addEventListener('click', () => {
      template = each
      discord = null
      if (named && name.value === named) name.value = ''
      named = ''
      showNaming()
    })
    return button
  })
  const fromDiscord = option('link', 'Copy a Discord server', 'Its channels, roles and who can see what. No messages and no people.')
  const pick = h('div', { class: 'welcome-step' }, [
    h('h1', { class: 'welcome-title', text: 'Make a space' }),
    h('p', { class: 'welcome-text', text: 'Pick a starting point. You can change every channel later.' }),
    h('div', { class: 'template-grid' }, choices),
    h('div', { class: 'template-or eyebrow', text: 'Or' }),
    fromDiscord,
  ])

  // A Discord server, from its template link.
  const link = h('input', { type: 'text', placeholder: 'https://discord.new/…', ariaLabel: 'Discord template link' })
  const linkProblem = h('div', { class: 'tiny field-problem hidden', role: 'alert' })
  const copy = h('button', { class: 'primary accent big welcome-go', text: 'Copy' })
  const copying = h('div', { class: 'welcome-step hidden' }, [
    h('h1', { class: 'welcome-title', text: 'Copy a Discord server' }),
    h('ol', { class: 'welcome-steps' }, [
      h('li', { text: 'In Discord, open Server Settings, then Server Template.' }),
      h('li', { text: 'Generate a template, then copy its link.' }),
      h('li', { text: 'Paste the link here.' }),
    ]),
    h('label', { class: 'welcome-field' }, [h('span', { class: 'eyebrow', text: 'Template link' }), link]),
    linkProblem,
    copy,
  ])
  const sayLink = (words: string): void => {
    linkProblem.textContent = words
    linkProblem.classList.toggle('hidden', !words)
    link.classList.toggle('invalid', !!words)
  }
  const readDiscord = async (): Promise<void> => {
    const code = discordTemplateCode(link.value)
    if (!code) {
      sayLink(link.value.trim() ? 'That is not a Discord template link.' : 'Paste the template link.')
      link.focus()
      return
    }
    if (copy.disabled) return
    copy.disabled = true
    copy.textContent = 'Reading the template...'
    try {
      discord = setupFromTemplate(await fetchDiscordTemplate(code))
      name.value = named = discord.name.slice(0, MAX_NAME)
      showNaming()
    } catch (err) {
      sayLink(err instanceof DiscordError ? err.message : 'That Discord template could not be read.')
    } finally {
      copy.disabled = false
      copy.textContent = 'Copy'
    }
  }
  copy.addEventListener('click', () => void readDiscord())
  link.addEventListener('input', () => sayLink(''))
  link.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') void readDiscord()
  })

  // Its name, picture and password.
  const name = h('input', { type: 'text', ariaLabel: 'Space name' })
  name.maxLength = MAX_NAME
  const face = h('button', { class: 'welcome-face space-flow-face', title: 'Add a picture', ariaLabel: 'Add a picture' })
  const picker = h('input', { type: 'file', class: 'hidden', ariaLabel: 'Choose a picture' })
  picker.accept = 'image/*'
  const pictureButton = h('button', { class: 'ghost small' })
  const removeButton = h('button', { class: 'ghost small hidden', text: 'Remove' })
  const password = h('input', { type: 'password', placeholder: 'Password', ariaLabel: 'Space password' })
  password.autocomplete = 'new-password'
  const passwordField = h('label', { class: 'welcome-field hidden' }, [
    h('span', { class: 'eyebrow', text: 'Password' }),
    password,
    h('span', { class: 'tiny faint', text: 'People need it as well as the invite link. Nobody can get it back for you.' }),
  ])
  const addPassword = h('button', { class: 'ghost small space-flow-lock' }, [icon('lock', 14), 'Add a password'])
  const where = h('select', { ariaLabel: 'Server' })
  for (const each of servers) where.append(h('option', { value: each, text: serverTag(each) }))
  where.value = server
  const plan = h('div', { class: 'stack tight' })
  const planTitle = h('span', { class: 'eyebrow' })
  const make = h('button', { class: 'primary accent big welcome-go', text: 'Make the space' })
  const naming = h('div', { class: 'welcome-step hidden' }, [
    h('h1', { class: 'welcome-title', text: 'Name your space' }),
    h('p', { class: 'welcome-text', text: 'Give it a name and a picture. You can change both in its settings.' }),
    h('div', { class: 'welcome-picture' }, [face, h('div', { class: 'row' }, [removeButton, pictureButton]), picker]),
    h('label', { class: 'welcome-field' }, [h('span', { class: 'eyebrow', text: 'Space name' }), name]),
    servers.length > 1 ? h('label', { class: 'welcome-field' }, [h('span', { class: 'eyebrow', text: 'Server' }), where]) : null,
    passwordField,
    addPassword,
    h('div', { class: 'stack tight space-flow-plan' }, [planTitle, plan]),
    make,
  ])

  const paint = (): void => {
    face.replaceChildren(spaceFace('new', name.value.trim() || '+', 72, picture), h('span', { class: 'welcome-face-edit' }, [icon('edit', 14)]))
    pictureButton.textContent = picture ? 'Change picture' : 'Add a picture'
    removeButton.classList.toggle('hidden', !picture)
    make.disabled = !name.value.trim()
  }
  name.addEventListener('input', paint)
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
      picture = await squareThumb(chosen, 96, MAX_SPACE_PICTURE)
      paint()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That picture would not do.', 'warn')
    }
  })
  addPassword.addEventListener('click', () => {
    passwordField.classList.remove('hidden')
    addPassword.classList.add('hidden')
    password.focus()
  })

  const steps = [pick, copying, naming]
  const card = h('div', { class: 'welcome-card' })
  const show = (step: HTMLElement): void => {
    for (const each of steps) each.classList.toggle('hidden', each !== step)
    // The templates sit two by two, so their step is wider.
    card.classList.toggle('wide', step === pick)
    const field = step.querySelector<HTMLInputElement>('input:not([type="file"]):not([type="password"])')
    ;(field ?? step.querySelector<HTMLElement>('button'))?.focus()
  }
  const showNaming = (): void => {
    name.placeholder = `For example, ${discord?.name || template.example}`
    planTitle.textContent = discord ? `From ${discord.name}` : template.title
    plan.replaceChildren(preview(discord ? planOfDiscord(discord) : planOf(template)))
    paint()
    show(naming)
  }
  fromDiscord.addEventListener('click', () => show(copying))

  const backTo = (step: HTMLElement): HTMLButtonElement =>
    h('button', { class: 'ghost welcome-link', text: 'Back', on: { click: () => show(step) } })
  copying.append(backTo(pick))
  // Back from the name goes to where the starting point was chosen.
  naming.append(h('button', { class: 'ghost welcome-link', text: 'Back', on: { click: () => show(discord ? copying : pick) } }))

  const close = h('button', { class: 'ghost icon-only space-flow-close', ariaLabel: 'Close', title: 'Close' }, [icon('close', 18)])
  card.append(close, ...steps)
  const page = h('div', { class: 'welcome space-flow', role: 'dialog', ariaLabel: 'Make a space' }, [card])
  document.body.append(page)
  if (discordLink) {
    link.value = discordLink
    show(copying)
    void readDiscord()
  } else {
    show(pick)
  }

  return new Promise((done) => {
    const end = (made: NewSpace | null): void => {
      page.remove()
      document.removeEventListener('keydown', onKey)
      done(made)
    }
    const finish = (): void => {
      const chosen = name.value.trim().slice(0, MAX_NAME)
      if (!chosen) {
        name.focus()
        return
      }
      end({
        name: chosen,
        password: passwordField.classList.contains('hidden') ? '' : password.value,
        server: where.value || server,
        made: { ...(discord ? { discord } : template === SCRATCH ? {} : { template }), ...(picture ? { picture } : {}) },
      })
    }
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') end(null)
    }
    document.addEventListener('keydown', onKey)
    close.addEventListener('click', () => end(null))
    make.addEventListener('click', finish)
    for (const box of [name, password]) {
      box.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') finish()
      })
    }
  })
}
