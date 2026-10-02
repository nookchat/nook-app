# Nook for Android

A Capacitor shell around the site, as `desktop/` is an Electron one. It loads
`https://www.nookchat.app` and adds what a WebView does not have:
notifications, a call that keeps going with the app put away, saving to
Downloads, the colour of the system bars, and links that open in the app.
`capacitor.config.ts`, at the root of the repo, says what it loads.

| Where | What |
| --- | --- |
| `app/src/main/java/app/nook/MainActivity.java` | The window, its colour before the page paints, and the back button |
| `app/src/main/java/app/nook/NookPhonePlugin.java` | What the page asks of the app: `state`, `askNotify`, `show`, `voice`, `bars`, `saveStart`, `saveChunk`, `saveEnd` |
| `app/src/main/java/app/nook/VoiceService.java` | The foreground service, and its notification with Mute and Leave, while you are in voice |
| `../src/ui/phone-shell.ts` | The page's side of the plugin |
| `../src/ui/phone-voice.ts` | Tells the app when you join, mute and leave |
| `../mobile/www/offline.html` | Shown when the app cannot reach the site |

The page's side of the plugin reaches the app only once the site is deployed.
An app on a phone takes the site as it is now, so a new version of the site
must work with an older app: `phoneShell` is null when the app has no
`NookPhone` plugin.

## Run it

You need Android Studio (or the Android SDK) and a phone with USB debugging,
or an emulator.

```sh
npm install
npm run android        # syncs, then opens the project in Android Studio; press Run
```

Against the stack on this computer (`npm run stack` in another terminal):

```sh
npm run android:dev    # the app loads http://localhost:5173 through adb reverse
```

`NOOK_URL` points the app at another home. It is written into the app when
`cap sync` runs, so sync again after you change it. A debug build lets Chrome
inspect the page: open `chrome://inspect` on the computer.

## Put it on a phone by hand

```sh
npm run android:apk   # android/app/build/outputs/apk/sideload/app-sideload.apk
```

This is the release build against the home site, signed with this computer's
debug key. Copy it to the phone and open it, or run `adb install` on it. The
version from Google Play has another key, so take this one off the phone
before you install that one.

## Send it to Google Play

1. Make an upload key, once. Keep the file and its password safe, and outside
   git:

   ```sh
   keytool -genkeypair -v -keystore android/nook-upload.jks -alias upload \
     -keyalg RSA -keysize 4096 -validity 10000
   ```

2. Write `android/keystore.properties` (git ignores it):

   ```properties
   storeFile=nook-upload.jks
   storePassword=...
   keyAlias=upload
   keyPassword=...
   ```

3. Build the bundle. Its version is the one in `package.json`: 0.3.23 is
   version code 323, so raise the version before each upload.

   ```sh
   npm run android:release   # android/app/build/outputs/bundle/release/app-release.aab
   ```

4. In the Play Console, make the app with the package name `app.nook`, turn on
   Play App Signing, and upload the `.aab` to the internal testing track first.

5. Let invite links open in the app: copy the SHA-256 fingerprint of the app
   signing key from Play Console, Test and release, App integrity, and put it
   in `public/.well-known/assetlinks.json` on the site:

   ```json
   [{
     "relation": ["delegate_permission/common.handle_all_urls"],
     "target": { "namespace": "android_app", "package_name": "app.nook",
                 "sha256_cert_fingerprints": ["AA:BB:..."] }
   }]
   ```

   It has to be served from `https://nookchat.app/.well-known/assetlinks.json`
   and the `www` host with no redirect.

The Play Console asks what the app does with the microphone, the camera and
its foreground service. The microphone and the camera are for voice and video
in channels and calls. The foreground service (type `microphone`) keeps a call
going while the app is in the background, and shows a notification while it
runs.

## What it cannot do yet

- **Notifications while the app is closed.** A WebView has no web push, and
  Android freezes an app about a minute after it is put away, unless it is in
  a call. Notifications at any time need Firebase Cloud Messaging and a
  service that sends to it for the Nook servers.
- **Share a screen.** A WebView has no `getDisplayMedia`, as Chrome on a phone
  has none. It needs a plugin around Android's MediaProjection.
