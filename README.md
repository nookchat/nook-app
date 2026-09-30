# Nook

**[cathode.video](https://cathode.video)**

Chat, voice and screen share, in spaces that live on Nook servers. Anybody
can run a server from the Docker image in `server/`, and a few people can join
theirs into a cluster, so a space keeps going when one of them is down.
Everything is encrypted on the device that wrote it: a server keeps and passes
on what it cannot read.

## A space

A **space** is a code. Inside it are text channels, voice channels, and the
people in it. A screen is shared from a voice channel, the way every chat app
with voice does it.

```
┌─────────────────┬──────────────────────────────┬──────────┐
│ NS Space name ▾ │ # general          ⌕   ☺☺    │ Here · 3 │
│ # general       │ ┌──────────────────────────┐ │ ● Ada    │
│ # dev           │ │ a shared screen, if any  │ │ ● Grace  │
│ 🔈 lounge       │ └──────────────────────────┘ │ ● Linus  │
│   Ada  LIVE     │ chat                         │          │
│ [mic][⧉][✕]     │                              │          │
│ You      ⚙      │ [say something]              │          │
└─────────────────┴──────────────────────────────┴──────────┘
```

- **The switcher** is the space name at the top left. Press it for Home,
  every space you are in, and making or joining one, with this space's own
  actions under them: Invite people, Space settings, Leave space. A dot on it
  says there is news in another space, and a red count says somebody
  mentioned you or sent you a direct message.
- **The first visit** asks for the name people will see, and a picture if you
  want one, before anything else, on the home page or on an invite. You can
  change both in Settings.
- **Home** has your direct messages from every space, the way Discord does it.
  A direct message is still kept in the log of the space where you met, sealed
  so only the two of you can read it.
- **The space menu**, behind the space name, has Invite people, Settings, and
  Leave space.
- **Search** is an icon beside the people icon, and opens into a box. It
  comes before the actions in the channel head, such as the pinned messages.
- **Calls**: the phone in a direct conversation, or Call in somebody's menu,
  rings them wherever they are in the app. Only the two of you can be in it.
- **Voice keeps going** while you read another space, Home or Settings; the
  foot of the channels says where you are talking, with mute and leave. You
  are in one call at a time, and joining and leaving make a sound.
- **Voice**: click a voice channel to join it. The voice bar has the
  microphone, the camera, Share screen, and Leave. Somebody who is sharing has a LIVE badge
  in the voice channel, and a click on it watches them. A share that starts
  makes a sound, for whoever shares and for the others in their voice channel.
- **Channel order**: somebody whose level has Channels drags a text or voice
  channel to a new place, or uses Move up and Move down in its menu, and
  everybody sees that order. A channel made later goes at the end. Every
  device ignores an order from somebody without Channels.
- **Moving people**: somebody whose level has Move people (Admin and
  Moderator to start with) drags a person, from a voice channel or from the
  list of people, onto a voice channel, or picks one under Move to in their
  menu. Somebody in voice goes there; somebody who is not is asked to join,
  since a browser opens the microphone only on a click. Their own device
  checks the mover's level and that they may go in that channel.
- **Camera**: the camera button in the voice bar turns yours on, for the
  people in your voice channel and in a call. Each camera that is on in your
  channel is a tile in a row above the conversation, yours too, as a mirror.
  A call has a line for the camera from the start, so turning it on or off
  sets nothing up again. Leaving voice turns it off.
- **Menus and pickers stay in view**: one that would go off the window, or
  under the desktop app's title bar, is pushed back in, and one taller than
  the window scrolls (`src/ui/place.ts`).
- **Video controls** show while the pointer moves over a playing video or a
  stream, and go when it rests.
- **Files**: the clip in the box, a file dropped on the conversation, or one
  pasted in. Each is encrypted on your device with a key of its own before it
  goes up. Pictures show in the message and open full screen; videos show
  their first frame and play in place; anything else is a card with Save.
- **Watching** is a choice. A share is offered in the strip above the
  conversation, and nothing is on your screen until you pick it. Pick two, and
  the stage splits. Close, or `Esc`, takes them all off.
- **Levels** say who runs a space. It starts with Owner (who made it), Admin,
  Moderator and Member, and Settings, Levels, makes more. Each level has a
  colour, and the names of its people are in that colour everywhere in the
  space; and each has what its people may do: channels, pins, deleting
  messages, removing and moving people, levels, and the space itself. Put
  somebody on a level in Space settings, Members, which lists everybody in
  the space with their level, for whoever may change levels or remove people. You change only
  the levels below yours, and you give nobody a power you do not have. Every
  device checks each change in the log, so a button is never the rule.
- **The list of people** on the right: a click, or a right click, on somebody
  opens what you can do about them. It has the people who are here in groups
  by level, the highest level first, as Discord groups people by role. The
  people who are away are last, in one group.
- **Removing somebody** changes the key of the space, with no click. The
  code in the old invite still lets a person in, but what is written after
  the removal is sealed with a new key that only the people still in the
  space have. Somebody who joins later gets the new key from whoever is
  online, in a few seconds. See
  [Encryption in server/README.md](server/README.md#encryption).
- **Notifications while Nook is closed**: with notifications on, a browser
  also gets them when no Nook page is open, through the browser's own push
  service. The device that sends a message seals the notification for your
  browser, so neither the server nor the push service can read it. Somebody
  with Nook open gets no push: the open page shows its own. On an iPhone this
  works once Nook is on the home screen. The desktop app has no push service,
  so it notifies only while it runs.
- **Emoji on their own**, in a message or a reply, are drawn large.
- **Emoji look the same on every device**: Nook draws each one with
  [Twemoji](https://github.com/jdecked/twemoji), the set Discord uses, in
  place of the device's own. The emoji stays in the page as text under the
  picture, so copy and find see it. The message box draws them too: a copy
  of its text sits behind it, with each picture over an emoji of the same
  width. Code keeps the device's own.
- **A new version** of the site downloads by itself, and a popup offers it,
  with Update now and I’ll do it later. A reload is a leave: in a call,
  Update now takes you out of it, and the new version starts out of voice.
  Nothing joins a channel or shares a screen again by itself.
- **Leaving the page** leaves the space. When a tab closes or reloads, the
  page closes its sockets, and the server tells the others at once, so
  nobody stays in a voice channel after they have gone.
- **The soundboard** is in the voice bar. A sound plays for the people in your
  voice channel, and the green talking ring shows round the face of whoever
  played it, with no toast. Every sound, the board's own and the ones people
  add, is brought to the same loudness (-23 LUFS, by ITU-R BS.1770), so none
  is much louder than another.
- **Each person's volume** is a right click on them in the voice channel, on the left.
  It goes from 0 to 200%, and starts at 100%. A double click puts it back.
- **Playing**: the desktop app sees the game you have open and shows it under
  your name, the way Discord does, in the list of people and in voice. It
  finds a game in a Steam, Epic, GOG, Riot, Ubisoft, EA, Xbox or Rockstar
  library folder, or by the name of a well known game. Only the name, and a
  Steam game's app id, go out. A Steam game has Steam's own picture in the
  person's menu, fetched from Steam by whoever opens it. Settings, Activity
  turns it off. A browser cannot see other programs,
  so the web page never shows a game of its own.
- **Clips from your recordings**, in the desktop app: the clip button in the
  message box lists your Steam game recordings, the Videos folder where
  NVIDIA, OBS and Xbox save theirs, and any folder you add in Settings,
  Recordings. Pick one, drag its two ends to the part you want (or press I
  and O while it plays), and Add to message puts the clip in the message box,
  the way a file you drop does. Save clip keeps it on your computer instead.
  Steam does not keep a recording as a video file: it keeps a folder of small
  pieces, the picture and the sound apart (`session.mpd`,
  `init-stream0.m4s`, `chunk-stream0-00001.m4s`, and so on), in
  `userdata/<id>/gamerecordings`, or where `BackgroundRecordPath` in Steam's
  `localconfig.vdf` says. The desktop app (`desktop/recordings.cjs`) serves
  those pieces as one MP4 with its sound, at a `nook-rec://` address, and the
  page plays it a piece at a time. The clip is copied as it is when it fits
  the server, and compressed when it does not, on your device, with the
  browser's own encoder (`src/media/clip.ts`). HEVC becomes H.264, which
  every browser plays.
- **GIFs** come from the server of the space, with its key: whoever runs it
  sets `NOOK_KLIPY_KEY`, `NOOK_TENOR_KEY` or `NOOK_GIPHY_KEY`, and
  everybody on it can search. Nobody puts a key of their own in the page.

Every space you are in is connected at once, over one WebSocket per server, so
a direct message or a mention in any of them reaches you wherever you are.

## Where things are kept

| What | Where |
| --- | --- |
| Messages, channels, levels, reactions | Postgres on the server, and on every server of its cluster |
| Files | On the server's disk, sealed, and on every server of its cluster. The key is in the message |
| Your list of spaces and read marks | The server, in one record per person, sealed with a key made from your identity |
| Who is here, and in which voice channel | The server holds each live session in memory, sealed, and says when it changes. Its list is the truth: each page checks against it every minute |
| Picture and sound | Straight between browsers, or through the server's TURN relay when it has one, encrypted with DTLS-SRTP |
| Your preferences: quick reactions, volumes, sounds, showing your game, space order | This device, and a copy in your sealed record on your servers, so they follow you to every device |
| Your identity key | Your devices only, and only the ones you link or restore. It signs everything you write |
| A space's newer keys, after somebody was removed | The log of the space, one copy sealed for each person |
| Where a device takes notifications while Nook is closed | The log of each space it is in, sealed, so only the people in the space see it |
| Your microphone and speaker | This device only: they are its hardware |

Nothing about a space is written to IndexedDB or local storage.

**A backup.** Settings, Your account, Save a backup, saves your account
as one small file, with a password if you want one, and Settings says when
this device last saved one. If a browser's data is ever cleared, open Nook,
choose "I have an account", then "Use a backup file", and choose the file or
drop it on the screen. You are back with every space and message. Anybody
with the file can be you, so keep it somewhere private.

**Another device.** Settings, Link a device, shows a QR code, a link, and a
code like `K7M2-9QPT-VB2W` with the server it waits on. Point the new
device's camera at the QR code, open the link there, or choose "I have an
account", then "Use my other device", and type the code and the server. The
new device becomes you: your key, your name, and which servers hold your
spaces (your picture comes from them), so it has the same spaces, messages
and direct messages. What travels is sealed with a key made from the code,
waits on your server for ten minutes, and can be taken once.

Everything is sealed with AES-GCM under a key made from the space code (and its
password, if it has one) before it leaves the browser, or under a newer key
after somebody was removed. Every event is signed
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

`VITE_NOOK_SERVER`, set when the page is built, gives every visitor a
server. It is for development, where the tests use it. Leave it unset on a
public page.

To run your own, follow [docs/self-hosting.md](docs/self-hosting.md). It takes
one `docker compose up`. `server/README.md` has every setting and the API.

**A restart** of a server, for an update, needs nothing from anybody. Each
page tries again every few seconds while its server is gone, and at once when
the network or the screen comes back. What somebody writes meanwhile waits in
the page and goes out when the server is back, and voice and screen shares
keep going, since they go between the browsers. `node test/restart.test.mjs`
restarts a server under two people in voice.

**A cluster.** Several servers that name each other in `NOOK_PEERS` and share
a `NOOK_CLUSTER_SECRET` keep every space on all of them. When the one a page
is talking to goes down, the page moves to the next without anybody doing
anything, and the server that was down catches up when it comes back.

## Invites

A space is a code, written the way Windows wrote a product key. The link names
the space's servers after an `@`:

```
https://cathode.video/#K7M2-9QPT-VB2W@nook.example.org,nook.friend.net
```

The code uses Crockford's base32 alphabet, which leaves out I, L, O and U, so
no letter can be misread as a digit. It is read back however it was typed, in
any case, with or without hyphens. The code is the key, and it sits after the
`#`, so it never reaches the webserver that sends the page.

**Invite people**, in the space menu, shows the link, a Copy button, and a QR
code. The QR encoder is in `src/ui/qr.ts`: byte mode, error correction level
M, versions 1 to 10. `npm test qr` renders every version and reads it back
with the QR decoder built into Chrome.

## Look

Nook follows the brand in `nook-brand/` (read `nook-brand/STYLE_GUIDE.md`).
Warm cream by day, near-black charcoal after dark, and a small ghost at the heart of it.
The channels are on the left under the switcher, the conversation is in the
middle, and who is here is on the right.

- **Two themes, one set of names.** Settings, Appearance picks System, Light
  or Dark. System follows the device. The choice is set on `<html>` before the
  first paint, so the page never flashes the wrong colours.
- **One ember spot.** Ember is the send button, the unread count, a mention of
  you, and the first button on the welcome card. Text on ember is always ink.
- **Messages as Discord lays them out.** Every message is on the left, with
  no bubbles. A new sender, or five quiet minutes, starts a new group under a
  face and a name. A message that names you has an ember wash and bar.
- **The ghost.** It floats in empty places, types along when somebody types,
  sleeps when no server answers, peeks in with a message and wiggles when you
  are mentioned. Only one ghost moves on a screen at a time, and none move with
  reduced motion.
- **Type.** Bricolage Grotesque for titles, DM Sans for everything else, and
  JetBrains Mono for code. The fonts are part of the build, so they work
  offline too.

**The brand tokens are in `src/brand/tokens.css`,** copied from
`nook-brand/tokens/`. The block at the top of `src/styles.css` gives them the
names the app uses, and nothing below that block names a colour.
`test/polish.test.mjs` checks that every text colour clears 4.5 to 1 on every
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
somebody arrives or goes, and the only timer is the server's 10 second ping.

## Development

```
npm install
npm run stack        # Postgres in Docker, a server on 8787, and the page on 5173
npm test             # every check, against the stack
npm test chat files  # only these checks
npm run speed        # how long opening, switching and sending take
npm run bench        # how fast the server reads, writes and passes on
npm run tour         # screenshots of every screen, in test-output/tour/
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
    keys.ts           a new space key after a removal, and a copy for each person
  net/
    connection.ts     one WebSocket per server, carrying every space on it
    cluster.ts        the servers of a cluster, and moving to the next
    server-api.ts     sealing a line, link cards, GIF search, health
    files.ts          files: sealed with a key each, uploaded, fetched and opened
    link.ts           linking a device, and backups: what travels, and how it is sealed
    mesh.ts           who is here, from what the server passes on
    voice.ts          voice channels, mic.ts denoise.ts talking.ts around them
    uplink.ts         how much upload Nook may use, guessed then measured
    push.ts           notifications while Nook is closed: subscribe, seal, send
    recordings.ts     your recordings, as the desktop app finds and serves them
  signal/
    bus.ts            signals in and out of a space, de-duplicated
    envelope.ts       AES-GCM seal and open, replay guard
    transport.ts      the transport interface and the retry backoff
  store/
    identity.ts       the key pair that makes you you, kept on the device
    log.ts            signed, immutable events and what they add up to
    room-chat.ts      one room's conversation, on top of the log
    server-spaces.ts  your sealed record of spaces on each server
    prefs.ts          the preferences that ride in that record, newest wins
    verify-pool.ts    signature checks on Web Workers
    gifs.ts           what a GIF is; the server searches, with its key
  rtc/                screen share connections, codecs, quality, stats
  media/              the screen picker, the microphone, the mix, and clips from recordings
  brand/              the brand tokens, the ghost's motion and its components, from nook-brand/
  ui/
    home-view.ts      Home: direct messages from every space
    welcome.ts        the first visit: your name, and a picture
    call.ts           a call ringing, the strip over a conversation, the voice dock
    voice-settings.ts microphone and speaker, a microphone test, a relay test
    space-view.ts     a space: channels, voice, sharing, search, people
    desktop-offer.ts  the desktop app and its download, under the people in a browser
    space-list.ts     the home page: your spaces, making and joining one
    chat-panel.ts     the conversation, drawn as nodes and never as HTML
    attachments.ts    files in a message, the picture viewer, and the upload tray
    recordings.ts     your recordings, and the clip editor with its two ends
    settings-view.ts  profile, identity, servers, this space, preferences
    levels.ts         the levels of a space: names, colours, what each may do
    space-switcher.ts going from one space to another, behind the space name
    ghost.ts          the Nook ghost, its moods and moves, and the lockup
    theme.ts          light, dark, or what the device uses
    icons.ts          the icon set: a 24px grid and a 1.75px stroke
    video-surface.ts  fit, fill, and one to one with zoom and pan
    qr.ts             a QR encoder, byte mode, level M, versions 1 to 10
server/               the server and its Docker image; see server/README.md
docs/
  self-hosting.md     run your own server, or a cluster with friends
test/
  harness.mjs         the browser, check() and finish(), shared by every check
  run.mjs             npm test: runs every *.test.mjs, or the ones named
  stack.mjs           Postgres, a server and the page, for every check
  pg.mjs              a fresh database and a server, for the checks that start their own
  *.test.mjs          one check each: e2e, chat, files, voice, cluster, failover, ...
  speed.mjs           how long opening, switching and sending take
  server-bench.mjs    how fast the server reads, writes and passes on
  tour.mjs            screenshots of every screen, filled with a conversation
```

## Keyboard, on a shared screen

A shared screen shows at its actual size, made smaller only when it does not
fit, with the zoom. The bar also has Full window, Fullscreen, and a button that
closes the stream: Stop watching, or Stop sharing on your own screen. Your own
screen has no tag over it, since the tab above it says who is watching.

| Key | Action |
| --- | --- |
| `W` | Full window: the stream over the whole Nook window |
| `F` | Fullscreen |
| `M` | Mute |
| `0` | Reset the zoom |
| `+` `-` | Zoom in and out |
| `Esc` | Leave full window. Otherwise take every share off your screen. In fullscreen it also leaves fullscreen |

Double click on the picture resets the zoom. Control plus the wheel, a
trackpad pinch, or `+` and `-`, zooms. A drag moves a zoomed picture.

## Keyboard, anywhere in a space

| Key | Action |
| --- | --- |
| `Ctrl`/`Cmd`+`Shift`+`M` | Mute or unmute your microphone in voice |
| `Ctrl`/`Cmd`+`K` | Search this space |
| `Ctrl`/`Cmd`+`1`-`9` | Jump to a channel, in the order of the list |

## Apps

- **Phone:** open the site and add it to the home screen. On an iPhone, use
  Share, then Add to Home Screen. On Android, use Install app. Voice and chat
  work. A phone cannot share its screen from a browser.
- **Desktop:** `desktop/` is an Electron shell around the site. It loads
  `https://cathode.video`, so invite links stay the same, and it adds a picker
  for a screen or a window. On Windows it can share the system sound too. It
  also tells the page what game you are playing: `desktop/games.cjs` looks at
  the running programs every 15 seconds, while Settings lets it.
- **The desktop offer:** in a browser on a computer, the foot of the list of
  people says what the desktop app adds, with a download for your system
  from the latest release (`src/ui/desktop-offer.ts`). Its close button hides
  it for good. The desktop app and a phone never show it.
- **Right click in the desktop app:** a text box, a selection, a link or a
  picture gets the menu a browser gives, with spelling guesses
  (`desktop/edit-menu.cjs`). The page's own menus, on a channel or a
  person, stay as they are. Full screen pictures and dialogs sit under the
  app's title bar, not behind it.
- **Desktop windows:** the picker for a screen or a window opens over the
  Nook window, on its screen, so with Nook on a second screen the picker is
  there too. Nook opens where it was when it last closed: the same place,
  size and screen, maximized if it was (`desktop/placement.cjs`). If that
  screen is gone, it opens in the middle of the main screen.
- **Desktop updates:** the desktop app looks for a newer version in the
  [GitHub releases](https://github.com/nookchat/nook-app/releases) at start
  and every 4 hours (`desktop/updates.cjs`), and downloads it. The page offers
  Restart, which also takes a waiting web update, so both go in at once and
  you come back to the same screen, out of any call; a web update found while a
  desktop one downloads waits for it. Later means this start: the update
  goes in on the next quit. Windows and Linux use electron-updater. macOS
  installs only updates signed by a known developer, which this build is
  not, so there the shell checks the download against `SHA256SUMS.txt` and
  puts the new app in place itself.

To release, raise `version` in `package.json` and `desktop/package.json`,
commit, and push a tag of that version:

```sh
git tag v0.3.2 && git push origin v0.3.2
```

The `desktop release` workflow builds the app on macOS, Windows and Linux, each
on its own system, puts the builds and `SHA256SUMS.txt` in a draft release, and
publishes it once all are there. Run the workflow by hand to build without a
release: the builds are kept as the run's artifacts.

The `checks` workflow runs on every push: the types, the build, and every check
in `test/`, against a real server, Postgres and Chrome.

```sh
cd desktop && npm install
npm start              # against https://cathode.video
npm run dev            # against the Vite server on localhost:5173
npm run dist:mac       # or dist:win, dist:linux; the builds go in desktop/release
```

Set `NOOK_URL` to point the shell at another home.

## Credits

The emoji pictures are [Twemoji](https://github.com/jdecked/twemoji), by
Twitter and its contributors, under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/).

The app's sounds (joining, leaving, a message, a mention, a call ringing, mute,
deafen and a share that starts) are Google's
[Material Design sound resources](https://m2.material.io/design/sound/sound-resources.html),
under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/), brought to the
same loudness. They are in `public/sounds`, with the licence and the name of
each one.
They are Twemoji 17, from its GitHub release, as the `twemoji-art` package.
