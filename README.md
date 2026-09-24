# Cathode

**[cathode.video](https://cathode.video)**

Chat, voice and screen share, in spaces that live on Cathode servers. Anybody
can run a server from the Docker image in `server/`, and a few people can join
theirs into a cluster, so a space keeps going when one of them is down.
Everything is encrypted on the device that wrote it: a server keeps and passes
on what it cannot read.

## A space

A **space** is a code. Inside it are text channels, voice channels, and the
people in it. A screen is shared from a voice channel, the way every chat app
with voice does it.

```
┌────┬──────────────┬──────────────────────────────┬──────────┐
│ ⌂  │ Space name ▾ │ # general          ⌕   ☺☺    │ Here — 3 │
│ US │ # general    │ ┌──────────────────────────┐ │ ● Ada    │
│ +  │ # dev        │ │ a shared screen, if any  │ │ ● Grace  │
│    │ 🔈 lounge    │ └──────────────────────────┘ │ ● Linus  │
│    │   Ada  LIVE  │ chat                         │          │
│    │ [mic][⧉][✕]  │                              │          │
│    │ You      ⚙   │ [say something]              │          │
└────┴──────────────┴──────────────────────────────┴──────────┘
```

- **The rail** on the left has Home and one tile per space. A tile with unread
  messages has a mark, and a mention has a count.
- **Home** has your direct messages from every space, the way Discord does it.
  A direct message is still kept in the log of the space where you met, sealed
  so only the two of you can read it.
- **The space menu**, behind the space name, has Invite people, Settings, and
  Leave space.
- **Search** is an icon beside the people icon, and opens into a box.
- **Voice**: click a voice channel to join it. The voice bar has the
  microphone, Share screen, and Leave. Somebody who is sharing has a LIVE badge
  in the voice channel, and a click on it watches them.
- **Watching** is a choice. A share is offered in the strip above the
  conversation, and nothing is on your screen until you pick it. Pick two, and
  the stage splits. Close, or `Esc`, takes them all off.

Every space you are in is connected at once, over one WebSocket per server, so
a direct message or a mention in any of them reaches you wherever you are.

## Where things are kept

| What | Where |
| --- | --- |
| Messages, channels, roles, reactions | Postgres on the server, and on every server of its cluster |
| Your list of spaces and read marks | The server, in one record per person, sealed with a key made from your identity |
| Who is here | The server holds it in memory, and says when it changes |
| Picture and sound | Through the server's TURN relay, encrypted with DTLS-SRTP |
| Your identity key | This device only. It signs everything you write |
| Your server addresses and preferences | This device only |

Nothing about a space is written to IndexedDB or local storage. A second device
with the same identity (Settings, Link another device) finds all of your
spaces on the server.

Everything is sealed with AES-GCM under a key made from the space code (and its
password, if it has one) before it leaves the browser. Every event is signed
by its writer, and every device checks each signature, so a server can neither
read a message nor forge one. See
[Encryption in server/README.md](server/README.md#encryption) for exactly what
a server can and cannot see.

## Servers

The page and the server are deployed apart. The page stays on Vercel, or on
any static host, and **it comes with no server**. Each person adds their own:

- **Somebody new** is asked for a server on the home page, in place of New
  space, with a link to the guide for running one.
- **An invite names its server**, so anybody can join a space they are sent
  without adding a server at all.
- **A server is seen only by the people you send an invite to.** Joining
  somebody's space does not make their server the place your own spaces go.

In the app, **Settings, Servers** shows your servers, whether each is up, and
the other servers of its cluster. Under **From invites** are the servers of
spaces you joined. **Use for new spaces** picks where new spaces go.

`VITE_CATHODE_SERVER`, set when the page is built, gives every visitor a
server. It is for development, where the tests use it. Leave it unset on a
public page.

To run your own, follow [docs/self-hosting.md](docs/self-hosting.md). It takes
one `docker compose up`. `server/README.md` has every setting and the API.

**A cluster.** Several servers that name each other in `CATHODE_PEERS` and share
a `CATHODE_CLUSTER_SECRET` keep every space on all of them. When the one a page
is talking to goes down, the page moves to the next without anybody doing
anything, and the server that was down catches up when it comes back.

## Invites

A space is a code, written the way Windows wrote a product key. The link names
the space's servers after an `@`:

```
https://cathode.video/#K7M2-9QPT-VB2W@cathode.example.org,cathode.friend.net
```

The code uses Crockford's base32 alphabet, which leaves out I, L, O and U, so
no letter can be misread as a digit. It is read back however it was typed, in
any case, with or without hyphens. The code is the key, and it sits after the
`#`, so it never reaches the webserver that sends the page.

**Invite people**, in the space menu, shows the link, a Copy button, and a QR
code. The QR encoder is in `src/ui/qr.ts`: byte mode, error correction level
M, versions 1 to 10. `npm run test:qr` renders every version and reads it back
with the QR decoder built into Chrome.

## Look

Dark, and built the way people already know a chat app: a rail of spaces down
the left, the channels beside it, the conversation in the middle, and who is
here on the right.

- **Floating panes.** The canvas is near black, and the channels, the
  conversation, and the members are separate rounded panes on it.
- **The beam.** The one accent is a cyan that runs into a periwinkle, the
  colour of a cathode ray tube that lights up. It is on what you press most,
  on the channel you are in, and on the space you are in.
- **Live is red.** A person who is sharing, and the strip of shares above the
  conversation, use the same red.

**Every value the look is made of lives in one block at the top of
`src/styles.css`,** and nothing below that block names a colour.
`test/polish-check.mjs` checks that every text colour clears 4.5 to 1 on every
surface.

`node test/tour.mjs` puts three people in a space, fills it, shares a screen,
and writes screenshots at desktop and phone width to `test-output/tour/`.

## Speed

Measured with `node test/speed.mjs` on a space with 3000 messages:

| What | Time |
| --- | --- |
| Open the space | 85 ms |
| Switch channel | 63 ms |
| A sent message on screen | 26 ms |

Every signature is checked on a pool of Web Workers, so the page never waits
on it. A channel draws its newest few screens, and a scroll up draws more.

`node test/server-bench.mjs` on a space of 50,000 lines:

| What | Time |
| --- | --- |
| Catch up on the last 10 lines | 2.2 ms |
| Read all 50 MB of it, page by page | 520 ms |
| Append one message | 3.5 ms |
| A signal between two sockets | 0.1 ms |

Nothing polls. The page says who it is when that changes, the server says when
somebody arrives or goes, and the only timer is the server's 30 second ping.

## Development

```
npm install
npm run stack        # Postgres in Docker, a server on 8787, and the page on 5173
node test/e2e.mjs    # any check, against the stack
```

## Layout

```
src/
  main.ts             start every space, then show Home, a space, or Settings
  backend.ts          which server, and checking one answers
  room.ts             the code, the room id, the key, and the link
  space/
    registry.ts       every space you are in, started at once
    runtime.ts        one space: its log, its connection, who is here
  net/
    connection.ts     one WebSocket per server, carrying every space on it
    cluster.ts        the servers of a cluster, and moving to the next
    server-api.ts     sealing a line, link cards, GIF search, health
    mesh.ts           who is here, from what the server passes on
    voice.ts          voice channels, mic.ts denoise.ts talking.ts around them
    uplink.ts         how much upload Cathode may use, guessed then measured
  signal/
    bus.ts            signals in and out of a space, de-duplicated
    envelope.ts       AES-GCM seal and open, replay guard
    transport.ts      the transport interface and the retry backoff
  store/
    identity.ts       the key pair that makes you you, kept on the device
    log.ts            signed, immutable events and what they add up to
    room-chat.ts      one room's conversation, on top of the log
    server-spaces.ts  your sealed record of spaces on each server
    verify-pool.ts    signature checks on Web Workers
    gifs.ts           GIF search: your own key, or the server's
  rtc/                screen share connections, codecs, quality, stats
  media/              the screen picker, the microphone, and the mix
  ui/
    home-view.ts      Home: direct messages from every space
    space-view.ts     a space: channels, voice, sharing, search, people
    space-list.ts     the home page: your spaces, making and joining one
    chat-panel.ts     the conversation, drawn as nodes and never as HTML
    settings-view.ts  profile, identity, servers, this space, preferences
    space-rail.ts     the rail of spaces down the left edge
    video-surface.ts  fit, fill, and one to one with zoom and pan
    qr.ts             a QR encoder, byte mode, level M, versions 1 to 10
server/               the server and its Docker image; see server/README.md
docs/
  self-hosting.md     run your own server, or a cluster with friends
test/
  stack.mjs           Postgres, a server and the page, for every check below
  e2e.mjs             two people, a share, chat, and the stage at every size
  tour.mjs            screenshots of every screen, filled with a conversation
  server-check.mjs    a space on a server, and nothing kept in the browser
  tamper-check.mjs    what the server cannot read, and forged lines refused
  own-server-check.mjs  a page with no server: adding yours, joining from an invite
  cluster-check.mjs   two servers, two databases, one cluster
  failover-check.mjs  people carrying on when their server dies
  chat-check.mjs      typing, unread, mentions, search, threads
  extras-check.mjs    markdown, slash commands, direct messages, avatars
  polish-check.mjs    redraw cost, thread list, search filters, contrast
  emoji-check.mjs     the picker, and what one emoji is made of
  board-check.mjs     the soundboard, GIF search, and pictures
  leave-check.mjs     leaving, deleting, and one code meaning one room
  roles-check.mjs     who may do what, and what a member may not
  agree-check.mjs     three browsers typing at once, ending up identical
  converge-check.mjs  the same events shuffled two hundred ways
  rejoin-check.mjs    one row per person, however many devices they use
  live-check.mjs      two people sharing at once, and picking between them
  voice-check.mjs     voice channels, who is talking, and being moved
  url-check.mjs       the code format, and a reload staying in the space
  speed.mjs           how long opening, switching and sending take
  server-bench.mjs    how fast the server reads, writes and passes on
  encoder-check.mjs   codec by codec: resolution held, and encode cost
  cpu-check.mjs       processor cost per codec
  codec-fallback.mjs  a viewer without the hardware codec still sees it
  qr-check.mjs        every QR version, decoded back by Chrome
  denoise-check.mjs   the neural noise removal, on real noise
  uplink.mjs          the upload estimator, against made up statistics
```

## Keyboard, on a shared screen

| Key | Action |
| --- | --- |
| `F` | Fullscreen |
| `M` | Mute |
| `Z` | Cycle fit, fill, actual size |
| `0` | Reset the zoom |
| `+` `-` | Zoom in and out |
| `Esc` | Take every share off your screen. In fullscreen it also leaves fullscreen |

Double click switches between fit and actual size. Control plus the wheel, or a
trackpad pinch, zooms anywhere.

## Keyboard, anywhere in a space

| Key | Action |
| --- | --- |
| `Ctrl`/`Cmd`+`Shift`+`M` | Mute or unmute your microphone in voice |
| `Ctrl`/`Cmd`+`K` | Search this space |
| `Ctrl`/`Cmd`+`1`-`9` | Jump to a channel, in the order of the rail |
