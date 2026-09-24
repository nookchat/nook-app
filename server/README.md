# The Cathode server

One file, no dependencies, and a Docker image. It does two jobs.

**It is the backend for a space that runs on a server.** Every handshake, chat
line and event goes over one WebSocket to it. It keeps the history, and it
hands out TURN credentials, so the picture and the sound get through networks
that block peer to peer. Somebody picks **Server** when they make a space, and
everybody who opens that invite uses the same server.

**It is an optional archive for a peer to peer space.** Everybody in a space
keeps the whole history and hands it to whoever turns up, so a space survives
as long as one person who was in it opens it again. What that cannot do is
catch you up on something said while **every** person was offline. The archive
fills that one hole, and does nothing else.

Both ways, it cannot read anything it carries or keeps.

## Running it on your own machine

You need a Linux machine with Docker, and a DNS name that points at it.

1. Copy the settings, and fill them in:

   ```
   cp server/.env.example server/.env
   ```

2. Make the TURN secret:

   ```
   openssl rand -hex 32
   ```

   Put the result in `CATHODE_TURN_SECRET`.

3. Start everything:

   ```
   docker compose -f server/docker-compose.yml up -d
   ```

4. Open these ports in the firewall:

   | Port | For |
   | --- | --- |
   | 80 and 443, TCP | Caddy, which gets the certificate and serves HTTPS |
   | 3478, TCP and UDP | TURN |
   | 49160–49260, UDP | TURN relay ports. Change them with `CATHODE_TURN_MIN_PORT` and `CATHODE_TURN_MAX_PORT` |

5. Check it:

   ```
   curl https://cathode.example.org/health
   ```

6. Build the page with `VITE_CATHODE_SERVER=https://cathode.example.org`.
   On Vercel, set it under Project, Settings, Environment Variables, and deploy
   again. The page then offers **Server** when somebody makes a space.

`COMPOSE_PROFILES` in `.env` selects the containers. `tls` starts Caddy, and
`turn` starts coturn. Remove `tls` when you already have a reverse proxy. Set
`CATHODE_BIND=0.0.0.0` so that the proxy can reach port 8787. Remove `turn`
when you do not want to relay media.

### Only the server, to try it

```
docker compose -f server/docker-compose.yml up -d cathode
```

Or without Docker, because it has no dependencies and no build step:

```
node server/server.mjs
```

Then use `localhost:8787` as the server address. `http://localhost` is the one
plain address that an HTTPS page may call.

### The image

A push to `main` that changes `server/` publishes the image to
`ghcr.io/<owner>/cathode-server` (see `.github/workflows/server-image.yml`).
To use it and skip the build, replace the `build` and `image` lines of the
`cathode` service with `image: ghcr.io/<owner>/cathode-server`.

## As an archive, for a peer to peer space

Open Settings in any peer to peer space, put the address under **Archive**,
and press Use it. Nothing else changes. Turn it off by clearing the box.

## What it can see

Nothing. Every event is sealed with the key made from the space code before it
leaves the browser, and the code lives in the fragment of a link, which a
browser never sends to a server. The archive holds a pile of ciphertext and
cannot tell you what any of it says.

## What it can do

Forget, or refuse. Both leave you with a working space and no archive.

It cannot lie usefully. Every event inside is signed by whoever wrote it and is
checked on the way back in exactly like an event from a person, so an archive
that alters one produces one that fails and is dropped. `test/archive-check.mjs`
starts a real server, meddles with every byte it holds, and checks that not one
altered event gets through.

## Who may write

Anybody may read, because what they read is ciphertext and the key is the
space code. Writing is narrower. The room id is also the relay topic, so a
stranger watching a relay learns it without ever holding the code, and junk
appended under it would count against the room's cap until the trim ate the
oldest half of the real history.

So every write carries a token in the `x-cathode-write` header, derived from
the space code the same way the key is. The first write claims the room with
it and every write after that has to match, or it is refused with a 403. The
disk keeps a hash of the token beside the room, in `<room>.token`, so the file
is not the credential. Delete that file and the next writer claims the room
afresh.

Two consequences worth knowing:

- A client from before the token cannot write to this server. It can still
  read everything.
- Claiming is first come. A stranger who raced the very first write would own
  an empty room, and the space would simply have no archive here, which is
  where it started. Attach the archive before sharing the link and the race
  does not exist.

## Put it behind TLS

The server speaks plain HTTP. Run it behind a reverse proxy that terminates
TLS (Caddy, nginx, Traefik), for two reasons:

- The write token travels in a header, and plain HTTP shows it to the network.
- The app is served over HTTPS, and a secure page may not call an insecure
  address. Pointing a space at `http://your-server:8787` will fail in the
  browser as mixed content. `http://localhost:8787` is the one exception
  browsers allow, which is why local testing works without any of this.

The smallest working Caddyfile:

```
archive.example.org {
    reverse_proxy localhost:8787
}
```

## TURN

About one connection in eight fails peer to peer, because of symmetric NAT or
a strict firewall. TURN is the fix: a relay that carries the media. The
compose file runs coturn beside the server. The server then gives every space
on it a set of credentials that expire after a day. The credentials are made
from `CATHODE_TURN_SECRET` in the way that coturn's `use-auth-secret` expects,
so the secret itself never leaves the machine.

By default a call tries a direct path first and uses TURN only when that
fails. Set `CATHODE_TURN_ONLY=1` to send every call through TURN. Then nobody
learns the address of anybody else, but the server carries every stream.

Only a space on this server asks for the credentials. A peer to peer space
that uses this machine as an archive does not ask for them.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `CATHODE_DATA` | `./data` | Where the ciphertext goes |
| `CATHODE_MAX_ROOM_BYTES` | `268435456` | Per space, before the oldest half is dropped |
| `CATHODE_ORIGINS` | `*` | The pages that may use this server, comma separated, such as `https://cathode.example.vercel.app`. Set it, or any website can use your relay and your TURN bandwidth |
| `CATHODE_TURN_URLS` | (empty) | The TURN addresses to hand out, comma separated |
| `CATHODE_TURN_SECRET` | (empty) | The secret shared with coturn. TURN is off until this and the URLs are set |
| `CATHODE_TURN_TTL` | `86400` | How long a TURN credential lasts, in seconds |
| `CATHODE_TURN_ONLY` | `0` | `1` sends every call through TURN |
| `CATHODE_TENOR_KEY` | (empty) | Turns on `/gif` search for spaces using this archive. A free key comes from https://developers.google.com/tenor. Search terms reach Tenor; leave it empty and the feature stays off |

## Endpoints

| Route | Does |
|---|---|
| `GET /health` | Says what it is, and whether it has TURN |
| `GET /ice` | Short lived TURN credentials, for a space on this server |
| `GET /events/:room?from=N` | Lines after N, and where that leaves you |
| `POST /events/:room` | Appends a list of sealed lines. Needs `x-cathode-write` |
| `GET /preview?url=U` | Reads a public page's OpenGraph tags, for link cards in chat |
| `GET /gif?q=term` | GIF search via Tenor. 404 until `CATHODE_TENOR_KEY` is set |
| `WS /relay/:room` | The relay. Every frame goes, unread, to everybody else in the room. It carries all the traffic of a space on this server, and the handshakes of a peer to peer space that uses it as an archive |

## The relay

The handshakes that start a space normally ride public MQTT brokers and Nostr
relays: other people's machines, free, and occasionally all having a bad night
at once. An archive is a machine the space already trusts, so it carries the
handshakes too. Any space pointed at this archive uses its relay automatically;
the public relays stay on the roster as spares. Nothing is stored and nothing
is readable: the frames are sealed the same way they are everywhere else, and
the room id in the path is the topic the public relays already see.

The reverse proxy in front of it has to pass WebSocket upgrades through. Caddy
does by default; nginx needs the usual `Upgrade` and `Connection` headers on
the `/relay/` path.

An archive is one of two ways to search for a GIF, and the better one when a
space has an archive: the key sits on this machine rather than on everybody's.
The other way needs no archive at all. Anybody can paste their own Klipy, Tenor
or Giphy key under Settings, GIFs, and their browser searches with it directly.
Klipy is the quickest of the three to get a key from. The picker looks for that
key first and falls back to the archive.

The relay takes frames up to 512 KiB. A space on this server sends its chat
here, and a batch of history is sized to stay under that limit.

A room id is 32 hex characters, derived from the space code. It gives away
nothing about the code, and the archive cannot work backwards from it.
