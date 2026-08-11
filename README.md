# Beam

Peer to peer screen share with audio. The only server is the static webserver
that sends the page.

One person clicks **Share my screen** and gets a link. Anybody who opens that
link watches live. The picture and the sound travel straight from one browser to
the other. No media server sees them, and nothing is recorded.

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

| Preset                  | Size   | Rate   | Use it for                                            |
| ----------------------- | ------ | ------ | ----------------------------------------------------- |
| **Code and documents**  | 1080p  | 15 fps | An editor, a terminal, a spreadsheet, a PDF           |
| Slides and walkthroughs | 1080p  | 24 fps | A presentation, a design review, a tour of an app     |
| Video and motion        | 1080p  | 30 fps | A film, a game, an animation, a call                  |
| Maximum detail          | source | 30 fps | Photo work, drawings, a 4K display                    |
| Slow connection         | 720p   | 10 fps | Hotel wifi, a phone hotspot, many viewers             |

**Code and documents is the default**, at about 1.2 Mb/s for a 1080p screen. A
screen share is read, not admired. A smaller, more compressed picture starts
faster, stays sharp on text, and leaves room for more viewers. Everything is
adjustable while the stream runs, under Fine tuning: resolution from source size
down to 540p, frame rate from 5 to 60, the upload budget, the viewer limit, and
the codec. Changing any of them switches the preset to Custom.

The choices are stored in this browser, so the next stream starts the same way.

Under the presets:

| Control                 | Text presets          | Video preset         |
| ----------------------- | --------------------- | -------------------- |
| `contentHint`           | `detail`              | `motion`             |
| `degradationPreference` | `maintain-resolution` | `maintain-framerate` |
| Codec order             | VP9, AV1, H264, VP8   | VP9, H264, AV1, VP8  |

Ideal bitrate by source size at 30 fps, before the preset scale, the frame rate,
and the budget all take their cut:

| Resolution | Text     | Video     |
| ---------- | -------- | --------- |
| 540p       | 0.7 Mb/s | 1.1 Mb/s  |
| 720p       | 1.2 Mb/s | 2.0 Mb/s  |
| 1080p      | 2.5 Mb/s | 4.0 Mb/s  |
| 1440p      | 4.0 Mb/s | 6.0 Mb/s  |
| 2160p      | 6.0 Mb/s | 10.0 Mb/s |

### The mesh limit

The host encodes and sends the picture once per viewer. Ten viewers at 2.5 Mb/s
need 25 Mb/s of upload, which most home connections do not have. Beam therefore:

- divides the upload budget across the connected viewers and caps each sender,
- halves the sent resolution above six viewers,
- reads `getStats` every two seconds and lowers the real budget by 20 percent
  when the viewers report more than 3 percent packet loss for two samples,
- walks the budget back up when the loss clears for 15 seconds,
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
    host-peer.ts      one connection per viewer, host always offers
    viewer-peer.ts    the viewer only ever answers
    quality.ts        presets, bitrate ladder, budget, hints, codec preference
    stats.ts          getStats reduced to numbers a person can act on
  media/
    capture.ts        getDisplayMedia and the microphone, with clear errors
    mixer.ts          WebAudio mix of screen audio and microphone into one track
  ui/
    landing.ts        the first screen and the browser support table
    host-view.ts      link, viewer list, quality, audio, session
    viewer-view.ts    join, connect, watch, and every failure message
    video-surface.ts  fit, fill, and one to one with zoom and pan
    dom.ts toast.ts   small helpers, no framework
test/
  e2e.mjs             host and viewer, end to end, 22 checks
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
