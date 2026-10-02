import { spaces } from '../space/registry'
import { isCallChannel, type CallNews, type SpaceRuntime } from '../space/runtime'
import { askNotify } from './notify'
import { phoneShell } from './phone-shell'

/**
 * In the Android app, a call keeps going with the app put away, as Discord's does: while you are in
 * voice the app shows a notification with Mute and Leave, and Android lets the microphone and the
 * network go on behind it.
 */
export function keepVoiceOnPhone(): void {
  const phone = phoneShell
  if (!phone) return
  const where = (): SpaceRuntime | null => spaces.all().find((s) => !!s.voice?.state.channel) ?? null
  let said = ''
  const paint = (): void => {
    const space = where()
    if (!space) {
      if (said) phone.voice(null)
      said = ''
      return
    }
    const channel = space.voice.state.channel ?? ''
    const call = isCallChannel(channel) ? space.call : null
    const title = call ? (call.live ? 'In a call' : 'Calling…') : 'Voice connected'
    const text = call
      ? `With ${space.chat?.nameOf(call.with) || 'somebody'}`
      : `${channel} · ${space.chat?.spaceName() || 'a space'}`
    const now = { title, text, muted: space.voice.state.muted }
    const words = JSON.stringify(now)
    if (words === said) return
    // Android 13 hides the call's notification, with its Mute and Leave, until the app may notify.
    // Once it may, the notification goes up again so that it shows.
    if (!said && phone.notifyPermission() === 'prompt') {
      void askNotify().then(() => {
        said = ''
        paint()
      })
    }
    said = words
    phone.voice(now)
  }
  window.addEventListener('nook:call', (ev) => {
    const news = (ev as CustomEvent<CallNews>).detail
    if (news.kind === 'changed' || news.kind === 'ended') paint()
  })
  phone.onVoiceAction((action) => {
    const space = where()
    if (!space) return phone.voice(null)
    if (action === 'leave') space.leaveVoice()
    else space.voice.setMuted(!space.voice.state.muted)
  })
}
