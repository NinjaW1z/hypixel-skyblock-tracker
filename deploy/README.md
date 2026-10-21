# Running SkyFlip on Oracle Cloud

The backend runs 24/7 on your instance. The website is then reachable from any device, and the
Minecraft mod connects to the instance instead of localhost.

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
