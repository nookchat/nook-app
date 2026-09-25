export interface Support {
  webrtc: boolean
  screenCapture: boolean
  secureContext: boolean
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
  const isIOS = detectIOS()
  return {
    webrtc: typeof RTCPeerConnection !== 'undefined',
    screenCapture: !!navigator.mediaDevices?.getDisplayMedia && !isIOS,
    secureContext: window.isSecureContext,
    browser: detectBrowser(),
    isIOS,
  }
}

export function hostBlocker(s: Support): string | null {
  if (!s.secureContext) {
    return 'This page needs HTTPS. Open the site over https, or use http://localhost while you develop.'
  }
  if (!s.webrtc) {
    return `${s.browser} has no WebRTC, so it cannot run this.`
  }
  if (s.isIOS) {
    return 'An iPhone or an iPad cannot share a screen from any browser. Apple gives no browser that permission. You can still watch a stream on this device.'
  }
  if (!s.screenCapture) {
    return `${s.browser} cannot capture a screen. Chrome, Edge, or Firefox on a desktop can.`
  }
  return null
}
