# The Cathode server

The backend for Cathode. Every space lives on a server. It keeps every space
in Postgres, carries everything a space does over one WebSocket per device, and
can run as a **cluster**: several people each run one, and every space is kept
on all of them, so no one operator holds the only copy and a space outlives any
one server going down.

**It cannot read anything it keeps.** Every event is sealed on the device that
wrote it, with a key made from the space code, before it is sent. The code
lives in the part of a link that a browser never sends to anybody. See
[Encryption](#encryption).

A step by step guide for somebody who has not done this before is in
[docs/self-hosting.md](../docs/self-hosting.md).

## Running it on your own machine

You need a Linux machine with Docker, and a DNS name that points at it.

1. Get the compose file and its settings:

   ```
   git clone https://github.com/nebbsie/stream.git && cd stream
   cp server/.env.example server/.env
   ```

2. Fill in `server/.env`. Make the two secrets with `openssl rand -hex 32`:

   | Setting | What to put |
   | --- | --- |
   | `CATHODE_DOMAIN` | The name this server answers on |
   | `CATHODE_ORIGINS` | The address of your page, such as `https://cathode.example.vercel.app` |
   | `POSTGRES_PASSWORD` | A long random password for the database |
   | `CATHODE_TURN_SECRET` | A long random secret for TURN |
   | `CATHODE_TURN_URLS` | `turn:<your domain>:3478?transport=udp,turn:<your domain>:3478?transport=tcp` |
   | `CATHODE_PUBLIC_URL` | `https://<your domain>` |

3. Start everything:

   ```
   docker compose -f server/docker-compose.yml up -d
   ```

   This pulls `ghcr.io/nebbsie/cathode-server:latest` and starts four
   containers: the server, Postgres, coturn, and Caddy for HTTPS.

4. Open these ports in the firewall:

   | Port | For |
   | --- | --- |
   | 80 and 443, TCP | Caddy, which gets the certificate and serves HTTPS |
   | 3478, TCP and UDP | TURN |
   | 49160–49260, UDP | TURN relay ports. Change them with `CATHODE_TURN_MIN_PORT` and `CATHODE_TURN_MAX_PORT` |

5. Check it:

   ```
   curl https://cathode.example.org/api/v1/health
   ```

6. Open Cathode and add `cathode.example.org` under **Add your server** on the
   home page, or under Settings, Servers. Your new spaces go there. Other
   people reach it only through the invites you send them.

To update to the newest image:

```
docker compose -f server/docker-compose.yml pull
docker compose -f server/docker-compose.yml up -d
```

`COMPOSE_PROFILES` in `.env` selects the extra containers: `tls` starts Caddy,
and `turn` starts coturn. Remove `tls` if you already have a reverse proxy, and
set `CATHODE_BIND=0.0.0.0` so that the proxy can reach port 8787. Remove `turn`
if you do not want to relay media.

### Only the server, to try it

```
docker compose -f server/docker-compose.yml up -d cathode
```

This starts the server and its database. Use `localhost:8787` as the server
address. `http://localhost` is the one plain address that an HTTPS page may
call. Without Docker, run `npm ci` in `server/`, then
`DATABASE_URL=postgres://... node server/server.mjs`.

## The database

Postgres. The schema is made and upgraded by the server when it starts; each
migration runs once, in a transaction.

| Table | Holds |
| --- | --- |
| `rooms` | One row per space: the hash of its write token, and how many bytes it holds |
| `lines` | Every sealed event of every space, numbered in the order this server kept it |
| `people` | One sealed record per person: their list of spaces and how far they have read |
| `peers` | How far this server has read from each other server in its cluster |
| `files` | Every uploaded file: its space, its id (the SHA-256 of its sealed bytes), and its size |
| `schema_version` | Which migrations have run |

Every line is ciphertext. A copy of this database is a pile of noise with
timestamps on it. Back it up like any Postgres database (`pg_dump`), and in a
cluster the other servers are live copies too.

## Files

Pictures, videos and any other file somebody attaches. The page gives each
file a key of its own, encrypts the file with it, and puts the key in the
message that carries the file, which is sealed with the space's key. So the
server keeps bytes it cannot open, and never sees a key.

The bytes are on disk, one file each, in `CATHODE_FILES` (`/data/files` in the
container, on the `cathode-data` volume). Back that folder up beside the
database. In a cluster every server copies every file from the others, and a
server asked for a file it has not got yet fetches it from the others first.

A file may be at most `CATHODE_MAX_FILE_BYTES` (100 MB) once sealed, and one
space may hold `CATHODE_MAX_ROOM_FILE_BYTES` (5 GB) of them. Past either an
upload is refused, and the page says why.

A server that ran an earlier version kept spaces as files in `CATHODE_DATA`.
It moves them into the database the first time it starts, once, and leaves
the files where they are.

## The API

Version 1, under `/api/v1`. A running server describes it at
`GET /api/v1/openapi.json`. Every error has the same shape:
`{ "error": { "code": "wrong_token", "message": "..." } }`.

| Route | Does |
| --- | --- |
| `GET /api/v1/health` | What this server is, what it offers, and every server in its cluster |
| `GET /api/v1/ice` | Short lived TURN credentials |
| `GET /api/v1/spaces/:room/events?after=N&limit=L` | Sealed lines after line `N`, a page at a time. `at` is where the next page starts, and `more` says there is one |
| `POST /api/v1/spaces/:room/events` | Keeps `{ "events": [sealed lines] }`. Needs `x-cathode-write`. The first write claims the space with its token |
| `WS /api/v1/socket` | Everything every space on this device does, on one connection. See below |
| `WS /api/v1/spaces/:room/socket` | The same for one space. Messages leave out `room` |
| `POST /api/v1/spaces/:room/files` | Keeps the sealed file in the body. Needs `x-cathode-write`. Answers `{ "id", "size" }`, where `id` is the SHA-256 of the body |
| `GET /api/v1/spaces/:room/files/:id` | That file, as sealed bytes |
| `GET /api/v1/people/:id` | One person's sealed record |
| `PUT /api/v1/people/:id` | Replaces it. Needs `x-cathode-write`. The first write claims it |
| `GET /api/v1/preview?url=U` | The title, description and picture behind a public link |
| `GET /api/v1/gifs?q=term` | GIF search, when `CATHODE_TENOR_KEY` is set |
| `GET /api/v1/cluster/lines`, `/rooms`, `/people`, `/files` | Between servers in a cluster only. Needs the cluster secret |

The socket speaks JSON, one message per frame. Every message carries the
`room` it is about, so one connection carries every space a device is in:

| Direction | Message | Means |
| --- | --- | --- |
| to the server | `hello {room, from}` | Join the space. Everything after line `from`, page by page, then live |
| to the server | `leave {room}` | Leave the space. The others get `left` |
| to the server | `put {id, lines, w}` | Keep these sealed lines. `w` is the write token |
| to the server | `sig {d}` | A sealed signal (a handshake, typing) for everybody else. Not kept |
| to the server | `state {id, d}` | This session's sealed presence. Kept while the socket is open, handed to whoever arrives, and followed by `left` when it closes |
| from the server | `page {at, lines, more}` | History |
| from the server | `live {at}` | History is done. New lines arrive as `ev` from here on |
| from the server | `ev {at, lines}` | Lines somebody else wrote, or another server sent |
| from the server | `ack {id, at}` / `nack {id, code, message}` | The `put` was kept, or refused |
| from the server | `sig {d}` | Somebody else's signal, or their presence |
| from the server | `left {id}` | A session's socket closed, or stopped answering the heartbeat |

Nothing is sent on a timer. Presence goes out when it changes: the server
holds each session's latest, gives it to whoever arrives, and says `left` the
moment a socket goes. A space that is open and quiet sends nothing at all. The
only regular traffic is the WebSocket heartbeat, a ping from the server every
15 seconds, which the browser answers by itself. A connection that misses one
is closed, so somebody whose network dropped is shown as away within 30
seconds.

`at` is always the number of the newest line a message brings the reader to.
The server sends a space's lines in order, so a reader that keeps the highest
`at` it has seen can reconnect with `hello` from there and miss nothing.

## A cluster

A few people each run a server, with their own database, and join them into
one cluster. Every server then keeps a full copy of every space in the cluster.

1. Each operator sets up a server as above.
2. Agree on one cluster secret, 16 characters or more (`openssl rand -hex 32`),
   and share it privately between the operators.
3. On every server, set:

   ```
   CATHODE_PUBLIC_URL=https://this-server.example.org
   CATHODE_PEERS=https://other-one.example.org,https://other-two.example.org
   CATHODE_CLUSTER_SECRET=the shared secret
   ```

4. Restart each server. `GET /api/v1/health` lists the cluster, and `peers`
   says whether each of the others is reachable.

How it works:

- Every server pulls from every other, all the time, over HTTPS: which spaces
  exist and their claims, every sealed line, and every person's sealed record.
- Lines are pulled by long polling, so a line written on one server reaches
  the others in about the time it takes to cross the network.
- A line two servers both hold is the same line and is kept once.
- A server that was down asks every other for what it missed when it comes
  back, and catches up.
- The page learns the whole cluster from any server's health check, and an
  invite names the servers after the first. When the server a page is using
  goes quiet, it moves to the next without anybody doing anything, and
  somebody opening an invite while the first server is down still gets in.

`test/cluster-check.mjs` and `test/failover-check.mjs` run two servers with two
databases, stop one, and check that nothing is lost and nobody notices.

What the operators trust each other with is ciphertext. A server in the
cluster can refuse to pass lines on, forget them, or send junk; it cannot read
them, and it cannot forge an event, because every event inside is signed by
the person who wrote it and checked by every device. Choose operators you
trust not to go quiet, not operators you trust with your messages: none of
them can read those.

## Encryption

Everything a person writes is end to end encrypted. The server stores and
relays it, and cannot open it.

| What | Sealed with | Who can open it |
| --- | --- | --- |
| Every event in a space (messages, edits, reactions, names, channels) | AES-GCM, with a key made from the space code and its password | Anybody holding the invite link |
| Private messages | Also sealed with a key only the two people can work out | The two people |
| Files | AES-GCM, with a key made for each file, which travels only inside its sealed message | Whoever can read that message |
| Signals (handshakes, presence, typing) | AES-GCM, the same space key | Anybody holding the invite link |
| Your list of spaces and read marks | AES-GCM, with a key made from your identity key | Your devices |
| Calls and screen shares | DTLS-SRTP, negotiated between the browsers | The people in the call. TURN relays packets it cannot open |

The space code never reaches a server: it sits after the `#` in the link, and
a browser never sends that part anywhere. Every event is also signed with its
author's identity key, and checked by every device when it arrives, so a
server that alters or invents an event produces one that is dropped.

What a server can see, because it has to:

- Which space ids exist, and how big they are. A space id is a hash of the
  code and says nothing about it.
- How many files a space holds, and how big each one is.
- Who connects, from which address, when, and how much they send.
- Which links are previewed, if link cards are on. Set `CATHODE_PREVIEWS=0`
  to turn them off.
- What is searched for, if GIF search is on.

## Put it behind TLS

The server speaks plain HTTP. Caddy in the compose file puts HTTPS in front of
it. With your own proxy, pass WebSocket upgrades through, and keep read
timeouts above 30 seconds, because servers in a cluster hold requests open
while they wait for new lines. The smallest working Caddyfile:

```
cathode.example.org {
    reverse_proxy localhost:8787
}
```

## TURN

Calls and screen shares go between browsers over WebRTC. About one connection
in eight cannot go direct, because of symmetric NAT or a strict firewall, so
TURN relays the media instead. The server gives every space
on it credentials that expire after a day, made from `CATHODE_TURN_SECRET` in
the way coturn's `use-auth-secret` expects.

By default every call and screen share in a space on this server goes through
TURN, so media never goes straight between people and nobody learns anybody
else's address. It stays encrypted end to end all the same. Set
`CATHODE_TURN_ONLY=0` to let a call try a direct path first. Without TURN,
calls try to go straight between browsers.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `DATABASE_URL` | `postgres://cathode:cathode@localhost:5432/cathode` | The Postgres database |
| `CATHODE_ORIGINS` | `*` | The pages that may use this server, comma separated. Set it, or any website can use your server and your TURN bandwidth |
| `CATHODE_MAX_ROOM_BYTES` | `268435456` | Per space, before the oldest half is dropped |
| `CATHODE_PUBLIC_URL` | (empty) | This server's own address, as pages and other servers reach it |
| `CATHODE_PEERS` | (empty) | The other servers in the cluster, comma separated |
| `CATHODE_CLUSTER_SECRET` | (empty) | Shared by every server in the cluster, 16 characters or more |
| `CATHODE_TURN_URLS` | (empty) | The TURN addresses to hand out, comma separated |
| `CATHODE_TURN_SECRET` | (empty) | The secret shared with coturn. TURN is off until this and the URLs are set |
| `CATHODE_TURN_TTL` | `86400` | How long a TURN credential lasts, in seconds |
| `CATHODE_TURN_ONLY` | `1` | `0` lets a call try a direct path before TURN |
| `CATHODE_PREVIEWS` | `1` | `0` turns link cards off, so this server never learns which links are shared |
| `CATHODE_TENOR_KEY` | (empty) | Turns on GIF search. A free key comes from https://developers.google.com/tenor |
| `CATHODE_MAX_ROOM_SOCKETS` | `200` | Connections one space may hold |
| `CATHODE_RATE`, `CATHODE_RATE_BURST` | `30`, `120` | Requests one address may make per second, and in a burst |
| `CATHODE_FILES` | `/data/files` | Where uploaded files are kept, sealed |
| `CATHODE_MAX_FILE_BYTES` | `104857600` | The largest one file may be, sealed |
| `CATHODE_MAX_ROOM_FILE_BYTES` | `5368709120` | How much in files one space may keep |
| `CATHODE_DATA` | `/data` | Where an earlier version kept its spaces, read once on upgrade |
