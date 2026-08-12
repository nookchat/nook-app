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

One look. Dark, quiet, and out of the way, because the interesting thing on the
screen is what people are saying to each other.

There were five skins here once, including a full Windows XP costume with a
wallpaper, a window frame and three caption buttons. It was a good joke and it
cost a set of layout rules that had to hold up under bevels and under flat
design at the same time, plus a picker on the status bar for a decision nobody
makes twice. It is one palette now, and the app fills the window.

**Every value the look is made of lives in one block at the top of
`src/styles.css`,** and nothing below that block names a colour. That was the
rule when there were five of them and it is still the rule with one: a colour
written into a layout rule is a colour that has to be found again by hand when
the palette moves.

| Piece      | How                                                                |
| ---------- | ------------------------------------------------------------------ |
| Depth      | Four greys, from the background to the raised surfaces on top of it |
| Accent     | One blue, used about four times per screen and nowhere else         |
| Lines      | One hairline between columns, and under the header. No card borders |
| Corners    | 6 px on small things, 8 px on buttons and fields, 10 px on panels   |
| Type       | The system stack, 14 px, with 11 px capitals for section labels     |
| Selection  | Raised rather than painted: the accent does not follow you around   |
| Status bar | One quiet line: where you are, who is here, how many relays are up  |

The three columns sit flush against each other and are told apart by shade
rather than by a border each. The conversation has nothing drawn around it at
all.

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
  main.ts             open a space from the link, or show the list of them
  chat.ts             names, mentions, and the silly names people start with
  store/
    identity.ts       the key pair that makes you you, kept on the device
    log.ts            signed, immutable events and what they add up to
    db.ts             IndexedDB, which is why it is there tomorrow
    room-chat.ts      one room: the log, the store, and the wire
    compact.ts        keeping the log small without losing what counted
    archive.ts        the optional always awake peer, and what it is not trusted with
    transfer.ts       export and import, verified event by event
  net/
    mesh.ts           everybody connected to everybody, and who offers to whom
    voice.ts          voice channels, mic.ts denoise.ts talking.ts around them
    uplink.ts         how much upload Cathode may use, guessed then measured
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
    space-view.ts     the room: channels, people, threads, search, sharing
    space-list.ts     the opening screen, and leaving a space
    chat-panel.ts     the conversation, drawn as nodes and never as HTML
    emoji.ts          the set, the picker, and what a quick reaction is
    menu.ts           the popover behind every ellipsis
    avatar.ts         a picture, shrunk until it fits inside one event
    notify.ts         the browser's own notifications, and their honest limit
    link-device.ts    your key as a QR code, and a camera to read one
    settings-view.ts  your name, your key, your data, and this space
    shell.ts          the frame: where a screen mounts, and the status bar
    icons.ts          the stroked icon set
    qr.ts             a QR encoder, byte mode, level M, versions 1 to 10
    video-surface.ts  fit, fill, and one to one with zoom and pan
    dom.ts toast.ts   small helpers, no framework
test/
  e2e.mjs             host and viewer, end to end, 34 checks
  chat-check.mjs      typing, unread, mentions, search, threads, multi-line
  extras-check.mjs    markdown, slash commands, private messages, avatars
  polish-check.mjs    redraw cost, thread list, search filters, contrast
  emoji-check.mjs     the picker, and what one emoji is made of
  leave-check.mjs     leaving, deleting, and one code meaning one room
  roles-check.mjs     who may do what, and what a member may not
  agree-check.mjs     three browsers typing at once, ending up identical
  converge-check.mjs  the same events shuffled two hundred ways
  archive-check.mjs   the archive: what it keeps, and what it cannot read
  storage-check.mjs   compaction, trimming, export and import
  persist-check.mjs   history outliving the host, and forgeries refused
  rejoin-check.mjs    one row per person, however many devices they use
  live-check.mjs      two people sharing at once, and picking between them
  voice-check.mjs     voice channels, who is talking, and being moved
  url-check.mjs       the code format, and a reload staying in the space
  uplink.mjs          the upload estimator, against made up statistics
  encoder-check.mjs   codec by codec: resolution held, and encode cost
  cpu-check.mjs       processor cost per codec, the real GPU question
  codec-fallback.mjs  a viewer without the hardware codec still sees it
  qr-check.mjs        every QR version, decoded back by Chrome
  denoise-check.mjs   the neural noise removal, on real noise
  mesh.mjs            N viewers against one host
  relay-probe.mjs     which public relays really carry a handshake
  repro.mjs           named failure cases: skew, delay, reload
  debug.mjs           prints what both pages see, for a stuck room
  relaycheck.mjs      the relays each side actually has open
  shots.mjs           screenshots of the app
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
