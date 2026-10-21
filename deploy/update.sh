#!/usr/bin/env bash
# Pull the latest code, rebuild, restart. Run as root: sudo /opt/skyflip/deploy/update.sh
set -euo pipefail
INSTALL_DIR="${SKYFLIP_DIR:-/opt/skyflip}"
BRANCH="${SKYFLIP_BRANCH:-$(git -C "$INSTALL_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
cd "$INSTALL_DIR"
echo "[skyflip] updating $INSTALL_DIR to origin/$BRANCH"
git fetch --depth 1 origin "$BRANCH"
git checkout -q -B "$BRANCH" FETCH_HEAD
cd backend
npm ci --no-audit --no-fund --loglevel=error
npm run build
cd ..
if [ -f deploy/skyflip.service ] && ! cmp -s deploy/skyflip.service /etc/systemd/system/skyflip.service; then
  echo "[skyflip] unit file changed upstream; re-run deploy/install.sh to apply it"
fi
systemctl restart skyflip
sleep 1
systemctl --no-pager --lines=5 status skyflip || true
echo "[skyflip] done · follow logs with: journalctl -u skyflip -f"
