# Run your own Cathode server

A Cathode server keeps spaces: their messages, who is in them, and each
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

1. Get the files:

   ```
   git clone https://github.com/nebbsie/stream.git
   cd stream
   cp server/.env.example server/.env
   ```

2. Make two secrets:

   ```
   openssl rand -hex 24    # the database password
   openssl rand -hex 32    # the TURN secret
   ```

3. Open `server/.env` and fill in:

   | Setting | What to put |
   | --- | --- |
   | `CATHODE_DOMAIN` | Your domain, such as `cathode.example.org` |
   | `CATHODE_PUBLIC_URL` | `https://` and your domain |
   | `CATHODE_ORIGINS` | The address of the Cathode page people use, such as `https://cathode.example.vercel.app` |
   | `POSTGRES_PASSWORD` | The first secret |
   | `CATHODE_TURN_SECRET` | The second secret |
   | `CATHODE_TURN_URLS` | `turn:<your domain>:3478?transport=udp,turn:<your domain>:3478?transport=tcp` |

4. Start it:

   ```
   docker compose -f server/docker-compose.yml up -d
   ```

   This starts four containers: the server, its database (Postgres), a TURN
   relay for calls (coturn), and Caddy, which gets an HTTPS certificate for
   your domain by itself.

5. Check it:

   ```
   curl https://cathode.example.org/api/v1/health
   ```

   It answers with `"ok": true`.

6. Use it. Open Cathode, type your domain under **Add your server** on the
   home page, and press **Add**. Your new spaces go there. You can also add it
   under **Settings, Servers**.

   Nobody else sees your server until you send them an invite. An invite
   names the server, so a friend can join with no server of their own.

## Keep it up to date

```
docker compose -f server/docker-compose.yml pull
docker compose -f server/docker-compose.yml up -d
```

## Join a cluster with friends

Every server in a cluster keeps every space, and they keep each other up to
date all the time. When one is down, people carry on on another without
noticing, and it catches up when it comes back.

1. Each person sets up a server as above.
2. Agree on one cluster secret and share it privately:

   ```
   openssl rand -hex 32
   ```

3. On every server, add to `server/.env`:

   ```
   CATHODE_PEERS=https://friend-one.example.org,https://friend-two.example.org
   CATHODE_CLUSTER_SECRET=the shared secret
   ```

   `CATHODE_PEERS` lists the other servers, not your own.

4. Restart each server:

   ```
   docker compose -f server/docker-compose.yml up -d
   ```

5. In Cathode, **Settings**, **Servers** shows each server in the cluster and
   whether it is up.

The servers trust each other with encrypted data only. None of them can read a
message or forge one: every message is signed by the person who wrote it and
checked by every device.

## Backups

Everything is in Postgres. Back it up like any Postgres database:

```
docker exec cathode-db pg_dump -U cathode cathode > cathode-backup.sql
```

In a cluster, every other server is a live copy as well.

## More

`server/README.md` in the repository has every setting, the API, and exactly
what a server can and cannot see.
