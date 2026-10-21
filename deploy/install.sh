#!/usr/bin/env bash
# SkyFlip backend installer for Oracle Cloud (Oracle Linux 8/9 or Ubuntu 22.04/24.04, x86_64 or aarch64).
# Idempotent: safe to re-run. Set DRY_RUN=1 to print the steps without changing the system.
#
#   curl -fsSL https://raw.githubusercontent.com/ninjaw1z/hypixel-skyblock-tracker/main/deploy/install.sh | sudo bash
#   SKYFLIP_BRANCH=claude/flipper-build curl -fsSL ... | sudo -E bash
set -euo pipefail

REPO_URL="${SKYFLIP_REPO:-https://github.com/ninjaw1z/hypixel-skyblock-tracker.git}"
BRANCH="${SKYFLIP_BRANCH:-main}"
INSTALL_DIR="${SKYFLIP_DIR:-/opt/skyflip}"
DATA_DIR="${SKYFLIP_DATA_DIR:-/var/lib/skyflip}"
ENV_DIR=/etc/skyflip
ENV_FILE="$ENV_DIR/skyflip.env"
SERVICE_USER=skyflip
PORT="${SKYFLIP_PORT:-3131}"
NODE_MAJOR=22
DRY_RUN="${DRY_RUN:-0}"

log()  { printf '\033[1;34m[skyflip]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[skyflip]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[skyflip]\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf '  (dry-run) %s\n' "$*"; else "$@"; fi; }

need_root() {
  if [ "$DRY_RUN" != 1 ] && [ "$(id -u)" -ne 0 ]; then die "run as root (sudo bash install.sh)"; fi
}

# ---- distro / arch detection -------------------------------------------------
PKG=""
detect_distro() {
  # shellcheck disable=SC1091
  [ -r /etc/os-release ] && . /etc/os-release
  if command -v dnf >/dev/null 2>&1; then PKG=dnf
  elif command -v yum >/dev/null 2>&1; then PKG=yum
  elif command -v apt-get >/dev/null 2>&1; then PKG=apt
  else die "unsupported distro: need dnf/yum (Oracle Linux) or apt (Ubuntu)"; fi
  log "distro: ${PRETTY_NAME:-unknown} · package manager: $PKG · arch: $(uname -m)"
}

node_arch() {
  case "$(uname -m)" in
    x86_64) echo x64 ;;
    aarch64|arm64) echo arm64 ;;
    *) die "unsupported CPU architecture $(uname -m)" ;;
  esac
}

# ---- packages -----------------------------------------------------------------
# Fresh cloud images run unattended-upgrades on first boot and hold the dpkg lock for minutes.
wait_for_apt() {
  local waited=0
  while fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock >/dev/null 2>&1 \
     || pgrep -x apt-get >/dev/null || pgrep -x apt >/dev/null || pgrep -f unattended-upgrade >/dev/null; do
    if [ "$waited" -eq 0 ]; then log "waiting for the system's automatic updates to release the package lock"; fi
    sleep 5; waited=$((waited + 5))
    if [ "$waited" -ge 900 ]; then log "still locked after 15 minutes; giving up"; exit 1; fi
  done
  [ "$waited" -gt 0 ] && log "package lock released after ${waited}s"
  return 0
}

install_base() {
  log "installing git, curl, openssl"
  case "$PKG" in
    apt) wait_for_apt
         run env DEBIAN_FRONTEND=noninteractive apt-get update -qq
         run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl ca-certificates openssl gnupg ;;
    dnf|yum) run "$PKG" install -y -q git curl ca-certificates openssl ;;
  esac
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v major minor
  v="$(node -p 'process.versions.node' 2>/dev/null)" || return 1
  IFS=. read -r major minor _ <<<"$v"
  [ -n "${major:-}" ] && [ -n "${minor:-}" ] || return 1
  # node:sqlite is unflagged from 22.13
  [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 13 ]; }
}

install_node_nodesource() {
  log "installing Node $NODE_MAJOR from NodeSource"
  case "$PKG" in
    apt)
      run bash -c "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -"
      run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs ;;
    dnf|yum)
      run bash -c "curl -fsSL https://rpm.nodesource.com/setup_${NODE_MAJOR}.x | bash -"
      run "$PKG" install -y -q nodejs ;;
  esac
}

install_node_tarball() {
  # Fallback: official binaries straight from nodejs.org into /usr/local.
  local arch; arch="$(node_arch)"
  local ver
  ver="$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" | grep -o "node-v${NODE_MAJOR}\.[0-9]*\.[0-9]*-linux-${arch}\.tar\.xz" | head -1)"
  [ -n "$ver" ] || die "could not determine latest Node $NODE_MAJOR tarball"
  log "installing $ver from nodejs.org"
  local tmp; tmp="$(mktemp -d)"
  run curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/$ver"
  run tar -xJf "$tmp/node.tar.xz" -C /usr/local --strip-components=1 --no-same-owner
  run rm -rf "$tmp"
  # systemd unit uses /usr/bin/node
  run ln -sf /usr/local/bin/node /usr/bin/node
  run ln -sf /usr/local/bin/npm /usr/bin/npm
}

ensure_node() {
  if node_ok; then log "node $(node -v) already present"; return; fi
  if ! install_node_nodesource || ! node_ok; then
    warn "NodeSource install failed or too old; falling back to nodejs.org tarball"
    install_node_tarball
  fi
  [ "$DRY_RUN" = 1 ] || node_ok || die "Node >= 22.13 is required, found $(node -v 2>/dev/null || echo none)"
  [ "$DRY_RUN" = 1 ] || log "node $(node -v) ready"
  # Unit file hardcodes /usr/bin/node; make sure it resolves.
  if [ "$DRY_RUN" != 1 ] && [ ! -x /usr/bin/node ] && command -v node >/dev/null; then ln -sf "$(command -v node)" /usr/bin/node; fi
}

# ---- user, dirs, checkout ------------------------------------------------------
ensure_user() {
  if id "$SERVICE_USER" >/dev/null 2>&1; then log "user $SERVICE_USER exists"; return; fi
  log "creating system user $SERVICE_USER"
  run useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin --user-group "$SERVICE_USER" \
    || run useradd --system --home-dir "$DATA_DIR" --shell /sbin/nologin --user-group "$SERVICE_USER"
}

checkout() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    log "updating $INSTALL_DIR (branch $BRANCH)"
    run git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
    run git -C "$INSTALL_DIR" checkout -q -B "$BRANCH" FETCH_HEAD
  else
    log "cloning $REPO_URL ($BRANCH) into $INSTALL_DIR"
    run git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  fi
}

build() {
  log "building backend"
  run bash -c "cd '$INSTALL_DIR/backend' && npm ci --no-audit --no-fund --loglevel=error && npm run build"
  # Code is read-only for the service; data dir is the only writable path.
  run chown -R root:root "$INSTALL_DIR"
  run mkdir -p "$DATA_DIR"
  run chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
  run chmod 750 "$DATA_DIR"
}

# ---- env + token ------------------------------------------------------------
TOKEN=""
ensure_env() {
  run mkdir -p "$ENV_DIR"
  if [ -f "$ENV_FILE" ] && grep -q '^SKYFLIP_TOKEN=' "$ENV_FILE"; then
    TOKEN="$(sed -n 's/^SKYFLIP_TOKEN=//p' "$ENV_FILE" | head -1)"
    log "keeping existing $ENV_FILE"
    return
  fi
  TOKEN="$(openssl rand -hex 24)"
  log "writing $ENV_FILE"
  if [ "$DRY_RUN" = 1 ]; then printf '  (dry-run) write env file with PORT=%s DATA_DIR=%s SKYFLIP_TOKEN=<random>\n' "$PORT" "$DATA_DIR"; return; fi
  umask 077
  cat > "$ENV_FILE" <<ENV
# SkyFlip backend environment. Restart after editing: sudo systemctl restart skyflip
PORT=$PORT
DATA_DIR=$DATA_DIR
# Shared secret required by the web UI and the mod (/skyflip token <value>).
SKYFLIP_TOKEN=$TOKEN
# Parallel connections to the Hypixel API (the AH has ~50-100 pages).
HTTP_CONNECTIONS=48
# Set to 1 for verbose logs.
DEBUG=
ENV
  chmod 600 "$ENV_FILE"
}

# ---- systemd -----------------------------------------------------------------
install_service() {
  log "installing systemd unit"
  local unit="$INSTALL_DIR/deploy/skyflip.service"
  if [ "$DRY_RUN" = 1 ]; then printf '  (dry-run) sed paths into %s -> /etc/systemd/system/skyflip.service\n' "$unit"; return; fi
  sed -e "s#WorkingDirectory=/opt/skyflip/backend#WorkingDirectory=$INSTALL_DIR/backend#" \
      -e "s#EnvironmentFile=/etc/skyflip/skyflip.env#EnvironmentFile=$ENV_FILE#" \
      -e "s#ReadWritePaths=/var/lib/skyflip#ReadWritePaths=$DATA_DIR#" \
      "$unit" > /etc/systemd/system/skyflip.service
  systemctl daemon-reload
  systemctl enable skyflip >/dev/null
  systemctl restart skyflip
}

# ---- host firewall -------------------------------------------------------------
open_firewall() {
  if command -v firewall-cmd >/dev/null 2>&1 && { [ "$DRY_RUN" = 1 ] || firewall-cmd --state >/dev/null 2>&1; }; then
    log "firewalld: opening tcp/$PORT"
    run firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null
    run firewall-cmd --reload >/dev/null
    return
  fi
  if command -v iptables >/dev/null 2>&1; then
    # Oracle's Ubuntu images carry an iptables ruleset that REJECTs anything not listed before the
    # final REJECT rule. Insert our ACCEPT ahead of it (position 6 is after the stock rules); skip if present.
    if iptables -C INPUT -p tcp -m state --state NEW -m tcp --dport "$PORT" -j ACCEPT 2>/dev/null; then
      log "iptables: tcp/$PORT already allowed"
    else
      log "iptables: opening tcp/$PORT"
      run iptables -I INPUT 6 -p tcp -m state --state NEW -m tcp --dport "$PORT" -j ACCEPT \
        || run iptables -I INPUT 1 -p tcp -m state --state NEW -m tcp --dport "$PORT" -j ACCEPT
    fi
    if command -v netfilter-persistent >/dev/null 2>&1; then run netfilter-persistent save >/dev/null 2>&1 || true
    elif [ -d /etc/iptables ]; then run bash -c "iptables-save > /etc/iptables/rules.v4"
    fi
    return
  fi
  warn "no firewalld or iptables found; make sure tcp/$PORT is reachable"
}

summary() {
  local ip
  ip="$(curl -fsS -m 3 http://169.254.169.254/opc/v1/vnics/ 2>/dev/null | grep -o '"publicIp" *: *"[^"]*"' | head -1 | sed 's/.*: *"//;s/"//' || true)"
  [ -n "$ip" ] || ip="$(curl -fsS -m 3 https://ifconfig.me 2>/dev/null || true)"
  [ -n "$ip" ] || ip='<public-ip>'
  cat <<SUM

================================================================================
 SkyFlip is installed and running.

 Web UI :  http://$ip:$PORT
 Feed   :  ws://$ip:$PORT/ws
 Token  :  ${TOKEN:-(see $ENV_FILE)}

 In Minecraft:
   /skyflip url ws://$ip:$PORT/ws
   /skyflip token ${TOKEN:-<token>}

 Logs   :  sudo journalctl -u skyflip -f
 Update :  sudo $INSTALL_DIR/deploy/update.sh

 Still needed in the Oracle Cloud console: an ingress rule for TCP $PORT on the
 subnet's Security List (or an NSG on this instance). See deploy/README.md.
================================================================================
SUM
}

main() {
  need_root
  detect_distro
  install_base
  ensure_node
  ensure_user
  checkout
  build
  ensure_env
  install_service
  open_firewall
  summary
}
main "$@"
