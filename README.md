# Cathode

**[cathode.video](https://cathode.video)**

Screen share, voice and chat. A space runs peer to peer, where the only server
is the static webserver that sends the page, or on a Cathode server that you
run in Docker. See [Where a space runs](#where-a-space-runs).

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

## Where a space runs

Whoever makes a space picks one of two backends. The choice belongs to the
space, and it goes out in the invite, so everybody in a space talks in the
same place.

| | Peer to peer | Server |
| --- | --- | --- |
| Handshakes | public MQTT brokers and Nostr relays | one WebSocket to the server |
| Chat | a data channel between every pair | the same WebSocket |
| History | every device, in IndexedDB | Postgres on the server, and on every server in its cluster |
| Your list of spaces, read marks | this device | the server, in a record sealed with your key |
| Picture and sound | straight between browsers | through the server's TURN relay |
| Survives | as long as one person who was in it comes back | as long as one server in its cluster is up |
| Needs running | nothing | `server/docker-compose.yml`, on one machine or several |

Both ways, everything is sealed with the key made from the space code before
it leaves the browser. A server cannot read what it carries or keeps. See
[Encryption in server/README.md](server/README.md#encryption) for exactly what
is sealed and what a server can still see.

**Several servers, one space.** A few people can each run the Docker backend
and join them into a cluster. Every space is then kept on all of them, they
sync all the time, and when one goes down the page moves to another without
anybody doing anything. See [A cluster](server/README.md#a-cluster).

**A space on a server keeps nothing in the browser.** Its history is held in
memory while it is open, read from the server each time, and never written
to IndexedDB or local storage. Your list of spaces and how far you have read
in each are kept on the server too, in one record per person that is sealed
with a key made from your identity. A second device with the same identity
(Settings, Link a device) finds all of it there.

What does stay on the device, and why:

| Kept on the device | Why |
| --- | --- |
| Your identity key | It is who you are: it signs everything you write. A server that held it could write as you |
| The addresses of your servers | The device has to know where to ask for the rest |
| Preferences: your name, sounds, quick reactions, GIF key, the rail order | They belong to this device, not to a space |

Opening a space on a server reads its whole history and checks every
signature, on a pool of Web Workers so the page never waits on it: about
100 ms for 3000 messages in a fresh tab. A space opened once is held in the
tab's memory, so going back to it is instant.

A space on a server names it after an `@` in its link:

```
https://cathode.video/#K7M2-9QPT-VB2W@cathode.example.org
```

The page and the server are deployed apart. The page stays on Vercel, or on
any static host. The server runs from the Docker image in `server/`. Set
`VITE_CATHODE_SERVER` when the page is built, and **Server** is offered and
preselected when somebody makes a space:

```
VITE_CATHODE_SERVER=https://cathode.example.org
```

On Vercel, add it under Project, Settings, Environment Variables, and deploy
again. Without it, a person can still type any server address by hand.
`server/README.md` says how to run the server.

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

Dark, and built the way people already know a chat app: a rail of spaces down
the left, the channels beside it, the conversation in the middle, and who is
here on the right. Cathode's own touch is the way it is put together and the
one colour it uses.

- **Floating panes.** The canvas is near black, and the channels, the
  conversation, and the members are separate rounded panes on it, a gap apart.
  A pane is told apart by its shade, not by a border.
- **The beam.** The one accent is a cyan that runs into a periwinkle, the
  colour of a cathode ray tube that lights up. It is on what you press most
  (Share screen, New space, Send, Copy invite), on the channel you are in,
  and on the space you are in. It glows a little. Nothing else is decorated.
- **Live is red.** A channel with a screen share in it, a person who is
  sharing, and the strip of streams above the conversation all use the same
  red.

| Piece      | How                                                                   |
| ---------- | --------------------------------------------------------------------- |
| Rail       | One tile per space with its initials, in an order that stays put        |
| Messages   | A 40 px face in the gutter, the name and time on top, runs grouped     |
| Actions    | A small floating bar at the top right of a message, icons only          |
| Composer   | One rounded box: the text, GIF, soundboard, emoji, and Send            |
| Members    | Faces with a presence dot, grouped into who is here and who is not      |
| You        | Your face, your name and the status line at the foot of the channels    |
| Phone      | One pane edge to edge, and the side panes slide in as drawers           |

**Every value the look is made of lives in one block at the top of
`src/styles.css`,** and nothing below that block names a colour.
`test/polish-check.mjs` checks that every text colour clears 4.5 to 1 on every
surface.

`node test/tour.mjs` puts three people in a space, fills it, shares a screen,
and writes screenshots at desktop and phone width to `test-output/tour/`.

## Speed

A busy space opens in well under a tenth of a second, and it stays that fast
as the space grows. Measured with `node test/speed.mjs` on a space with 3000
messages:

| What                               | Before | Now    |
| ---------------------------------- | ------ | ------ |
| Open the space                     | 371 ms | 65 ms  |
| A sent message on screen           | 56 ms  | 26 ms  |
| Elements on the page               | 28,205 | 1,815  |

Three changes made the difference:

- **A window on the conversation.** A channel draws its newest few screens,
  and a scroll up draws more. A channel with ten thousand messages costs the
  same to open as a channel with a hundred.
- **The log is sorted once.** It was sorted again on every read, a dozen times
  per redraw.
- **Formatters are made once.** A time formatter was made for every message.

Settings, the QR encoder and device linking load only when they are opened.
`vercel.json` makes the hashed files cache for a year, so a repeat visit
downloads nothing but the page.

The server keeps an index of where each line of history starts, so a read
seeks straight to it, and history goes out a page at a time, so no reply is
ever the whole room. `node test/server-bench.mjs` on a room of 50,000 lines:

| What                               | Before  | Now    |
| ---------------------------------- | ------- | ------ |
| Catch up on the last 10 lines      | 35 ms   | 1.7 ms |
| Read all of it                     | 111 ms  | 82 ms  |
| A frame across the relay           | 0.1 ms  | 0.1 ms |

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
    gifs.ts           GIF search: your own key here, or the archive's
  net/
    mesh.ts           everybody connected to everybody, and who offers to whom
    voice.ts          voice channels, mic.ts denoise.ts talking.ts around them
    uplink.ts         how much upload Cathode may use, guessed then measured
  room.ts             secret, roomId, roomKey, link build and parse
  backend.ts          peer to peer or a server, and which server
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
    soundboard.ts     twelve noises built out of oscillators, played for the room
    menu.ts           the popover behind every ellipsis
    avatar.ts         a picture, shrunk until it fits inside one event
    notify.ts         the browser's own notifications, and their honest limit
    link-device.ts    your key as a QR code, and a camera to read one
    settings-view.ts  your name, your key, your data, and this space
    shell.ts          the frame: where a screen mounts, and the status line
    space-rail.ts     the rail of spaces down the left edge
    icons.ts          the stroked icon set
    qr.ts             a QR encoder, byte mode, level M, versions 1 to 10
    video-surface.ts  fit, fill, and one to one with zoom and pan
    dom.ts toast.ts   small helpers, no framework
test/
  e2e.mjs             host and viewer, end to end, 34 checks
  tour.mjs            screenshots of every screen, filled with a conversation
  speed.mjs           how long opening, switching and sending take
  server-bench.mjs    how fast the server reads, writes and relays
  server-check.mjs    a space on a server, with no public relay and no WebRTC
  cluster-check.mjs   two servers, two databases, one cluster, one stopped
  failover-check.mjs  people carrying on through the second server when the first dies
  chat-check.mjs      typing, unread, mentions, search, threads, multi-line
  extras-check.mjs    markdown, slash commands, private messages, avatars
  polish-check.mjs    redraw cost, thread list, search filters, contrast
  emoji-check.mjs     the picker, and what one emoji is made of
  board-check.mjs     the soundboard, GIF search, and pictures out of the bubble
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
| `Esc`   | Take every stream off your screen. In fullscreen it also leaves fullscreen |

Double click switches between fit and actual size. Control plus the wheel, or a
trackpad pinch, zooms anywhere.

## Keyboard, anywhere in a space

| Key                     | Action                                     |
| ----------------------- | ------------------------------------------ |
| `Ctrl`/`Cmd`+`Shift`+`M` | Mute or unmute your microphone in voice    |
| `Ctrl`/`Cmd`+`K`        | Search this space                          |
| `Ctrl`/`Cmd`+`1`-`9`    | Jump to a channel, in the order of the rail |
