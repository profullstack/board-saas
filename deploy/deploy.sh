#!/bin/sh
# Deploy board-saas on dev2 (run as anthony): pull main, install, build the static site,
# refresh app.env from the vault, restart the unit, check health. "We build in prod."
#   sh deploy/deploy.sh            # from anywhere on dev2
#   sh deploy/deploy.sh --install  # first time: unit + nginx template + origin cert (needs root via ssh root@localhost)
set -eu
APP=/home/anthony/www/board-saas
STATE=/home/anthony/.local/share/board-saas
NODE=/home/anthony/.local/share/mise/installs/node/24/bin
export PATH="$NODE:$PATH"

[ -d "$APP/.git" ] || git clone https://github.com/profullstack/board-saas.git "$APP"
git -C "$APP" fetch -q origin main
git -C "$APP" reset -q --hard origin/main
cd "$APP"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
node scripts/build-static.mjs

# app.env is a synced copy of the vault (logicsrc is the master), never edited by hand.
mkdir -p "$STATE"
umask 077
TMPD=$(mktemp -d "$STATE/pull.XXXXXX")
( cd "$TMPD" && logicsrc teams pull profullstack board-saas prod >/dev/null )
if [ -s "$TMPD/.env" ]; then
  [ -f "$STATE/app.env" ] && cp "$STATE/app.env" "$STATE/app.bak-001.env"
  mv "$TMPD/.env" "$STATE/app.env"
fi
rm -rf "$TMPD"

if [ "${1:-}" = "--install" ]; then
  ssh root@localhost "install -m 0644 $APP/deploy/board-saas.service /etc/systemd/system/board-saas.service \
    && install -m 0644 $APP/deploy/board.saas.nginx.conf /etc/moshpit/templates/board.saas.conf \
    && systemctl daemon-reload && systemctl enable board-saas"
fi
ssh root@localhost systemctl restart board-saas
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:8826/healthz >/dev/null 2>&1; then
    echo "board-saas $(git rev-parse --short HEAD) is up"
    exit 0
  fi
  sleep 1
done
echo "board-saas did not come up; journalctl -u board-saas" >&2
exit 1
