/**
 * Host settings that survive a reload.
 *
 * There is no server, so this lives in localStorage. A person who shares a
 * screen every day should not have to pick the same preset every time.
 */

import {
  DEFAULT_PRESET,
  presetById,
  type CodecChoice,
  type Mode,
  type PresetId,
} from './rtc/quality'

const KEY = 'beam.settings.v1'

export interface HostSettings {
  presetId: PresetId
  mode: Mode
  maxHeight: number
  fps: number
  bitrateScale: number
  budgetKbps: number
  /** True while Beam sets the budget from what it measures. */
  budgetAuto: boolean
  maxViewers: number
  approve: boolean
  codec: CodecChoice
  shareSystemAudio: boolean
}

export function defaultSettings(): HostSettings {
  const preset = presetById(DEFAULT_PRESET)!
  return {
    presetId: preset.id,
    mode: preset.mode,
    maxHeight: preset.maxHeight,
    fps: preset.fps,
    bitrateScale: preset.bitrateScale,
    budgetKbps: 6000,
    budgetAuto: true,
    maxViewers: 10,
    approve: false,
    codec: 'auto',
    shareSystemAudio: true,
  }
}

export function loadSettings(): HostSettings {
  const base = defaultSettings()
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return base
    const saved = JSON.parse(raw) as Partial<HostSettings>
    const merged: HostSettings = { ...base, ...saved }
    // Never trust stored numbers. A hand edited value must not break a session.
    merged.fps = clamp(merged.fps, 1, 60, base.fps)
    merged.maxHeight = clamp(merged.maxHeight, 0, 4320, base.maxHeight)
    merged.bitrateScale = clamp(merged.bitrateScale, 0.2, 3, base.bitrateScale)
    merged.budgetKbps = clamp(merged.budgetKbps, 500, 50_000, base.budgetKbps)
    merged.maxViewers = clamp(Math.round(merged.maxViewers), 1, 20, base.maxViewers)
    if (merged.mode !== 'text' && merged.mode !== 'motion') merged.mode = base.mode
    merged.budgetAuto = merged.budgetAuto !== false
    return merged
  } catch {
    return base
  }
}

export function saveSettings(settings: HostSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    // Private mode, or a full quota. Losing a preference is not worth an error.
  }
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
