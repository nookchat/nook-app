# The optional archive

Cathode does not need this. Everybody in a space keeps the whole history and
hands it to whoever turns up, so a space survives as long as one person who was
in it opens it again.

What that cannot do is catch you up on something said while **every** person was
offline, because nobody was there to remember it. That is the one hole. This
fills it, and does nothing else.

## Running one

```
docker compose -f server/docker-compose.yml up -d
```

Or without Docker, since it has no dependencies and no build step:

```
node server/server.mjs
```

Then open Settings in any space, put the address under **Archive**, and press
Use it. Nothing else changes. Turn it off by clearing the box.

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

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `CATHODE_DATA` | `./data` | Where the ciphertext goes |
| `CATHODE_MAX_ROOM_BYTES` | `268435456` | Per space, before the oldest half is dropped |
| `CATHODE_TENOR_KEY` | (empty) | Turns on `/gif` search for spaces using this archive. A free key comes from https://developers.google.com/tenor. Search terms reach Tenor; leave it empty and the feature stays off |

## Endpoints

| Route | Does |
|---|---|
| `GET /health` | Says what it is |
| `GET /events/:room?from=N` | Lines after N, and where that leaves you |
| `POST /events/:room` | Appends a list of sealed lines. Needs `x-cathode-write` |
| `GET /preview?url=U` | Reads a public page's OpenGraph tags, for link cards in chat |
| `GET /gif?q=term` | GIF search via Tenor. 404 until `CATHODE_TENOR_KEY` is set |

A room id is 32 hex characters, derived from the space code. It gives away
nothing about the code, and the archive cannot work backwards from it.
