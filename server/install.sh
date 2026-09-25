#!/bin/sh
# A Nook server, in one command:
#
#   curl -fsSL https://raw.githubusercontent.com/nookchat/nook-app/main/server/install.sh | sh
#
# It asks for the domain, makes the secrets, starts the server, Postgres, HTTPS
# and TURN, and waits until it answers. Run it again to update; .env is kept.
#
# Optional settings:
#
#   CATHODE_DOMAIN=cathode.example.org   the domain, without asking
#   CATHODE_DIR=./cathode                where it goes
#   CATHODE_TLS=0                        no Caddy: you have your own proxy
#   CATHODE_TURN=0                       no TURN relay
#   CATHODE_KLIPY_KEY=...                GIF search for everybody here (or
#                                        CATHODE_TENOR_KEY, CATHODE_GIPHY_KEY)
#
# Needs Docker with its compose plugin, and a domain whose DNS points here.

set -eu

REPO="${CATHODE_REPO:-https://raw.githubusercontent.com/nookchat/nook-app/main/server}"
DIR="${CATHODE_DIR:-cathode}"

say() { printf '%s\n' "$*"; }
fail() { printf 'Nook: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. See https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || fail "Docker's compose plugin is missing. See https://docs.docker.com/compose/install/"
command -v curl >/dev/null 2>&1 || fail "curl is not installed."

mkdir -p "$DIR"
cd "$DIR"

secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

if [ -f .env ]; then
  say "Updating the Nook server in $(pwd). Your settings in .env are kept."
else
  domain="${CATHODE_DOMAIN:-}"
  if [ -z "$domain" ]; then
    # Read from the terminal, not the pipe the script arrived on.
    if [ -r /dev/tty ]; then
      printf "The domain this server answers on (for example cathode.example.org): " >/dev/tty
      read -r domain </dev/tty
    fi
  fi
  domain=$(printf '%s' "$domain" | sed -e 's#^https://##' -e 's#^http://##' -e 's#/*$##')
  [ -n "$domain" ] || fail "A domain is needed. Run it again with CATHODE_DOMAIN=your.domain"

  profiles=""
  [ "${CATHODE_TLS:-1}" = "0" ] || profiles="tls"
  [ "${CATHODE_TURN:-1}" = "0" ] || profiles="${profiles:+$profiles,}turn"

  umask 077
  cat > .env <<EOF
# Nook server settings. Change any of them and run: docker compose up -d
# Every other setting has a default; see server/README.md to override one.
CATHODE_DOMAIN=$domain
POSTGRES_PASSWORD=$(secret 24)
CATHODE_TURN_SECRET=$(secret 32)
COMPOSE_PROFILES=$profiles
EOF
  for name in CATHODE_KLIPY_KEY CATHODE_TENOR_KEY CATHODE_GIPHY_KEY; do
    value=$(printenv "$name" || true)
    [ -z "$value" ] || printf '%s=%s\n' "$name" "$value" >> .env
  done
  say "Wrote $(pwd)/.env for $domain."
fi

curl -fsSL "$REPO/docker-compose.yml" -o docker-compose.yml || fail "Could not download the compose file from $REPO."

say "Starting Nook..."
docker compose pull --quiet
docker compose up -d --remove-orphans

domain=$(sed -n 's/^CATHODE_DOMAIN=//p' .env | head -n 1)
if grep -q '^COMPOSE_PROFILES=.*tls' .env; then tls=1; else tls=0; fi
if [ "$tls" = 1 ]; then
  url="https://$domain"
  say "Waiting for it to answer at $url (its first HTTPS certificate can take a minute)..."
else
  url="http://127.0.0.1:8787"
  say "Waiting for it to answer at $url..."
fi
i=0
until curl -fsS "$url/api/v1/health" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    say ""
    say "It has not answered at $url yet. Check that:"
    say "  - the domain's DNS points at this machine"
    say "  - ports 80 and 443 (TCP) are open, and 3478 and 49160-49260 (UDP) for calls"
    say "Then see what it says: cd $(pwd) && docker compose logs -f"
    exit 1
  fi
  sleep 3
done

say ""
say "Nook is running at https://$domain"
[ "$tls" = 1 ] || say "  (behind your own proxy: send https://$domain to port 8787 here, with CATHODE_BIND=0.0.0.0 if it runs elsewhere)"
say ""
say "  Use it:     open Nook, choose Add server, and type $domain"
say "  Update:     run this command again"
say "  Settings:   $(pwd)/.env, then: docker compose up -d"
say "  Logs:       cd $(pwd) && docker compose logs -f"
grep -q '^CATHODE_\(KLIPY\|TENOR\|GIPHY\)_KEY=.' .env ||
  say "  GIFs:       add CATHODE_KLIPY_KEY=your-key to .env for GIF search (a key: partner.klipy.com)"
