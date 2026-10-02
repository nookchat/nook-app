import type { CapacitorConfig } from '@capacitor/cli'

// The Android app is a shell around the site, as the desktop app is: it loads the home site, so
// invite links stay the same and the site's own updates reach it. NOOK_URL points it at another
// home, such as the Vite server on http://localhost:5173 through `adb reverse`.
// nookchat.app sends a page to www.nookchat.app, and the shell gives any other site to the browser,
// so it loads the www site itself and lets both hosts in, and those of the old home.
const home = process.env.NOOK_URL || 'https://www.nookchat.app'

const config: CapacitorConfig = {
  appId: 'app.nook',
  appName: 'Nook',
  // Only the page shown with no network is kept in the app.
  webDir: 'mobile/www',
  server: {
    url: home,
    cleartext: home.startsWith('http://'),
    errorPath: 'offline.html',
    allowNavigation: ['nookchat.app', 'www.nookchat.app', 'cathode.video', 'www.cathode.video'],
  },
  android: {
    path: 'android',
  },
}

export default config
