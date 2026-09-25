import { fetchIce, serverTag } from '../backend'
import { denoise, type Denoiser } from '../net/denoise'
import { audioDevices, DEVICES_CHANGED, explainMicRefusal, micSettings, openMic, playOn, setMicSettings } from '../net/mic'
import { knownServers } from '../store/server-spaces'
import { h } from './dom'
import { icon } from './icons'

interface Test {
  stop(): void
  hear(on: boolean): void
}

async function startTest(onLevel: (level: number, label: string) => void): Promise<Test> {
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
  const label = raw.getAudioTracks()[0]?.label || 'Microphone'
  const ctx = new AudioContext()
  await ctx.resume().catch(() => undefined)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  ctx.createMediaStreamSource(stream).connect(analyser)
  const data = new Float32Array(analyser.fftSize)
  let running = true
  const tick = (): void => {
    if (!running) return
    analyser.getFloatTimeDomainData(data)
    let sum = 0
    for (const v of data) sum += v * v
    // Maps -60 dBFS to -10 dBFS onto 0 to 1.
    const rms = Math.sqrt(sum / data.length)
    onLevel(Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-8) + 60) / 50)), label)
    requestAnimationFrame(tick)
  }
  tick()
  const back = document.createElement('audio')
  back.muted = true
  back.srcObject = stream
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
      cleaner?.close()
      raw.getTracks().forEach((t) => t.stop())
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close().catch(() => undefined)
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
            'Check that ports 3478 and 49160–49260 are open and that CATHODE_TURN_URLS names this server.',
        }
  } catch {
    return { ok: false, text: `${tag}: the relay could not be tried from this browser.` }
  } finally {
    pc.close()
  }
}

export function voiceSettings(more: HTMLElement[] = []): HTMLElement {
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

  const bar = h('i')
  const meter = h('div', { class: 'meter', role: 'meter', ariaLabel: 'Microphone level' }, [bar])
  const which = h('span', { class: 'tiny faint truncate' })
  const testButton = h('button', {}, [icon('mic', 15), 'Test mic'])
  const hearButton = h('button', { class: 'ghost hidden' }, [icon('volume', 15), 'Hear yourself'])
  let test: Test | null = null
  let hearing = false
  const watch = new MutationObserver(() => {
    if (!root.isConnected) stop()
  })

  const stop = (): void => {
    watch.disconnect()
    test?.stop()
    test = null
    hearing = false
    bar.style.width = '0%'
    testButton.replaceChildren(icon('mic', 15), 'Test microphone')
    hearButton.classList.add('hidden')
    hearButton.classList.remove('on')
    which.textContent = ''
  }
  const start = async (): Promise<void> => {
    testButton.disabled = true
    try {
      test = await startTest((level, label) => {
        bar.style.width = `${Math.round(level * 100)}%`
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
    }
  }
  const restart = async (): Promise<void> => {
    const wasHearing = hearing
    stop()
    await start()
    if (wasHearing) {
      hearing = true
      test?.hear(true)
      hearButton.classList.add('on')
    }
  }
  testButton.addEventListener('click', () => (test ? stop() : void start()))
  hearButton.addEventListener('click', () => {
    hearing = !hearing
    test?.hear(hearing)
    hearButton.classList.toggle('on', hearing)
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

  const root = h('div', { class: 'stack tight' }, [
    h('label', { class: 'field-row' }, [h('span', { class: 'field-label', text: 'Microphone' }), input]),
    named,
    h('label', { class: 'field-row' }, [h('span', { class: 'field-label', text: 'Speaker' }), output]),
    h('div', { class: 'mic-test' }, [h('div', { class: 'row wrap' }, [testButton, hearButton]), meter, which]),
    h('details', { class: 'adv' }, [
      h('summary', { text: 'More' }),
      h('div', { class: 'stack tight' }, [...more, h('div', { class: 'row wrap' }, [relayButton]), results]),
    ]),
  ])
  return root
}
