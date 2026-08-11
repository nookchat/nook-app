# Cathode

**[cathode.video](https://cathode.video)**

Peer to peer screen share with audio. The only server is the static webserver
that sends the page.

Cathode opens on the sharing page. There is no welcome screen: pick a window, get
a link, send it. Anybody who opens that link is watching within seconds, with no
button to press. The picture, the sound and the chat all travel straight from one
browser to the other. No media server sees them, and nothing is recorded.

A browser opens the screen picker for a real click and for nothing else, so the
one click on **Choose what to share** is the least that can be asked for.
Everything around it, the quality preset and the frame rate, is already set
before that click, and the link appears the moment the source is picked.

## A space

Cathode is a place now, not a broadcast. A **space** is a code. Inside it are
**channels**, and a screen share is something that happens *in* a channel rather
than the reason the room exists.

```
┌──────────┬────────────────────────────────┐
│ Channels │ #general                       │
│ # general│ ┌────────────────────────────┐ │
│ # dev    │ │ whoever is sharing, if any │ │
│          │ └────────────────────────────┘ │
│ People   │ chat                           │
│ ● Ada    │                                │
│ ● Grace  │ [say something]                │
│ [Share]  │                                │
│ invite   │                                │
└──────────┴────────────────────────────────┘
```

**There is no host.** Everybody in a space is a peer. On arrival you join a mesh:
one data channel to every other member, and chat gossips across it. The space
carries on whether or not anyone is sharing, which is the whole difference
between a room and a broadcast.

Two kinds of connection live side by side, deliberately kept apart:

| Connection | Between            | Carries       | Negotiated                       |
| ---------- | ------------------ | ------------- | -------------------------------- |
| mesh       | every pair         | chat          | once, and never renegotiated     |
| share      | sharer to watcher  | video and audio | by the sharer, always the offerer |

Keeping them apart costs one extra handshake per pair while video runs, and buys
the absence of every glare and renegotiation problem a single shared connection
would have brought. **Who offers is decided by comparing peer ids**, which is a
total order both sides can compute, so two peers never call each other at once.

Opening the app shows the spaces you have been in, read from this device. A link
drops you straight into one. A reload keeps you where you were.

## Watching
## Sharing

A room is a code, written the way Windows wrote a product key:

```
https://cathode.video/#K7M2X-9QPT4-VB2WN-P8ZQ3-MHRF6
```

That is not only for looks. It uses Crockford's base32 alphabet, which leaves out
I, L, O and U, so no letter can be misread as a digit and nothing in it spells
anything. Twenty five symbols at five bits each is **125 bits of key**, the same
order as the 128 bits of base64url it replaced: a code you can read down a phone
should not be a code that is easier to guess. It is read back however it was
typed, in any case, with or without hyphens or spaces, folding `O` to `0` and
`I` and `L` to `1`.

The code **is** the key. It derives the relay topic and the AES-GCM key, and it
sits after the `#`, so it never reaches the webserver.

**The address bar carries the room.** Once a stream starts the URL becomes the
share link, so it can be copied straight out of the address bar rather than only
from the panel. That creates one trap, which `npm run test:url` guards: reloading
the host page reads that fragment back, and without care the host would become a
viewer of a room that died with the reload. The tab remembers what it was
hosting, so a reload lands back on the picker with the dead room cleared away.

Copy the link, or press the QR button and let somebody point a phone camera at
it. The QR encoder is in `src/ui/qr.ts`: byte mode, error correction level M,
versions 1 to 10, which carries 213 bytes and therefore any Cathode link.

Correctness there is not a matter of taste, so `npm run test:qr` renders every
version and reads it back with the QR decoder built into Chrome, including both
sides of every version boundary. The end to end run does the same for the real
link on screen.

## Look

Five skins, because not everybody wants the joke:

| Theme          | What it is                                        |
| -------------- | ------------------------------------------------- |
| **Windows XP** | Luna blue, beige and bevels. The default          |
| WinAmp         | Black, grey, and a green display that glows       |
| Discord        | Dark, blurple, rounded                            |
| Skype          | White with the old bright blue                    |
| Plain          | Neutral, and it follows your system light or dark |

The picker sits on the status bar, always reachable, and the choice is kept in
this browser.

**Every visual decision reads from a token**, so a theme is a block of token
values and nothing else. That is why five skins this different need only one set
of structural rules: the same 700 lines of layout carry all of them. If a rule
ever needs a `[data-theme]` selector, the thing it styles wants a token instead.

The default is dressed as **Windows XP**, Luna blue. Not a page with a header on it: a
window on a desktop, because that is what software looked like before everything
became a website.

| Piece            | How                                                                  |
| ---------------- | -------------------------------------------------------------------- |
| Title bar        | The Luna gradient, rounded top corners, bold white text with a shadow |
| Caption buttons  | Blue minimise and maximise, red close, all three doing real work      |
| Window body      | `#ece9d8`, the face colour of every XP dialog, inside a blue frame    |
| Buttons          | Beveled, 3 px corners, and they glow amber under the pointer          |
| Fields           | Sunken white with the `#7f9db9` inner line                            |
| Group boxes      | One grey line with a white line etched under it                       |
| Preset list      | A list box, selection in `#316ac5` with white text                    |
| The plan readout | Tooltip yellow, `#ffffe1`, with a hairline black border               |
| Level meters     | The segmented green progress bar, the most XP thing there is          |
| Status bar       | Sunken panels along the bottom of the window                          |
| Notifications    | Balloon tips in the bottom corner                                     |
| Desktop          | Bliss, near enough: sky, two clouds, and a green hill in CSS          |
| Type             | Tahoma, falling back to Verdana                                       |

**All three caption buttons do something.** A decorative control that does
nothing is worse than no control at all:

| Button    | On the host                                    | On a viewer            |
| --------- | ---------------------------------------------- | ---------------------- |
| Minimise  | Hides the panel, gives the window to the picture | Cycles fit, fill, 1:1 |
| Maximise  | Takes the picture fullscreen                   | Same                   |
| Close     | Stops the stream, back to the picker           | Leaves, back to the picker |

This commits to one look. Windows XP had no dark mode, so neither does Cathode, and
every colour is painted explicitly rather than inherited from the host. The old
top bar is gone: the title bar carries the name and the live state, and the
status bar carries what is happening, the relay count, and the clock.

Icons are stroked outlines on a 24 unit grid in `src/ui/icons.ts`, drawn in the
current text colour so one icon works on a button and on a dark video overlay.

The app has one screen with two states. Idle shows the empty stage with the
picker prompt, and the quality panel beside it, so the preset is chosen before
anything goes out. Live swaps the stage for the preview and the panel for the
link, the viewers, the audio, and the session. Stopping goes back to idle with a
summary of the stream that just ended, never to a welcome page.

## Access control

Anyone holding the link can watch. Two host controls make that safe:

- **Approve each viewer**, under Advanced. The host confirms every arrival
  before Cathode sends an offer.
- **New link**, which rotates the secret. Every old link goes dead at once.
- **Remove**, which drops one viewer and tells them why.

## Layout

```
src/
  main.ts             route to host or viewer from the URL fragment
  chat.ts             names, and the silly ones people get by default
  store/
    identity.ts       the key pair that makes you you, kept on the device
    log.ts            signed, immutable events and what they add up to
    db.ts             IndexedDB, which is why it is there tomorrow
    room-chat.ts      one room: the log, the store, and the wire
  net/uplink.ts       how much upload Cathode may use, guessed then measured
  room.ts             secret, roomId, roomKey, link build and parse
  settings.ts         host preferences, kept in localStorage
  diagnostics.ts      what this browser can do, in plain words
  signal/
    transport.ts      the transport interface and the retry backoff
    mqtt.ts           MQTT 3.1.1 quality of service 0 over WSS, written by hand
    nostr.ts          ephemeral Nostr events over WSS
    envelope.ts       AES-GCM seal and open, replay guard
    bus.ts            fan out to every transport, de-duplicate what returns
  rtc/
    config.ts         ICE servers and the empty TURN slot
    hardware.ts       which codecs this machine can encode on the GPU
    host-peer.ts      one connection per viewer, host always offers
    viewer-peer.ts    the viewer only ever answers
    quality.ts        presets, bitrate ladder, budget, hints, codec preference
    stats.ts          getStats reduced to numbers a person can act on
  media/
    capture.ts        getDisplayMedia and the microphone, with clear errors
    mixer.ts          WebAudio mix of screen audio and microphone into one track
  ui/
    shell.ts          the XP window: title bar, caption buttons, status bar
    icons.ts          the stroked icon set
    themes.ts         the five skins and where the choice is kept
    chat-panel.ts     the conversation, drawn as nodes and never as HTML
    qr.ts             a QR encoder, byte mode, level M, versions 1 to 10
    host-view.ts      link, viewer list, quality, audio, session
    viewer-view.ts    join, connect, watch, and every failure message
    video-surface.ts  fit, fill, and one to one with zoom and pan
    dom.ts toast.ts   small helpers, no framework
test/
  e2e.mjs             host and viewer, end to end, 27 checks
  uplink.mjs          the upload estimator, against made up statistics
  encoder-check.mjs   codec by codec: resolution held, and encode cost
  cpu-check.mjs       processor cost per codec, the real GPU question
  codec-fallback.mjs  a viewer without the hardware codec still sees it
  qr-check.mjs        every QR version, decoded back by Chrome
  url-check.mjs       the code format, and a host reload staying a host
  persist-check.mjs   history outliving the host, and forgeries refused
  theme-shots.mjs     one screenshot per skin
  mesh.mjs            N viewers against one host
  relay-probe.mjs     which public relays really carry a handshake
  repro.mjs           named failure cases: skew, delay, reload
  debug.mjs           prints what both pages see, for a stuck room
  relaycheck.mjs      the relays each side actually has open
  shots.mjs           screenshots of both themes
```

## When a viewer is stuck

The waiting screen names the cause instead of spinning:

| What the viewer sees            | What it means                                   |
| ------------------------------- | ----------------------------------------------- |
| Cathode cannot reach a relay       | This network blocks the signal relays           |
| This link is not complete       | Traffic is arriving but the key does not fit, so the link was cut short |
| The host is not sharing         | The relays work and nobody is streaming here    |

## Keyboard, on the video

| Key     | Action                          |
| ------- | ------------------------------- |
| `F`     | Fullscreen                      |
| `M`     | Mute                            |
| `Z`     | Cycle fit, fill, actual size    |
| `0`     | Reset the zoom                  |
| `+` `-` | Zoom in and out                 |

Double click switches between fit and actual size. Control plus the wheel, or a
trackpad pinch, zooms anywhere.
