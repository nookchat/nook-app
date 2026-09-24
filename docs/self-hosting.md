# Run your own Nook server

A Nook server keeps spaces: their messages, who is in them, and each
person's list of spaces. Everything it keeps is encrypted on the device that
wrote it, so the server cannot read any of it. Calls and screen shares pass
through it, encrypted too.

You can run one on your own, or with friends as a **cluster**: several
servers that keep a copy of every space each, so a space keeps going when one
of them is down.

## What you need

- A Linux machine with [Docker](https://docs.docker.com/engine/install/). A
  small VPS is enough: 1 CPU and 1 GB of memory carries a lot of chat.
- A domain name that points at the machine, such as `cathode.example.org`.
- These ports open in its firewall:

  | Port | For |
  | --- | --- |
  | 80 and 443, TCP | HTTPS |
  | 3478, TCP and UDP | Calls (TURN) |
  | 49160–49260, UDP | Calls (TURN relay) |

## Set it up

One command, on the machine:

```
curl -fsSL https://raw.githubusercontent.com/nebbsie/stream/main/server/install.sh | sh
```

It asks for your domain, and does the rest:

- makes the secrets (the database password and the TURN secret)
- starts the server, its database, HTTPS (Caddy, with a free certificate) and
  a TURN relay for calls
- waits until your server answers, and says so

Then open Nook, type your domain under **Add server** on the home
page, and press **Add**. Your new spaces go there.

Nobody else sees your server until you send them an invite. An invite names
the server, so a friend can join with no server of their own.

Everything goes in a folder called `cathode`, with your settings in
`cathode/.env`. Only the domain has to be set; everything else has a
default, and any setting in [server/README.md](../server/README.md#settings)
can be added to `.env` to change it. Then run `docker compose up -d` in that
folder.

### Choices, set before the command

| Setting | What it does |
| --- | --- |
| `CATHODE_DOMAIN=cathode.example.org` | The domain, so it does not ask |
| `CATHODE_TLS=0` | No Caddy, because you already have a proxy (Traefik, nginx) in front |
| `CATHODE_TURN=0` | No TURN relay: calls go straight between people |
| `CATHODE_DIR=/opt/cathode` | Where it goes |

For example:

```
curl -fsSL https://raw.githubusercontent.com/nebbsie/stream/main/server/install.sh | CATHODE_DOMAIN=cathode.example.org sh
```

## Keep it up to date

Run the same command again. It keeps your settings and starts the newest
server.

## Join a cluster with friends

Every server in a cluster keeps every space, and they keep each other up to
date all the time. When one is down, people carry on on another without
noticing, and it catches up when it comes back.

1. Each person sets up a server as above.
2. Agree on one cluster secret and share it privately:

   ```
   openssl rand -hex 32
   ```

3. On every server, add to `cathode/.env`:

   ```
   CATHODE_PEERS=https://friend-one.example.org,https://friend-two.example.org
   CATHODE_CLUSTER_SECRET=the shared secret
   ```

   `CATHODE_PEERS` lists the other servers, not your own.

4. Restart each server, in its `cathode` folder:

   ```
   docker compose up -d
   ```

5. In Nook, **Settings**, **Servers** shows each server in the cluster and
   whether it is up.

The servers trust each other with encrypted data only. None of them can read a
message or forge one: every message is signed by the person who wrote it and
checked by every device.

## When calls do not connect

Open Nook, **Settings, Voice**:

1. **Test microphone.** The bar moves when you talk. If it does not, pick
   another microphone above it.
2. **Hear yourself.** You hear your own voice. If you do not, pick another
   speaker.
3. **Test connection.** It asks each of your servers for its relay (TURN) and
   checks the relay answers.

If the relay does not answer, calls on that server carry no sound, because by
default every call goes through the relay (`CATHODE_TURN_ONLY=1`). Check:

- Ports 3478 (TCP and UDP) and 49160–49260 (UDP) are open in the firewall,
  and in any cloud firewall in front of the machine.
- `CATHODE_TURN_URLS` names your domain, and `CATHODE_TURN_SECRET` is set.
- The `cathode-turn` container is running: `docker ps`, and
  `docker logs cathode-turn`.

To let calls go direct while you fix the relay, set `CATHODE_TURN_ONLY=0` and
restart. Calls then work on most networks, and each person in a call can see
the other's address.

## Backups

Messages are in Postgres, and files are in the `cathode-data` volume. Back up
both:

```
docker exec cathode-db pg_dump -U cathode cathode > cathode-backup.sql
docker run --rm -v cathode_cathode-data:/data -v "$PWD":/out alpine tar czf /out/cathode-files.tgz -C /data files
```

Everything in both is encrypted, so a backup is safe to keep anywhere.

In a cluster, every other server is a live copy as well.

## More

`server/README.md` in the repository has every setting, the API, and exactly
what a server can and cannot see.
