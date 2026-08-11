/**
 * What this browser can do, in plain words.
 *
 * Cathode checks this before the host presses Start, so nobody meets a broken
 * feature halfway through a session.
 */

import { availableCodecs } from './rtc/quality'
import { hasTurn } from './rtc/config'

export interface Support {
  webrtc: boolean
  screenCapture: boolean
  microphone: boolean
  systemAudio: boolean
  pictureInPicture: boolean
  fullscreen: boolean
  secureContext: boolean
  codecs: string[]
  browser: string
  isIOS: boolean
}

function detectBrowser(): string {
  const ua = navigator.userAgent
  if (/Firefox\//.test(ua)) return 'Firefox'
  if (/Edg\//.test(ua)) return 'Edge'
  if (/OPR\//.test(ua)) return 'Opera'
  if (/Chrome\//.test(ua)) return 'Chrome'
  if (/Safari\//.test(ua)) return 'Safari'
  return 'this browser'
}

function detectIOS(): boolean {
  const ua = navigator.userAgent
  // An iPad reports as a Mac, so we also look for touch on a Mac.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

export function checkSupport(): Support {
  const browser = detectBrowser()
  const isIOS = detectIOS()
  const screenCapture = !!navigator.mediaDevices?.getDisplayMedia && !isIOS

  return {
    webrtc: typeof RTCPeerConnection !== 'undefined',
    screenCapture,
    microphone: !!navigator.mediaDevices?.getUserMedia,
    // Only Chromium hands over the audio of a shared tab or screen.
    systemAudio: screenCapture && (browser === 'Chrome' || browser === 'Edge' || browser === 'Opera'),
    pictureInPicture: 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled,
    fullscreen: !!document.documentElement.requestFullscreen,
    secureContext: window.isSecureContext,
    codecs: availableCodecs(),
    browser,
    isIOS,
  }
}

/** A blocking problem for a host, or null when the host can start. */
export function hostBlocker(s: Support): string | null {
  if (!s.secureContext) {
    return 'Cathode needs HTTPS. Open the site over https, or use http://localhost while you develop.'
  }
  if (!s.webrtc) {
    return `${s.browser} has no WebRTC, so it cannot run Cathode.`
  }
  if (s.isIOS) {
    return 'An iPhone or an iPad cannot share a screen from any browser. Apple gives no browser that permission. You can still watch a stream on this device.'
  }
  if (!s.screenCapture) {
    return `${s.browser} cannot capture a screen. Chrome, Edge, or Firefox on a desktop can.`
  }
  return null
}

/** A blocking problem for a viewer, or null when the viewer can watch. */
export function viewerBlocker(s: Support): string | null {
  if (!s.secureContext) return 'Cathode needs HTTPS to watch a stream.'
  if (!s.webrtc) return `${s.browser} has no WebRTC, so it cannot watch a Cathode stream.`
  return null
}

/** Non blocking notes, shown once on the host screen. */
export function hostNotes(s: Support): string[] {
  const notes: string[] = []
  if (!s.systemAudio) {
    notes.push(
      `${s.browser} does not hand over the audio of the shared screen. Your microphone still works. Chrome and Edge can capture tab audio.`,
    )
  }
  if (!s.codecs.includes('VP9') && !s.codecs.includes('AV1')) {
    notes.push(
      'This browser has no VP9 and no AV1. Text will need more bandwidth to stay sharp on VP8 or H264.',
    )
  }
  if (!hasTurn()) {
    notes.push(
      'Cathode runs with no relay server. About one viewer in eight on a strict network will fail to connect.',
    )
  }
  return notes
}

export function supportRows(s: Support): { label: string; ok: boolean; note: string }[] {
  return [
    { label: 'WebRTC', ok: s.webrtc, note: s.webrtc ? 'ready' : 'missing' },
    {
      label: 'Screen capture',
      ok: s.screenCapture,
      note: s.screenCapture ? 'ready' : s.isIOS ? 'not possible on iOS' : 'missing',
    },
    { label: 'Microphone', ok: s.microphone, note: s.microphone ? 'ready' : 'missing' },
    {
      label: 'Audio of the shared screen',
      ok: s.systemAudio,
      note: s.systemAudio ? 'Chromium, tab or screen' : `not offered by ${s.browser}`,
    },
    {
      label: 'Video codecs',
      ok: s.codecs.length > 0,
      note: s.codecs.length ? s.codecs.join(', ') : 'unknown',
    },
    {
      label: 'Picture in picture',
      ok: s.pictureInPicture,
      note: s.pictureInPicture ? 'ready' : 'missing',
    },
    { label: 'HTTPS', ok: s.secureContext, note: s.secureContext ? 'secure' : 'insecure page' },
  ]
}
