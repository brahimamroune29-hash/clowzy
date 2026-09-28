#!/usr/bin/env bash
# Ship the current code to the server, build with production env, restart, health-check.
# Usage: bash deploy/deploy.sh <server-ip> <domain> ["Owner name" owner@company.com]
# First run also writes the server env file (.env.production.local) with the Icypeas key from .env.local.
# With the owner arguments it creates the owner account and prints the one-time password link.
set -euo pipefail
IP="${1:?usage: deploy.sh <server-ip> <domain> [owner-name owner-email]}"; DOMAIN="${2:?usage: deploy.sh <server-ip> <domain> [owner-name owner-email]}"
cd "$(dirname "$0")/.."   # always the app root, whatever the caller's directory: rsync --delete mirrors it
SSH_OPTS="-i $HOME/.ssh/clowzy_server -o StrictHostKeyChecking=accept-new"
SSH="ssh $SSH_OPTS root@$IP"

rsync -az --delete -e "ssh $SSH_OPTS" \
  --exclude node_modules --exclude .next --exclude .data --exclude '.env*' --exclude tsconfig.tsbuildinfo --exclude .git \
  --exclude .playwright-mcp ./ "root@$IP:/srv/clowzy/app/"

if ! $SSH test -f /srv/clowzy/app/.env.production.local; then
  KEY="$(sed -n 's/^ICYPEAS_API_KEY=//p' .env.local)"
  [ -n "$KEY" ] || { echo "ICYPEAS_API_KEY missing in .env.local"; exit 1; }
  printf 'APP_URL=https://%s\nWASL_DB_PATH=/srv/clowzy/data/wasl.sqlite\nICYPEAS_API_KEY=%s\n' "$DOMAIN" "$KEY" \
    | $SSH "umask 077 && cat > /srv/clowzy/app/.env.production.local"
fi

# ponytail: stop-build-start gives ~2 min of downtime per deploy; switch to release folders + symlink if that matters.
$SSH "systemctl stop clowzy; chown -R clowzy:clowzy /srv/clowzy/app && cd /srv/clowzy/app \
  && sudo -u clowzy npm ci --no-audit --no-fund \
  && sudo -u clowzy NODE_ENV=production npm run build \
  && systemctl start clowzy \
  && curl -fsS --retry 20 --retry-connrefused --retry-delay 1 -o /dev/null http://127.0.0.1:3100/ && echo 'app is up'"

if [ -n "${3:-}" ] && [ -n "${4:-}" ]; then
  # As the service user: a root-owned database file would make the running app read-only.
  $SSH "cd /srv/clowzy/app && sudo -u clowzy npm run -s create-owner -- $(printf '%q' "$3") $(printf '%q' "$4")"
fi
echo "Deployed. Check: curl -sI https://$DOMAIN/"
