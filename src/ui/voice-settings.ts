import { fetchIce, serverTag } from '../backend'
import { denoise, type Denoiser } from '../net/denoise'
import {
  audioDevices,
  changeMic,
  DEVICES_CHANGED,
  explainMicRefusal,
  LOUD_DB,
  micSettings,
  openMic,
  playOn,
  QUIET_DB,
  setMicSettings,
  VOICES,
  cleanVoice,
} from '../net/mic'
import { shape, type Shaped } from '../net/shaper'
import { knownServers } from '../store/server-spaces'
import { h } from './dom'
import { icon } from './icons'

const PREVIEW_HINT = 'Wear headphones, or the speaker plays back into the mic.'

interface Test {
  stop(): void
  hear(on: boolean): void
}

/** Where a level in dBFS sits on the meter, from 0 to 1. */
function onMeter(db: number): number {
  return Math.min(1, Math.max(0, (db - QUIET_DB) / (LOUD_DB - QUIET_DB)))
}

async function startTest(onLevel: (level: number, open: boolean, label: string) => void): Promise<Test> {
  let raw: MediaStream
  try {
    raw = await openMic()
  } catch (err) {
    throw new Error(await explainMicRefusal(err))
  }
  let stream = raw
  let cleaner: Denoiser | null = null
  if (micSettings().smart) {
    cleaner = await denoise(raw)
    if (cleaner) stream = cleaner.stream
  }
  // The same last step a call uses, so the test sounds like what others hear.
  const shaper: Shaped = shape(stream)
  const label = raw.getAudioTracks()[0]?.label || 'Microphone'
  let running = true
  const tick = (): void => {
    if (!running) return
    onLevel(onMeter(shaper.level()), shaper.open(), label)
    requestAnimationFrame(tick)
  }
  tick()
  const back = document.createElement('audio')
  back.muted = true
  back.srcObject = shaper.stream
  playOn(back)
  document.body.append(back)
  void back.play().catch(() => undefined)
  return {
    hear: (on) => {
      back.muted = !on
      if (on) void back.play().catch(() => undefined)
    },
    stop: () => {
      running = false
      back.srcObject = null
      back.remove()
      shaper.close()
      cleaner?.close()
      raw.getTracks().forEach((t) => t.stop())
      stream.getTracks().forEach((t) => t.stop())
    },
  }
}

async function testRelay(server: string): Promise<{ ok: boolean; text: string }> {
  const ice = await fetchIce(server)
  const tag = serverTag(server)
  if (ice.iceServers.length === 0) {
    return {
      ok: true,
      text: `${tag} has no relay, so calls go straight between people. That works on most networks and fails on some.`,
    }
  }
  const pc = new RTCPeerConnection({ iceServers: ice.iceServers, iceTransportPolicy: 'relay' })
  try {
    pc.createDataChannel('probe')
    const found = new Promise<boolean>((done) => {
      const timer = window.setTimeout(() => done(false), 8000)
      pc.onicecandidate = (ev) => {
        if (ev.candidate?.type === 'relay') {
          window.clearTimeout(timer)
          done(true)
        }
        if (!ev.candidate) {
          window.clearTimeout(timer)
          done(false)
        }
      }
    })
    await pc.setLocalDescription(await pc.createOffer())
    return (await found)
      ? { ok: true, text: `${tag}: the relay answers, so calls can connect.` }
      : {
          ok: false,
          text:
            `${tag}: the relay did not answer, and this server sends every call through it, so calls will not connect. ` +
            'Check that ports 3478 and 49160–49260 are open and that NOOK_TURN_URLS names this server.',
        }
  } catch {
    return { ok: false, text: `${tag}: the relay could not be tried from this browser.` }
  } finally {
    pc.close()
  }
}

function slider(label: string, min: number, max: number, value: number, say: (v: number) => string, set: (v: number) => void): HTMLElement {
  const input = h('input', { type: 'range', ariaLabel: label }) as HTMLInputElement
  input.min = String(min)
  input.max = String(max)
  input.step = '1'
  input.value = String(value)
  const shown = h('span', { class: 'slider-value', text: say(value) })
  input.addEventListener('input', () => {
    const v = Number(input.value)
    shown.textContent = say(v)
    set(v)
  })
  return h('label', { class: 'slider-row' }, [
    h('span', { class: 'row spread' }, [h('span', { class: 'field-label', text: label }), shown]),
    input,
  ])
}

const section = (title: string, ...children: (Node | null)[]): HTMLElement =>
  h('section', { class: 'settings-section stack tight' }, [h('span', { class: 'eyebrow', text: title }), ...children])

/** The Voice and audio tab. `processing` holds the switches for the filters. */
export function voiceSettings(processing: HTMLElement | null = null): HTMLElement {
  const input = h('select', { ariaLabel: 'Microphone' })
  const output = h('select', { ariaLabel: 'Speaker' })
  const fill = async (): Promise<void> => {
    const { inputs, outputs } = await audioDevices()
    const s = micSettings()
    const options = (select: HTMLSelectElement, list: MediaDeviceInfo[], chosen: string, what: string): number => {
      const system = list.find((d) => d.deviceId === 'default')?.label.replace(/^Default - /, '')
      select.replaceChildren(h('option', { value: '', text: system ? `The system’s ${what} (${system})` : `The system’s ${what}` }))
      const real = list.filter((d) => d.deviceId && d.deviceId !== 'default')
      real.forEach((d, i) => select.append(h('option', { value: d.deviceId, text: d.label || `${what} ${i + 1}` })))
      select.value = [...select.options].some((o) => o.value === chosen) ? chosen : ''
      return real.length
    }
    const mics = options(input, inputs, s.input ?? '', 'microphone')
    options(output, outputs, s.output ?? '', 'speaker')
    named.classList.toggle('hidden', mics > 0 || inputs.length === 0)
    output.disabled = outputs.length === 0 || !('setSinkId' in HTMLMediaElement.prototype)
  }
  input.addEventListener('change', () => {
    setMicSettings({ ...micSettings(), input: input.value })
    window.dispatchEvent(new Event(DEVICES_CHANGED))
    if (test) void restart()
  })
  output.addEventListener('change', () => {
    setMicSettings({ ...micSettings(), output: output.value })
    window.dispatchEvent(new Event(DEVICES_CHANGED))
    if (test) void restart()
  })
  // Browsers hide device names and ids until the microphone has been allowed once.
  const named = h('button', { class: 'ghost small start hidden', text: 'Show microphones' })
  named.addEventListener('click', async () => {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
      probe.getTracks().forEach((t) => t.stop())
    } catch (err) {
      which.textContent = await explainMicRefusal(err)
    }
    void fill()
  })
  const onDeviceChange = (): void => {
    if (root.isConnected) void fill()
    else navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange)
  }
  navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange)
  void fill()

  const start0 = micSettings()
  const volumes = h('div', { class: 'slider-pair' }, [
    slider('Input volume', 0, 200, Math.round(start0.inputVolume * 100), (v) => `${v}%`, (v) => changeMic({ inputVolume: v / 100 })),
    slider('Output volume', 0, 100, Math.round(start0.outputVolume * 100), (v) => `${v}%`, (v) => changeMic({ outputVolume: v / 100 })),
  ])

  // The level, with the threshold drawn on top of it: the voice goes through when the bar passes the line.
  const bar = h('i')
  const meter = h('div', { class: 'meter sensitivity-meter', role: 'meter', ariaLabel: 'Microphone level' }, [bar])
  const threshold = h('input', { type: 'range', class: 'threshold', ariaLabel: 'Input sensitivity' }) as HTMLInputElement
  threshold.min = String(QUIET_DB)
  threshold.max = String(LOUD_DB)
  threshold.step = '1'
  threshold.value = String(start0.threshold)
  threshold.addEventListener('input', () => changeMic({ threshold: Number(threshold.value) }))
  const autoSwitch = h('button', { class: 'switch-row', role: 'switch' }, [
    h('span', { class: 'switch-words' }, [
      h('span', { class: 'switch-label', text: 'Set the sensitivity for me' }),
      h('span', { class: 'tiny faint switch-about', text: 'Off: your mic opens only above the line' }),
    ]),
    h('span', { class: 'switch' }, [h('i')]),
  ])
  const gauge = h('div', { class: 'sensitivity' }, [meter, threshold])
  const paintAuto = (): void => {
    const auto = micSettings().autoSensitivity
    autoSwitch.setAttribute('aria-checked', String(auto))
    gauge.classList.toggle('auto', auto)
    threshold.disabled = auto
  }
  autoSwitch.addEventListener('click', () => {
    changeMic({ autoSensitivity: !micSettings().autoSensitivity })
    paintAuto()
  })
  paintAuto()

  const which = h('span', { class: 'tiny faint truncate' })
  const testButton = h('button', {}, [icon('mic', 15), 'Test mic'])
  const hearButton = h('button', { class: 'ghost hidden' }, [icon('volume', 15), 'Hear yourself'])
  // The voice changer's own way in to the same test: one press opens the mic and plays it back.
  const previewButton = h('button', {}, [icon('volume', 15), 'Preview my voice'])
  const previewNote = h('span', { class: 'tiny faint', text: PREVIEW_HINT })
  let test: Test | null = null
  let hearing = false
  const paintHearing = (): void => {
    hearButton.classList.toggle('on', hearing)
    previewButton.classList.toggle('on', hearing)
    previewButton.replaceChildren(...(hearing ? [icon('stop', 13), 'Stop preview'] : [icon('volume', 15), 'Preview my voice']))
  }
  const setHearing = (on: boolean): void => {
    hearing = on
    test?.hear(on)
    paintHearing()
  }
  const watch = new MutationObserver(() => {
    if (!root.isConnected) stop()
  })

  const stop = (): void => {
    watch.disconnect()
    test?.stop()
    test = null
    hearing = false
    paintHearing()
    bar.style.width = '0%'
    meter.classList.remove('open')
    testButton.replaceChildren(icon('mic', 15), 'Test mic')
    hearButton.classList.add('hidden')
    which.textContent = ''
  }
  const start = async (): Promise<void> => {
    testButton.disabled = true
    previewButton.disabled = true
    try {
      test = await startTest((level, open, label) => {
        bar.style.width = `${Math.round(level * 100)}%`
        meter.classList.toggle('open', open && level > 0.02)
        if (which.textContent !== label) which.textContent = label
      })
      watch.observe(document.body, { childList: true, subtree: true })
      testButton.replaceChildren(icon('stop', 13), 'Stop test')
      hearButton.classList.remove('hidden')
      void fill()
    } catch (err) {
      which.textContent = err instanceof Error ? err.message : 'The microphone would not open.'
    } finally {
      testButton.disabled = false
      previewButton.disabled = false
    }
  }
  const restart = async (): Promise<void> => {
    const wasHearing = hearing
    stop()
    await start()
    if (wasHearing) setHearing(true)
  }
  testButton.addEventListener('click', () => (test ? stop() : void start()))
  hearButton.addEventListener('click', () => setHearing(!hearing))
  previewButton.addEventListener('click', async () => {
    if (hearing) {
      stop()
      return
    }
    previewNote.textContent = PREVIEW_HINT
    if (!test) await start()
    if (test) setHearing(true)
    // Why the mic would not open, here as well as under the test, which is further up.
    else previewNote.textContent = which.textContent
  })

  const results = h('div', { class: 'stack tight' })
  const relayButton = h('button', {}, [icon('server', 15), 'Test connection'])
  relayButton.addEventListener('click', async () => {
    relayButton.disabled = true
    results.replaceChildren(h('span', { class: 'tiny faint', text: 'Trying each of your servers…' }))
    const servers = knownServers()
    if (servers.length === 0) {
      results.replaceChildren(h('span', { class: 'tiny faint', text: 'Add a server first.' }))
      relayButton.disabled = false
      return
    }
    const answers = await Promise.all(servers.map(testRelay))
    results.replaceChildren(
      ...answers.map((a) =>
        h('div', { class: `relay-result ${a.ok ? 'good' : 'bad'}` }, [h('i', { class: `dot ${a.ok ? 'good' : 'bad'}` }), h('span', { text: a.text })]),
      ),
    )
    relayButton.disabled = false
  })

  // The voice changer: it works in the mic test and in a call at once, and a call picks the change up as it is made.
  const voices = h('div', { class: 'voice-choices', role: 'radiogroup', ariaLabel: 'Voice changer' })
  const paintVoices = (): void => {
    const chosen = micSettings().voice
    for (const button of voices.querySelectorAll('button')) {
      const on = button.dataset.voice === chosen
      button.classList.toggle('on', on)
      button.setAttribute('aria-checked', String(on))
    }
  }
  for (const voice of VOICES) {
    const button = h('button', { class: 'voice-choice', role: 'radio', title: voice.about }, [
      h('span', { class: 'voice-choice-name', text: voice.label }),
      h('span', { class: 'tiny faint voice-choice-about', text: voice.about }),
    ])
    button.dataset.voice = voice.id
    button.addEventListener('click', () => {
      changeMic({ voice: cleanVoice(voice.id) })
      paintVoices()
    })
    voices.append(button)
  }
  paintVoices()

  const root = h('div', { class: 'stack settings-stack' }, [
    section(
      'Devices',
      h('div', { class: 'field-pair' }, [
        h('label', { class: 'field-row' }, [h('span', { class: 'field-label', text: 'Microphone' }), input]),
        h('label', { class: 'field-row' }, [h('span', { class: 'field-label', text: 'Speaker' }), output]),
      ]),
      named,
      volumes,
    ),
    section(
      'Mic test',
      h('div', { class: 'tiny faint', text: 'Talk, and watch the bar. Hear yourself plays back what others would hear.' }),
      h('div', { class: 'mic-test' }, [h('div', { class: 'row wrap' }, [testButton, hearButton]), which]),
    ),
    section(
      'Voice changer',
      h('div', { class: 'tiny faint', text: 'Changes what the others hear. Preview your voice, then choose one to hear it at once.' }),
      voices,
      h('div', { class: 'row wrap voice-preview' }, [
        previewButton,
        previewNote,
      ]),
    ),
    section(
      'Input sensitivity',
      autoSwitch,
      gauge,
      h('div', { class: 'tiny faint', text: 'Start the mic test to see your level. Green means the others hear you.' }),
    ),
    processing ? section('Voice processing', processing) : null,
    section('Connection', h('div', { class: 'row wrap' }, [relayButton]), results),
  ])
  return root
}
