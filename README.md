# Beam

Peer to peer screen share with audio. The only server is the static webserver
that sends the page.

Beam opens on the sharing page. There is no welcome screen: pick a window, get a
link, send it. Anybody who opens that link watches live. The picture and the
sound travel straight from one browser to the other. No media server sees them,
and nothing is recorded.

A browser opens the screen picker for a real click and for nothing else, so the
one click on **Choose what to share** is the least Beam can ask for. Everything
around it, the quality preset and the frame rate, is already set before that
click, and the link appears the moment the source is picked.

## Run it

```sh
npm install
npm run dev            # http://localhost:5173
```

```sh
npm run build          # typecheck, then a static bundle in dist/
npm run preview        # serve dist/ over the network
```

Copy `dist/` to any static host. There is no backend, no database, and no
environment variable. The site works from a sub path, because the build uses a
relative base.

WebRTC needs a secure page. Use HTTPS in production. `http://localhost` counts
as secure while you develop.

## Test it

```sh
npm run test:e2e       # two real Chrome pages, real relays, real media
npm run test:mesh 10   # one host, ten viewers, prints the per viewer plan
npm run test:qr        # every QR version, decoded back by Chrome
npm run test:uplink    # the upload estimator, against made up statistics
npm run test:encoder   # which codec holds up, and what it costs to encode
npm run test:cpu       # processor cost per codec: GPU or not, measured
npm run test:fallback  # a viewer with no HEVC still gets a picture
npm run test:relays    # which public relays really carry a handshake
npm run test:repro skew    # viewer clock five minutes ahead
npm run test:repro delay   # viewer joins 100 s later, host tab hidden
npm run test:repro reload  # the host is gone, so the viewer must be told
```

The tests replace the operating system picker with a canvas stream, so they need
no screen permission and give the same result on every machine. Everything else
is real: the public relays, the encryption, the peer connection, and the codec.
Screenshots land in `test-output/`.

Set `HEADED=1` to watch a run. Set `CHROME_PATH` if Chrome is not in the usual
place.

## How a connection happens

```
host browser                 public relay                 viewer browser
     |  announce (encrypted) ----->|                            |
     |                             |<---- hello (encrypted) ----|
     |  offer + ICE  ------------->|-------------------------->  |
     |                             |<---- answer + ICE ---------|
     |                                                          |
     |=========== direct WebRTC media, DTLS-SRTP ===============|
```

The relay carries the handshake only. After the peers meet, it goes quiet and
the media never touches it.

### The link

```
https://your.site/#r=<128 bit secret, base64url>
```

The secret sits in the URL fragment, so the browser never sends it to the
webserver. From the secret Beam derives:

| Value     | How                                  | Used for                          |
| --------- | ------------------------------------ | --------------------------------- |
| `roomId`  | SHA-256 of the secret, first 128 bits | The public topic on the relay      |
| `roomKey` | HKDF-SHA256 of the secret            | AES-GCM on every signal message    |

A relay operator sees a random topic name and opaque bytes. Beam drops any
message id it has already handled, using its own clock for the expiry.

Beam never compares the clock of one machine against the clock of another. Two
computers often disagree by minutes, and an earlier version rejected every
message from a peer more than two minutes away. The room then failed with the
viewer stuck on "looking for the host". The message id guard stops a replay and
the room key stops a forgery, so the sender timestamp is information only. The
Nostr subscription carries no `since` filter for the same reason.

### The relays

Two protocols on three ports, so one blocked port does not kill a room:

| Transport | Endpoint                                        | Port |
| --------- | ----------------------------------------------- | ---- |
| MQTT      | `broker.emqx.io`                                | 8084 |
| MQTT      | `broker.hivemq.com`                             | 8884 |
| Nostr     | `nos.lol`, `relay.snort.social`, `nostr.mom`    | 443  |

A public relay can go bad without notice, and answering on port 443 proves
nothing: it can refuse the event kind, demand an account, or accept an event and
deliver it to nobody. `npm run test:relays` publishes a real event and waits to
receive it back on a second connection, which is exactly what a host and a
viewer do. Run it before changing the list, and keep at least three.

A transport never gives up. If a relay dies mid session it keeps retrying, at
first quickly and then once a minute, because a host and a viewer that share no
relay would have a room that looks connected and carries nothing.

Beam publishes to all of them and de-duplicates what comes back. One working
relay runs the room. The MQTT client is written by hand in `src/signal/mqtt.ts`,
about 150 lines of quality-of-service 0 packet work, so the browser bundle needs
no Node polyfill. The Nostr transport signs throwaway ephemeral events, which
relays pass to live subscribers and never store.

To use your own relay, add an entry to `MQTT_BROKERS` or `NOSTR_RELAYS`. Nothing
else changes.

## Quality

The host picks a preset. Beam turns it into concrete sender settings for every
viewer. Each preset names the job it is for, so nobody has to guess.

| Preset                  | Size   | Rate   | Use it for                                        |
| ----------------------- | ------ | ------ | ------------------------------------------------- |
| **Code and documents**  | 1080p  | 15 fps | An editor, a terminal, a spreadsheet, a PDF       |
| Slides and walkthroughs | 1080p  | 24 fps | A presentation, a design review, a tour of an app |
| Video and motion        | 1080p  | 30 fps | A film, an animation, a call                      |
| Games                   | 1080p  | 60 fps | A fast game, where every frame is new             |
| Maximum detail          | source | 30 fps | Photo work, drawings, a 4K display                |
| Slow connection         | 720p   | 10 fps | Hotel wifi, a phone hotspot, many viewers         |

**Code and documents is the default**, at about 1.2 Mb/s for a 1080p screen. A
screen share is read, not admired. A smaller, more compressed picture starts
faster, stays sharp on text, and leaves room for more viewers. Everything is
adjustable while the stream runs, under Fine tuning: resolution from source size
down to 540p, frame rate from 5 to 60, the upload budget, the viewer limit, and
the codec. Changing any of them switches the preset to Custom.

The choices are stored in this browser, so the next stream starts the same way.

Under the presets:

| Control                 | Text presets          | Motion presets           |
| ----------------------- | --------------------- | ------------------------ |
| `contentHint`           | `detail`              | `motion`                 |
| `degradationPreference` | `maintain-resolution` | `maintain-framerate`     |
| Codec order             | VP9, AV1, H264, VP8   | hardware first, then VP9 |

Ideal bitrate by source size at 30 fps, before the preset scale, the frame rate,
and the budget all take their cut:

| Resolution | Text     | Video     |
| ---------- | -------- | --------- |
| 540p       | 0.7 Mb/s | 1.1 Mb/s  |
| 720p       | 1.2 Mb/s | 2.0 Mb/s  |
| 1080p      | 2.5 Mb/s | 4.0 Mb/s  |
| 1440p      | 4.0 Mb/s | 6.0 Mb/s  |
| 2160p      | 6.0 Mb/s | 10.0 Mb/s |

### The upload budget

Beam runs no upload speed test, because a speed test needs a server that accepts
an upload and Beam has none. A static host refuses a POST, and pushing megabytes
through the free public signal relays would get the room rate limited, which is
a poor trade for a number that can be learned honestly. So `src/net/uplink.ts`
does two things instead:

1. **On load it reads what the browser already knows.** The Network Information
   API reports data saver, a coarse connection class, and whether the link is
   cellular. That sets a careful starting budget, labelled `estimated`.
2. **Once a viewer connects it measures.** Real bytes travel the real path, and
   the bandwidth estimator inside WebRTC reports what that path will carry.
   Packet loss reported back by the viewers measures the same thing from the
   other end. The budget converges on that, and the label changes to `measured`.

| Hint                     | Starting budget |
| ------------------------ | --------------- |
| Data saver on            | 1.5 Mb/s        |
| 2g or slower             | 0.8 Mb/s        |
| 3g                       | 2.5 Mb/s        |
| Cellular                 | 4.0 Mb/s        |
| Anything else, or no API | 6.0 Mb/s        |

The numeric `downlink` figure is deliberately ignored. It is built from recent
traffic, rounded and capped, and on a freshly opened page it often reads far
below the truth: trusting it made Beam open at 870 kb/s on a fast link and warn
that the budget was holding the quality down.

The estimate only reaches upward while the encoders actually want more than the
current budget. There is no point discovering a spare 20 Mb/s to carry a
1.2 Mb/s document, so a quiet stream never probes.

The budget is automatic until you touch the slider, and manual from then on. The
label always says which mode it is in and where the figure came from.

### Games, and encoding on the GPU

WebRTC gives a page no way to demand a hardware encoder. The browser decides,
from the codec, the resolution, and the platform. What a page *can* do is find
out which codecs have a hardware encoder and ask for those first, which is what
`src/rtc/hardware.ts` does on load, from two sources that both refuse to guess:

- WebCodecs `isConfigSupported` with `hardwareAcceleration: 'prefer-hardware'`,
  which fails outright when no hardware encoder can serve the config,
- Media Capabilities `encodingInfo`, whose `powerEfficient` flag is the platform
  saying the work will not land on the processor.

**Do not trust `totalEncodeTime` for this.** It measures the wall clock of the
encode call, and a hardware encoder still takes time to hand a frame back, so
hardware and software can report the same milliseconds at very different cost.
The honest measure is processor seconds burned per wall clock second, and
`npm run test:cpu` measures exactly that: the host runs in its own browser, idle
first and then sharing, and the difference is what encoding costs.

Measured on an Apple M4 Pro, headed Chrome, one viewer, 1920x1080 at 60 frames:

| Codec    | Held      | Rate   | Encoding costs | Where       |
| -------- | --------- | ------ | -------------- | ----------- |
| **H265** | 1920x1080 | 60 fps | **0.44 cores** | GPU         |
| VP9      | 1920x1080 | 53 fps | 0.83 cores     | processor   |
| H264     | 1280x720  | 61 fps | 0.39 cores     | processor   |
| AV1      | 1920x1080 | 60 fps | 2.05 cores     | processor   |

The same picture for less than half the processor. HEVC was the only codec on
that machine with a hardware encoder, and note that H264 is **not** the hardware
shortcut it is usually assumed to be here: it looks cheap only because it gave
up 1080p and encoded 720p instead.

So Beam asks for the hardware codec first, but only on moving pictures. A
hardware encoder is tuned for camera video and smears small text, so documents
stay on VP9 where the screen content tools live and the bill is small anyway.

A viewer that cannot decode the hardware codec loses nothing. Codec preferences
only order the offer; the answer decides. `npm run test:fallback` proves it with
a viewer launched without any HEVC decoder: the stream falls back to VP9, keeps
playing, and the badge stops claiming the GPU.

The viewer row names all of this: the codec, whether it is running **on GPU**,
and milliseconds of processor time per encoded frame. Compare that last figure
against the frame interval, 16.7 ms at 60 fps. It turns amber past 45 percent
and red past 70, the point where the machine rather than the network is holding
the stream back.

Decoding is cheap on every codec, 0.9 to 1.4 ms per frame, and the video element
is composited by the GPU. Watching a game was never the problem.

Chrome reports neither `encoderImplementation` nor `powerEfficientEncoder` in
these statistics, which is why Beam reads hardware support from the probe above
rather than from the live stream.

### The mesh limit

The host encodes and sends the picture once per viewer. Ten viewers at 2.5 Mb/s
need 25 Mb/s of upload, which most home connections do not have. Beam therefore:

- divides the upload budget across the connected viewers and caps each sender,
- halves the sent resolution above six viewers,
- reads `getStats` every two seconds and folds it into the uplink estimate
  above, which pulls the budget down on loss and lifts it on spare capacity,
- enforces a viewer limit, 10 by default.

Above about ten viewers a mesh stops being the right shape. The next step would
be a viewer relay tree, where early viewers forward to later ones. Measure with
`npm run test:mesh` before you build it.

## What Beam does not do

- **No TURN relay.** Beam ships public STUN only, which keeps the promise of no
  server. About one connection in eight fails on symmetric NAT or a strict
  firewall, and Beam says so plainly instead of spinning. To add TURN later, put
  your credentials in `TURN_SERVERS` in `src/rtc/config.ts`. Nothing else
  changes. Use short lived credentials: a key in a static site is a public key.
- **No screen share on iOS.** Apple gives no browser that permission. An iPhone
  or an iPad can watch, and Beam tells the user this on arrival.
- **No system audio outside Chromium.** Firefox and Safari do not hand over the
  audio of a shared screen. The microphone still works everywhere.
- **No recording, no accounts, no history.** Nothing is stored anywhere.

## Sharing the link

Copy it, or press the QR button and let somebody point a phone camera at the
code. The QR encoder is in `src/ui/qr.ts`: byte mode, error correction level M,
versions 1 to 10, which carries 213 bytes and therefore any Beam link.

Correctness there is not a matter of taste, so `npm run test:qr` renders every
version and reads it back with the QR decoder built into Chrome, including both
sides of every version boundary. The end to end run does the same for the real
link on screen.

## Look

Beam is dressed as **Windows XP**, Luna blue. Not a page with a header on it: a
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

This commits to one look. Windows XP had no dark mode, so neither does Beam, and
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
  before Beam sends an offer.
- **New link**, which rotates the secret. Every old link goes dead at once.
- **Remove**, which drops one viewer and tells them why.

## Layout

```
src/
  main.ts             route to host or viewer from the URL fragment
  net/uplink.ts       how much upload Beam may use, guessed then measured
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
    icons.ts          the stroked icon set and the brand mark
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
| Beam cannot reach a relay       | This network blocks the signal relays           |
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
