# Running SkyFlip on Oracle Cloud

The backend runs 24/7 on your instance. The website is then reachable from any device, and the
Minecraft mod connects to the instance instead of localhost.

## 0. Create the instance

Skip this if you will reuse an existing instance. Always Free A1 capacity is shared, so if you
have two stopped instances using the full 4 OCPU / 24 GB, shrink one first (stop it, Edit, lower
OCPU and memory, start) or terminate it. Stopped instances still count.

1. Console → **Compute → Instances → Create instance**.
2. **Name**: `skyflip`. Leave compartment and availability domain as suggested.
3. **Image and shape → Edit**:
   - **Change image** → **Canonical Ubuntu** → **24.04** (Always Free eligible). Confirm.
   - **Change shape** → **Virtual machine** → **Ampere** → **VM.Standard.A1.Flex** → 1 OCPU,
     6 GB memory. Confirm.
4. **Networking**: "Create new virtual cloud network" is fine (or pick your existing VCN and its
   public subnet). Make sure **Assign a public IPv4 address** is selected.
5. **Add SSH keys** → **Generate a key pair for me** → **Save private key**. Keep that file; it is
   the only way in. (If you already have a key, paste the public key instead.)
6. **Boot volume**: defaults are fine (about 47 GB, within the 200 GB free total).
7. **Create**. If you get "Out of host capacity", A1 capacity in that availability domain is full:
   try another availability domain in the placement section, or retry later. This is common.
8. Wait for the state to turn **Running** and copy the **Public IP address** from the instance page.

## 1. Open the port in the Oracle console (the script cannot do this)

Oracle blocks inbound traffic at the network level until you allow it.

1. Console → **Networking → Virtual cloud networks** → your VCN → **Subnets** → the subnet of
   your instance → **Security Lists** → *Default Security List* → **Add Ingress Rules**.
2. Source CIDR `0.0.0.0/0` (or your home IP as `x.x.x.x/32`, safer), IP Protocol **TCP**,
   Destination Port Range **3131**, Description `skyflip`. Save.
3. If the instance uses a Network Security Group instead (Instance → **Attached NSGs**), add the
   same ingress rule to that NSG.

## 2. Install

SSH in (`ssh ubuntu@<public-ip>` on Ubuntu images, `ssh opc@<public-ip>` on Oracle Linux), then:

```bash
curl -fsSL https://raw.githubusercontent.com/ninjaw1z/hypixel-skyblock-tracker/main/deploy/install.sh | sudo bash
```

While the code is still on the `claude/flipper-build` branch, use:

```bash
curl -fsSL https://raw.githubusercontent.com/ninjaw1z/hypixel-skyblock-tracker/claude/flipper-build/deploy/install.sh \
  | sudo SKYFLIP_BRANCH=claude/flipper-build bash
```

Or clone and run: `git clone -b claude/flipper-build https://github.com/ninjaw1z/hypixel-skyblock-tracker && sudo SKYFLIP_BRANCH=claude/flipper-build bash hypixel-skyblock-tracker/deploy/install.sh`.

The script installs Node 22, creates a `skyflip` system user, checks the repo out to `/opt/skyflip`,
builds, installs a hardened systemd service, opens TCP 3131 in the host firewall (iptables on
Ubuntu images, firewalld on Oracle Linux) and prints your access token. Re-running it is safe; it
updates in place and keeps the existing token.

## 3. Connect

The installer ends with a summary. The token also lives in `/etc/skyflip/skyflip.env`:

```bash
sudo grep SKYFLIP_TOKEN /etc/skyflip/skyflip.env
```

- Website: `http://<public-ip>:3131` — paste the token when prompted.
- Mod, in Minecraft chat:
  ```
  /skyflip url ws://<public-ip>:3131/ws
  /skyflip token <token>
  ```

## 4. Logs and what they mean

```bash
sudo journalctl -u skyflip -f          # follow
sudo systemctl status skyflip          # is it running
sudo systemctl restart skyflip         # after editing /etc/skyflip/skyflip.env
```

One line per API refresh:

```
cycle 1792615026275: 47 pages, 46191 auctions, 167 new, 9 flips, detect lag 4473ms, fetch 2785ms, interval 60s, clients 2
```

- **detect lag**: time between Hypixel's own refresh timestamp and the moment page 0 started
  serving it. Measured at 4–5 s on the live API; that is Hypixel's CDN propagation and is the
  same for everyone.
- **fetch**: time to pull the whole snapshot. New listings are all on page 0, so flips go out at the
  very start of this window, not the end.
- **new / flips**: listings created since the last refresh, and how many cleared your filters.
- `FLIP ...` lines show each flip with its per-flip `lag` (stamp → emitted).

Update to the latest code with `sudo /opt/skyflip/deploy/update.sh`.

## 5. Optional: HTTPS with a domain

If you own a domain, point an A record at the instance, allow TCP 80 and 443 in the Security List
and the host firewall, install [Caddy](https://caddyserver.com/docs/install), then:

```bash
sudo cp /opt/skyflip/deploy/Caddyfile /etc/caddy/Caddyfile   # edit the hostname first
sudo systemctl restart caddy
```

Caddy obtains the certificate automatically. Use `https://your.domain` in the browser and
`/skyflip url wss://your.domain/ws` in the mod. You can then remove the 3131 ingress rule.

## 6. Region

Hypixel's API is fronted by Cloudflare, so every Oracle region gets a nearby edge. Origin latency
is lowest from US regions (Ashburn, Phoenix, San Jose, Chicago), but the 4–5 s CDN propagation
dominates, so an existing instance elsewhere is fine.

## 7. Instance size

The Always Free ARM shape (VM.Standard.A1.Flex, 1–4 OCPU, 6–24 GB) is more than enough. The
backend uses roughly 300–500 MB of RAM with the decoded-item cache and well under one core on
average, with a short burst each minute when the snapshot lands. Set `HTTP_CONNECTIONS` in the
env file to 48–64 if you have 4 OCPUs; the default is fine for 1.


## Auto-flipper

Everything below runs on the same instance as the backend. Both switches start off; the bot
account does not log in and nothing is bought until you turn them on. Automated purchasing is
against Hypixel's rules: use an account you accept losing.

### 1. Install

```bash
sudo /opt/skyflip/deploy/update.sh              # pulls this version, rebuilds, restarts the backend
sudo bash /opt/skyflip/deploy/install-bot.sh    # bot user, /etc/skyflip/bot.env, unit (disabled), sudoers rule
```

The installer creates the `skyflip-bot` system user, builds `/opt/skyflip/bot`, writes
`/etc/skyflip/bot.env` with `WEBSOCKET_URL=ws://127.0.0.1:3131/modsocket/<token>` (the token from
`/etc/skyflip/skyflip.env`) and `BOT_MODE=dry`, copies `bot/config.example.json` to
`/etc/skyflip/bot-config.json`, installs `skyflip-bot.service` **disabled and stopped**, and adds
`/etc/sudoers.d/skyflip-bot` so the backend's `skyflip` user may run exactly
`systemctl start skyflip-bot` and `systemctl stop skyflip-bot` (that is the login switch).

### 2. Bot account

```bash
sudo nano /etc/skyflip/bot.env        # MC_ACCOUNT=<microsoft e-mail of the bot account>
```

First sign-in is interactive (Microsoft device code). Run the bot once in the foreground as its
own user, follow the link it prints, enter the code with the bot account, wait for
`logged in as <name>` and `in SkyBlock at …`, then Ctrl+C:

```bash
sudo -u skyflip-bot env $(sudo grep -v '^#' /etc/skyflip/bot.env | xargs) node /opt/skyflip/bot/dist/main.js
```

The token is cached in `/var/lib/skyflip-bot/auth`; the service never needs the browser again
unless Microsoft invalidates it (the Bot tab and the journal then show the sign-in line again).

### 3. The two switches

- **Login** (bot service): website → Bot tab → *Login switch*, or `/skyflip bot on` / `off` in game,
  or `curl -X POST -H "Authorization: Bearer <token>" http://127.0.0.1:3131/api/bot/start` (`/stop`).
  The choice is remembered across backend restarts.
- **Auto-buy** (forward flips): website → Bot tab → *Auto-buy switch*, or `/skyflip autobuy on` / `off`.

Start with `BOT_MODE=dry` in `bot.env`: the bot opens every forwarded flip and logs
`DRY RUN: would confirm …` without buying. When the log looks right, set `BOT_MODE=live`, then
turn the login switch off and on again (the service re-reads the env file).

### 4. Watching it

- Bot: `sudo journalctl -u skyflip-bot -f` (every flip, click, claim, listing; `DEBUG=1` in
  `bot.env` dumps each menu with its slot names).
- Backend: `sudo journalctl -u skyflip -f | grep -E 'autobuy|FLIP'` (what was forwarded and
  why things were skipped; `BOUGHT`/`SOLD` lines come from the ended-auction feed).
- Website → **Bot** tab: both switches, pacing phase, connected bots with purse, location and
  inventory, the sell queue (cost, target, listing price, attempts), and the bridge log. The
  header shows `Auto-buy: ON · 1 bot` at a glance. Settings → Auto-buy and Pacing hold the
  thresholds.
- In game: `/skyflip` prints both switches; `/skyflip bot` prints bots, purse, queue and the last
  log lines; buys/sells/errors are announced in chat when notifications are on.
- Discord: paste a webhook into Settings → Auto-buy for buy/sell/connect messages.

### 5. Leaving it running

The unit restarts the bot on crashes; the login switch's state is persisted, so a reboot brings
the bot back if it was on. For a more human-looking presence, turn on **Pacing** in Settings
(sessions of 1–5 h, breaks of 0.5–3 h, 10 h/day by default) and optionally **Humanization**
(2–10 min breaks every 45–120 min). Both are off by default.

Useful commands:

```bash
sudo systemctl status skyflip-bot          # is it running (the switch, not the owner's wish)
sudo cat /var/lib/skyflip/bot-switch.json  # the owner's wish
sudo /opt/skyflip/deploy/update.sh         # update everything (rebuilds the bot too)
```

Do not open any extra ports: the bot talks to the backend over localhost and the website is the
only thing exposed.
