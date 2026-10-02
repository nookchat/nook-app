import { h } from './dom'
import { icon } from './icons'
import { placeNear } from './emoji'
import { asSheet, phone } from './gestures'
import { lengthOf, loudnessOf, peakOf } from './loudness'
import { sharedAudio, soundsOn } from './sounds'

export interface Sound {
  id: string
  label: string
  emoji: string
  /** The id of its group, or '' when it stands outside every group. */
  group: string
}

export interface SoundGroup {
  id: string
  label: string
  emoji: string
}

/** A sound somebody added: its id on the wire is CUSTOM + the board id. */
export const CUSTOM = 'c:'
/** Longest a sound that somebody added plays for. */
export const CUSTOM_MAX_S = 10

const VOLUME_KEY = 'nook:board-volume'
const FOLDED_KEY = 'nook:board-folded'

/** The groups this person folded shut, by id. Only on this device. */
function foldedGroups(): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]')
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function foldGroup(id: string, folded: boolean): void {
  const all = foldedGroups()
  if (folded) all.add(id)
  else all.delete(id)
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...all]))
  } catch {
    /* storage can be blocked */
  }
}

/** How loud the soundboard plays here, from 0 to 1. */
export function boardVolume(): number {
  try {
    const saved = Number(localStorage.getItem(VOLUME_KEY))
    if (localStorage.getItem(VOLUME_KEY) !== null && Number.isFinite(saved)) return Math.min(1, Math.max(0, saved))
  } catch {
    /* storage can be blocked */
  }
  return 0.8
}

export function setBoardVolume(level: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(Math.min(1, Math.max(0, level))))
  } catch {
    /* storage can be blocked */
  }
  const ctx = sharedAudio()
  const node = ctx ? levels.get(ctx) : undefined
  if (ctx && node) node.gain.setTargetAtTime(LOUDNESS * boardVolume(), ctx.currentTime, 0.02)
}

const LOUDNESS = 1.6
const levels = new WeakMap<BaseAudioContext, GainNode>()

/** Each sound playing now, by id, so playing it again starts it over. */
const playing = new Map<string, GainNode>()

/**
 * Every sound goes through one chain: a gentle top cut, a small room, and a
 * compressor, so a loud sound somebody added cannot blow anybody's ears out.
 */
const chains = new WeakMap<BaseAudioContext, AudioNode>()

function room(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const frames = Math.floor(ctx.sampleRate * seconds)
  const buffer = ctx.createBuffer(2, frames, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 3)
  }
  return buffer
}

function out(ctx: BaseAudioContext): AudioNode {
  const had = chains.get(ctx)
  if (had) return had
  const input = ctx.createGain()
  const tone = ctx.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.value = 9000
  tone.Q.value = 0.5
  const dry = ctx.createGain()
  dry.gain.value = 1
  const wet = ctx.createGain()
  wet.gain.value = 0.16
  const verb = ctx.createConvolver()
  verb.buffer = room(ctx, 1.1)
  const squeeze = ctx.createDynamicsCompressor()
  squeeze.threshold.value = -18
  squeeze.knee.value = 12
  squeeze.ratio.value = 4
  squeeze.attack.value = 0.004
  squeeze.release.value = 0.2
  const level = ctx.createGain()
  level.gain.value = LOUDNESS * boardVolume()
  levels.set(ctx, level)
  input.connect(tone)
  tone.connect(dry)
  tone.connect(verb)
  verb.connect(wet)
  dry.connect(squeeze)
  wet.connect(squeeze)
  squeeze.connect(level)
  level.connect(ctx.destination)
  chains.set(ctx, input)
  return input
}

function ready(): AudioContext | null {
  if (!soundsOn()) return null
  const ctx = sharedAudio()
  if (!ctx) return null
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  return ctx
}

/** A fresh path for one play of `id`. The last play of the same sound fades out at once. */
function freshPlay(ctx: AudioContext, id: string, seconds: number): GainNode {
  const old = playing.get(id)
  if (old) {
    old.gain.cancelScheduledValues(ctx.currentTime)
    old.gain.setValueAtTime(old.gain.value, ctx.currentTime)
    old.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.03)
    window.setTimeout(() => old.disconnect(), 80)
  }
  const bus = ctx.createGain()
  bus.connect(out(ctx))
  playing.set(id, bus)
  window.setTimeout(() => {
    if (playing.get(id) !== bus) return
    playing.delete(id)
    bus.disconnect()
  }, (seconds + 1.5) * 1000)
  return bus
}

/**
 * Every sound is brought to this loudness, in LUFS, before the chain: the
 * broadcast level of EBU R128. A quiet clip is as loud as any other, and a
 * loud one is no louder.
 */
const TARGET_LUFS = -23
/** A quiet recording is turned up this much at most (12 dB), so its hiss does not come up with it. */
const CLIP_MOST_GAIN = 4

/** What one play needs: how far to turn it up or down, and how long it lasts. */
interface Level {
  gain: number
  seconds: number
}

const clipLevels = new WeakMap<AudioBuffer, Level>()

function channelsOf(buffer: AudioBuffer, seconds: number): Float32Array[] {
  const frames = Math.min(buffer.length, Math.floor(seconds * buffer.sampleRate))
  return Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).subarray(0, frames))
}

/** `seconds` is how much of it to measure, `most` how far it may be turned up. */
function levelOf(buffer: AudioBuffer, seconds: number, most = Infinity): Level {
  const channels = channelsOf(buffer, seconds)
  const loudness = loudnessOf(channels, buffer.sampleRate)
  const peak = peakOf(channels)
  const lasts = lengthOf(channels, buffer.sampleRate)
  if (!Number.isFinite(loudness) || peak === 0) return { gain: 1, seconds: lasts }
  // Never so far up that the loudest moment goes past full scale.
  return { gain: Math.min(most, 10 ** ((TARGET_LUFS - loudness) / 20), 1 / peak), seconds: lasts }
}


/** A sound somebody added, already decoded. Returns how long it plays, or 0 when it does not. */
export function playClip(id: string, buffer: AudioBuffer): number {
  const ctx = ready()
  if (!ctx) return 0
  let level = clipLevels.get(buffer)
  if (!level) {
    level = levelOf(buffer, CUSTOM_MAX_S, CLIP_MOST_GAIN)
    clipLevels.set(buffer, level)
  }
  const src = ctx.createBufferSource()
  src.buffer = buffer
  const vol = ctx.createGain()
  vol.gain.value = level.gain
  src.connect(vol)
  vol.connect(freshPlay(ctx, id, Math.min(buffer.duration, CUSTOM_MAX_S)))
  const at = ctx.currentTime + 0.02
  src.start(at)
  if (buffer.duration > CUSTOM_MAX_S) {
    vol.gain.setValueAtTime(level.gain, at + CUSTOM_MAX_S - 0.3)
    vol.gain.linearRampToValueAtTime(0.0001, at + CUSTOM_MAX_S)
    src.stop(at + CUSTOM_MAX_S)
  }
  return level.seconds
}

/** Decoded and measured, so a play has nothing left to do. */
export async function decodeClip(bytes: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = sharedAudio()
  if (!ctx) throw new Error('This browser cannot play sounds.')
  const buffer = await ctx.decodeAudioData(bytes)
  clipLevels.set(buffer, levelOf(buffer, CUSTOM_MAX_S, CLIP_MOST_GAIN))
  return buffer
}

interface BoardOptions {
  anchor: HTMLElement
  onPick(id: string): void
  /** Sounds people added, with ids that start with CUSTOM. */
  sounds: Sound[]
  groups: SoundGroup[]
  /** Opens the soundboard in Space settings, where sounds and groups are added and changed. */
  onManage(): void
  /** Opens the Add sound modal directly. */
  onAdd(): void
}

let open: { close(): void; anchor: HTMLElement } | null = null

/** How loud the soundboard is for you: a slider, for Space settings. */
export function volumeRow(): HTMLElement {
  const value = h('span', { class: 'tiny faint sound-volume-value' })
  const range = h('input', { type: 'range', min: '0', max: '100', step: '1', ariaLabel: 'Soundboard volume' })
  range.value = String(Math.round(boardVolume() * 100))
  const paint = (): void => {
    value.textContent = `${range.value}%`
  }
  range.addEventListener('input', () => {
    setBoardVolume(Number(range.value) / 100)
    paint()
  })
  paint()
  return h('label', { class: 'row sound-volume', title: 'How loud the soundboard is for you' }, [
    icon('volume-low', 16),
    range,
    value,
  ])
}

/** The board by the voice bar: it only plays. Sounds and groups are managed in Space settings. */
export function openSoundboard(options: BoardOptions): void {
  if (open && open.anchor === options.anchor) {
    open.close()
    return
  }
  open?.close()

  const sections = h('div', { class: 'sound-sections' })
  const foot = h('div', { class: 'tiny faint' })

  const pop = h('div', { class: 'sound-pop', role: 'dialog', ariaLabel: 'Soundboard' }, [
    h('div', { class: 'row spread' }, [
      h('span', { class: 'eyebrow', text: 'Soundboard' }),
      h('div', { class: 'row sound-head-tools' }, [
        h(
          'button',
          {
            class: 'ghost icon-only',
            title: 'Add a sound',
            ariaLabel: 'Add a sound',
            on: {
              click: () => {
                close()
                options.onAdd()
              },
            },
          },
          [icon('plus', 18)],
        ),
        h(
          'button',
          {
            class: 'ghost icon-only',
            title: 'Manage the soundboard in Space settings',
            ariaLabel: 'Manage the soundboard',
            on: {
              click: () => {
                close()
                options.onManage()
              },
            },
          },
          [icon('cog', 18)],
        ),
        h(
          'button',
          {
            class: 'ghost icon-only pop-close',
            title: 'Close',
            ariaLabel: 'Close the soundboard',
            on: { click: () => close() },
          },
          [icon('close', 18)],
        ),
      ]),
    ]),
    sections,
    foot,
  ])

  const groupIds = new Set(options.groups.map((g) => g.id))
  const groupOf = (sound: Sound): string => (groupIds.has(sound.group) ? sound.group : '')

  const cell = (sound: Sound): HTMLElement =>
    h(
      'button',
      {
        class: 'sound-cell custom',
        title: `Play ${sound.label} for everybody in voice`,
        ariaLabel: `Play ${sound.label} for everybody`,
        on: { click: () => options.onPick(sound.id) },
      },
      [
        h('span', { class: 'sound-emoji', text: sound.emoji }),
        h('span', { class: 'sound-name', text: sound.label }),
      ],
    )

  const loose = options.sounds.filter((sound) => !groupOf(sound))
  if (options.sounds.length === 0) {
    sections.append(
      h('div', { class: 'sound-empty tiny faint', text: 'No sounds here yet.' }),
      h('button', {
        class: 'small sound-empty-add',
        text: 'Add a sound',
        on: {
          click: () => {
            close()
            options.onAdd()
          },
        },
      }),
    )
  } else if (loose.length) {
    sections.append(h('div', { class: 'sound-grid' }, loose.map(cell)))
  }

  const folded = foldedGroups()
  for (const group of options.groups) {
    const inIt = options.sounds.filter((sound) => sound.group === group.id)
    if (inIt.length === 0) continue
    const grid = h('div', { class: 'sound-grid' }, inIt.map(cell))
    const head = h(
      'button',
      {
        class: 'sound-group-head',
        title: 'Fold or open this group, only for you',
        on: {
          click: () => {
            const shut = !section.classList.contains('folded')
            section.classList.toggle('folded', shut)
            head.setAttribute('aria-expanded', String(!shut))
            foldGroup(group.id, shut)
          },
        },
      },
      [
        h('span', { class: 'sound-group-fold' }, [icon('chevron-down', 14)]),
        h('span', { class: 'sound-group-emoji', text: group.emoji }),
        h('span', { class: 'sound-group-name', text: group.label }),
        h('span', { class: 'tiny faint', text: String(inIt.length) }),
      ],
    )
    head.setAttribute('aria-expanded', String(!folded.has(group.id)))
    const section = h('section', { class: `sound-group${folded.has(group.id) ? ' folded' : ''}`, ariaLabel: group.label }, [head, grid])
    sections.append(section)
  }

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return
    close()
    options.anchor.focus()
  }
  const onDown = (ev: Event): void => {
    const target = ev.target as Node
    if (pop.contains(target) || options.anchor.contains(target)) return
    close()
  }
  function close(): void {
    if (open?.close !== close) return
    open = null
    pop.remove()
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('pointerdown', onDown, true)
    window.removeEventListener('resize', close)
  }

  open = { close, anchor: options.anchor }
  if (soundsOn()) foot.remove()
  else foot.textContent = 'Sounds are off. Turn them on in Settings to play these.'
  document.body.append(pop)
  const sheet = phone()
  if (sheet) asSheet(pop, close)
  else placeNear(pop, options.anchor)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('pointerdown', onDown, true)
  if (!sheet) window.addEventListener('resize', close)
}
