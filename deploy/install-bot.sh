#!/usr/bin/env bash
# SkyFlip auto-flipper installer. Run on the instance that already runs the backend
# (deploy/install.sh), as root:  sudo bash /opt/skyflip/deploy/install-bot.sh
#
# Installs the bot under /opt/skyflip/bot (same checkout as the backend), a dedicated
# `skyflip-bot` user, /etc/skyflip/bot.env, the systemd unit (DISABLED and NOT STARTED), and a
# sudoers rule that lets the backend's `skyflip` user run exactly
# `systemctl start|stop skyflip-bot` (the login switch). Idempotent.
set -euo pipefail

INSTALL_DIR="${SKYFLIP_DIR:-/opt/skyflip}"
BACKEND_ENV="${SKYFLIP_ENV:-/etc/skyflip/skyflip.env}"
BOT_ENV=/etc/skyflip/bot.env
BOT_CONFIG=/etc/skyflip/bot-config.json
BOT_USER=skyflip-bot
BACKEND_USER=skyflip
BOT_DATA="${SKYFLIP_BOT_DATA_DIR:-/var/lib/skyflip-bot}"
PORT="${SKYFLIP_PORT:-3131}"
MC_ACCOUNT="${MC_ACCOUNT:-}"

log()  { printf '\033[1;34m[skyflip-bot]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[skyflip-bot]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo bash install-bot.sh)"
[ -d "$INSTALL_DIR/bot" ] || die "$INSTALL_DIR/bot not found: run deploy/install.sh first (it checks out the repo)"
[ -f "$BACKEND_ENV" ] || die "$BACKEND_ENV not found: run deploy/install.sh first"
command -v node >/dev/null || die "node not found: run deploy/install.sh first"

TOKEN="$(sed -n 's/^SKYFLIP_TOKEN=//p' "$BACKEND_ENV" | head -1)"
[ -n "$TOKEN" ] || die "SKYFLIP_TOKEN is empty in $BACKEND_ENV; the bridge refuses bots without a token"
PORT_IN_ENV="$(sed -n 's/^PORT=//p' "$BACKEND_ENV" | head -1)"; [ -n "$PORT_IN_ENV" ] && PORT="$PORT_IN_ENV"

# ---- user + dirs ----------------------------------------------------------------
if ! id "$BOT_USER" >/dev/null 2>&1; then
  log "creating system user $BOT_USER"
  useradd --system --home-dir "$BOT_DATA" --shell /usr/sbin/nologin --user-group "$BOT_USER" 2>/dev/null \
    || useradd --system --home-dir "$BOT_DATA" --shell /sbin/nologin --user-group "$BOT_USER"
fi
mkdir -p "$BOT_DATA/auth"
chown -R "$BOT_USER:$BOT_USER" "$BOT_DATA"
chmod 750 "$BOT_DATA"

# ---- build ----------------------------------------------------------------------
log "building the bot"
( cd "$INSTALL_DIR/bot" && npm ci --no-audit --no-fund --loglevel=error && npm run build )
chown -R root:root "$INSTALL_DIR/bot"

# ---- config + env ---------------------------------------------------------------
if [ ! -f "$BOT_CONFIG" ]; then
  log "writing $BOT_CONFIG (edit buy/sell/timing there)"
  install -m 640 -o root -g "$BOT_USER" "$INSTALL_DIR/bot/config.example.json" "$BOT_CONFIG"
else
  log "keeping existing $BOT_CONFIG"
fi
if [ ! -f "$BOT_ENV" ]; then
  log "writing $BOT_ENV"
  umask 077
  cat > "$BOT_ENV" <<ENV
# SkyFlip bot environment. Restart after editing: sudo systemctl restart skyflip-bot
# Bridge endpoint on the backend (same token as the backend's SKYFLIP_TOKEN).
WEBSOCKET_URL=ws://127.0.0.1:${PORT}/modsocket/${TOKEN}
# dry = open auctions but never confirm; live = buy and sell; offline = no Minecraft at all.
BOT_MODE=dry
# Microsoft account e-mail of the bot account (used as the sign-in cache key).
MC_ACCOUNT=${MC_ACCOUNT}
MC_AUTH_DIR=${BOT_DATA}/auth
DATA_DIR=${BOT_DATA}
SKYFLIP_BOT_CONFIG=${BOT_CONFIG}
DEBUG=
ENV
  chmod 640 "$BOT_ENV"; chown "root:$BOT_USER" "$BOT_ENV"
else
  log "keeping existing $BOT_ENV"
fi

# ---- systemd unit (installed, disabled, not started) --------------------------------
log "installing systemd unit skyflip-bot (disabled)"
sed -e "s#WorkingDirectory=/opt/skyflip/bot#WorkingDirectory=$INSTALL_DIR/bot#" \
    -e "s#ReadWritePaths=/var/lib/skyflip-bot#ReadWritePaths=$BOT_DATA#" \
    "$INSTALL_DIR/deploy/skyflip-bot.service" > /etc/systemd/system/skyflip-bot.service
systemctl daemon-reload
systemctl disable skyflip-bot >/dev/null 2>&1 || true

# ---- sudoers: the backend may start/stop exactly this unit ----------------------------
SYSTEMCTL="$(command -v systemctl)"
log "installing sudoers rule for $BACKEND_USER → systemctl start|stop skyflip-bot"
cat > /etc/sudoers.d/skyflip-bot <<SUDO
# Installed by skyflip deploy/install-bot.sh: the backend's login switch.
$BACKEND_USER ALL=(root) NOPASSWD: $SYSTEMCTL start skyflip-bot, $SYSTEMCTL stop skyflip-bot, $SYSTEMCTL start skyflip-bot.service, $SYSTEMCTL stop skyflip-bot.service
SUDO
chmod 440 /etc/sudoers.d/skyflip-bot
visudo -cf /etc/sudoers.d/skyflip-bot >/dev/null || die "sudoers rule failed validation"

# The backend restarts to pick up nothing new here, but make sure it runs the current code.
if systemctl is-active skyflip >/dev/null 2>&1; then
  log "restarting the backend so the bridge and Bot tab are live"
  systemctl restart skyflip
fi

cat <<SUM

================================================================================
 SkyFlip bot installed. Nothing is running and nothing is enabled.

 1. Put the bot account's Microsoft e-mail into $BOT_ENV (MC_ACCOUNT=…).
    Keep BOT_MODE=dry for the first session.
 2. First login must be interactive (Microsoft device code):
      sudo -u $BOT_USER env \$(grep -v '^#' $BOT_ENV | xargs) \\
        node $INSTALL_DIR/bot/dist/main.js
    Open the link it prints, enter the code, wait for "logged in as …", then Ctrl+C.
 3. Switches (both OFF now):
      Login   : website → Bot tab → Login switch, or  /skyflip bot on|off  in game,
                or  curl -X POST -H "Authorization: Bearer <token>" http://127.0.0.1:$PORT/api/bot/start
      Auto-buy: website → Bot tab → Auto-buy switch, or  /skyflip autobuy on|off
 4. Watch it:  sudo journalctl -u skyflip-bot -f      (bot)
               sudo journalctl -u skyflip -f          (backend; "autobuy:" lines)
 5. Go live:  set BOT_MODE=live in $BOT_ENV, then turn the login switch off and on.
================================================================================
SUM
