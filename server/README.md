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

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `CATHODE_DATA` | `./data` | Where the ciphertext goes |
| `CATHODE_MAX_ROOM_BYTES` | `268435456` | Per space, before the oldest half is dropped |

## Endpoints

| Route | Does |
|---|---|
| `GET /health` | Says what it is |
| `GET /events/:room?from=N` | Lines after N, and where that leaves you |
| `POST /events/:room` | Appends a list of sealed lines |

A room id is 32 hex characters, derived from the space code. It gives away
nothing about the code, and the archive cannot work backwards from it.
