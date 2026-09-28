#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 droplet. Run as root: bash setup-server.sh your-domain.com
# DNS for the domain and www must already point at this droplet (Caddy requests the HTTPS certificate on start).
set -euo pipefail
DOMAIN="${1:?usage: setup-server.sh your-domain.com}"

cloud-init status --wait >/dev/null 2>&1 || true   # first boot: cloud-init / apt-daily hold the apt lock
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
APT="apt-get -y -o DPkg::Lock::Timeout=300"
$APT update && $APT upgrade
$APT install curl ufw sqlite3 rsync debian-keyring debian-archive-keyring apt-transport-https gnupg

# Node.js 22 (NodeSource) and Caddy (official apt repo: automatic HTTPS).
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
$APT install nodejs
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
$APT update && $APT install caddy

# 2 GB swap so `next build` never runs out of memory on a 2 GB droplet.
if ! swapon --show | grep -q /swapfile; then
  [ -f /swapfile ] || { fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile; }
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

id clowzy >/dev/null 2>&1 || useradd --system --create-home --home-dir /srv/clowzy --shell /usr/sbin/nologin clowzy
install -d -o clowzy -g clowzy -m 750 /srv/clowzy/app /srv/clowzy/data /srv/clowzy/backups

ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable

cat > /etc/systemd/system/clowzy.service <<'UNIT'
[Unit]
Description=clowzy platform (Next.js)
After=network.target

[Service]
User=clowzy
WorkingDirectory=/srv/clowzy/app
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable clowzy

# Caddy: HTTPS certificate, 64 KB body cap (matches the app), www -> apex. Caddy replaces any client-sent
# X-Forwarded-For with the real client IP, which the app reads as the rightmost entry.
cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
	encode gzip
	request_body {
		max_size 64KB
	}
	reverse_proxy 127.0.0.1:3100
}
www.${DOMAIN} {
	redir https://${DOMAIN}{uri} permanent
}
CADDY
systemctl reload caddy || systemctl restart caddy

# Daily consistent SQLite snapshot at 03:15, kept 14 days on this disk. Off-server copies come from
# DigitalOcean droplet backups, which must be enabled in the control panel (paid add-on).
cat > /etc/cron.d/clowzy-backup <<'CRON'
15 3 * * * clowzy sqlite3 /srv/clowzy/data/wasl.sqlite ".backup '/srv/clowzy/backups/wasl-$(date +\%F).sqlite'" && find /srv/clowzy/backups -name 'wasl-*.sqlite' -mtime +14 -delete
CRON

echo "--- checks"
echo "unattended-upgrades: $(systemctl is-enabled unattended-upgrades 2>/dev/null || echo missing)"
sshd -T 2>/dev/null | grep -E '^(passwordauthentication|permitrootlogin) ' || true
[ -f /var/run/reboot-required ] && echo "A reboot is required (new kernel): run 'reboot' once, then deploy."
echo "Server ready for ${DOMAIN}. Next: bash deploy/deploy.sh <ip> ${DOMAIN} from the developer machine."
