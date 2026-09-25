import { MEMBER, OWNER, PERMISSIONS, type Level, type Permission } from '../store/log'
import type { RoomChat } from '../store/room-chat'
import { h } from './dom'
import { icon } from './icons'
import { toast } from './toast'

const LEVEL_COLOURS = [
  '#f25f5c',
  '#ff8c42',
  '#f0b232',
  '#3ddc84',
  '#2ec4b6',
  '#5bb5ff',
  '#7b8cff',
  '#b57bff',
  '#ff6fb5',
  '#a0a6b5',
]

interface LevelsOptions {
  chat: RoomChat
  publish(write: (chat: RoomChat) => Promise<unknown>): Promise<void>
  people(): { key: string; name: string }[]
}

function newLevelId(): string {
  return [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function levelsEditor(options: LevelsOptions): HTMLElement {
  const { chat } = options
  const root = h('div', { class: 'levels' })
  let opened = ''

  const save = async (level: Level): Promise<void> => {
    await options.publish((c) => c.setLevel(level))
    draw()
  }

  const draw = (): void => {
    const auth = chat.authority()
    const me = chat.me
    const mine = auth.levelOf(me)
    const levels = auth.list()
    const counts = new Map<string, number>()
    for (const person of options.people()) {
      if (auth.isKicked(person.key)) continue
      const id = auth.levelOf(person.key).id
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }

    const moved = (level: Level, up: boolean): Level | null => {
      const at = levels.indexOf(level)
      if (up) {
        const above = levels[at - 1]
        if (!above || above.rank >= mine.rank) return null
        const ceiling = Math.min(levels[at - 2]?.rank ?? mine.rank, mine.rank)
        return { ...level, rank: (above.rank + ceiling) / 2 }
      }
      const below = levels[at + 1]
      if (!below || below.id === MEMBER) return null
      const floor = levels[at + 2]?.rank ?? 0
      return { ...level, rank: (below.rank + floor) / 2 }
    }

    const row = (level: Level): HTMLElement => {
      const editable = auth.mayEdit(me, level)
      const count = counts.get(level.id) ?? 0
      const dot = h('span', { class: 'level-dot' })
      if (level.colour) dot.style.background = level.colour
      const title = h('span', { class: 'level-name grow truncate', text: level.name })
      if (level.colour) title.style.color = level.colour
      const facts = h('span', {
        class: 'tiny faint',
        text: level.id === OWNER ? 'Made the space' : `${count} ${count === 1 ? 'person' : 'people'}`,
      })
      const open = editable && opened === level.id
      const head = editable
        ? h(
            'button',
            {
              class: `level-head${open ? ' on' : ''}`,
              ariaLabel: `Change the level ${level.name}`,
              on: {
                click: () => {
                  opened = open ? '' : level.id
                  draw()
                },
              },
            },
            [dot, title, facts, icon(open ? 'close' : 'edit', 14)],
          )
        : h('div', { class: 'level-head fixed', title: level.id === OWNER ? 'Nobody can change the owner' : 'Only somebody above this level can change it' }, [
            dot,
            title,
            facts,
          ])
      const box = h('div', { class: `level${open ? ' open' : ''}` }, [head])
      if (open) box.append(form(level, moved(level, true), moved(level, false)))
      return box
    }

    const form = (level: Level, up: Level | null, down: Level | null): HTMLElement => {
      const name = h('input', { type: 'text', value: level.name, ariaLabel: 'The name of the level' })
      name.maxLength = 24
      let colour = level.colour
      const swatches = h('div', { class: 'level-colours', role: 'group', ariaLabel: 'Colour' })
      const paintSwatches = (): void => {
        for (const swatch of swatches.children) {
          const on = (swatch as HTMLElement).dataset.colour === colour
          swatch.classList.toggle('on', on)
          swatch.setAttribute('aria-pressed', String(on))
        }
      }
      for (const choice of ['', ...LEVEL_COLOURS]) {
        const swatch = h('button', {
          class: `level-swatch${choice ? '' : ' plain'}`,
          title: choice ? choice : 'The ordinary colour of text',
          ariaLabel: choice ? `Colour ${choice}` : 'No colour',
          data: { colour: choice },
          on: {
            click: () => {
              colour = choice
              paintSwatches()
            },
          },
        })
        if (choice) swatch.style.background = choice
        swatches.append(swatch)
      }
      paintSwatches()

      const mine = chat.levelOf(chat.me)
      const boxes = new Map<Permission, HTMLInputElement>()
      const powers = h(
        'div',
        { class: 'level-powers' },
        PERMISSIONS.map((p) => {
          const tick = h('input', { type: 'checkbox', ariaLabel: p.label })
          tick.checked = level.can.includes(p.id)
          tick.disabled = !mine.can.includes(p.id)
          boxes.set(p.id, tick)
          return h('label', { class: `level-power${tick.disabled ? ' off' : ''}` }, [
            tick,
            h('span', { class: 'stack' }, [h('span', { class: 'level-power-name', text: p.label }), h('span', { class: 'tiny faint', text: p.about })]),
          ])
        }),
      )

      const stated = (): Level | null => {
        const called = name.value.trim().slice(0, 24)
        if (!called) {
          toast('Give the level a name.', 'warn')
          name.focus()
          return null
        }
        const can = PERMISSIONS.map((p) => p.id).filter((id) => boxes.get(id)?.checked)
        return { ...level, name: called, colour, can }
      }

      const saveButton = h('button', { class: 'primary', text: 'Save' })
      saveButton.addEventListener('click', () => {
        const next = stated()
        if (next) void save(next).then(() => toast(`${next.name} saved.`, 'good'))
      })
      name.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') saveButton.click()
      })
      const order = h('div', { class: 'row' }, [
        h('button', {
          class: 'ghost small',
          text: 'Move up',
          disabled: !up,
          on: { click: () => up && void save(up) },
        }),
        h('button', {
          class: 'ghost small',
          text: 'Move down',
          disabled: !down,
          on: { click: () => down && void save(down) },
        }),
      ])
      const remove =
        level.id === MEMBER
          ? null
          : h('button', {
              class: 'ghost small danger',
              text: 'Delete level',
              on: {
                click: () => {
                  if (!window.confirm(`Delete the level ${level.name}? Its people go back to being members.`)) return
                  opened = ''
                  void options.publish((c) => c.dropLevel(level.id)).then(draw)
                },
              },
            })

      return h('div', { class: 'level-form stack' }, [
        h('label', { class: 'stack tight' }, [h('span', { class: 'eyebrow', text: 'Name' }), name]),
        h('div', { class: 'stack tight' }, [h('span', { class: 'eyebrow', text: 'Colour of their names' }), swatches]),
        h('div', { class: 'stack tight' }, [h('span', { class: 'eyebrow', text: 'What they can do' }), powers]),
        level.id === MEMBER ? null : order,
        h('div', { class: 'row spread' }, [saveButton, remove]),
      ])
    }

    const add = h('button', { class: 'ghost small start' }, [icon('plus', 14), 'New level'])
    add.addEventListener('click', () => {
      const lowest = levels.filter((l) => l.id !== MEMBER && l.rank < mine.rank).at(-1)
      const used = new Set(levels.map((l) => l.colour))
      const level: Level = {
        id: newLevelId(),
        name: 'New level',
        colour: LEVEL_COLOURS.find((c) => !used.has(c)) ?? LEVEL_COLOURS[0],
        rank: (lowest?.rank ?? mine.rank) / 2,
        can: [],
      }
      opened = level.id
      void save(level)
    })

    root.replaceChildren(
      h('div', {
        class: 'tiny faint',
        text: 'The colour of a level is the colour of its people’s names. You can change the levels below yours. To put somebody on a level, open their menu in the list of people.',
      }),
      ...levels.map(row),
      add,
    )
    root.querySelector<HTMLInputElement>('.level.open input[type="text"]')?.focus()
  }

  draw()
  return root
}
