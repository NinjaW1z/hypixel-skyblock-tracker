# SkyFlip — Hypixel SkyBlock auction tracker & flipper

A self-hosted auction-house flip finder in the style of Coflnet's sniper, built for the lowest
latency the public API allows, plus a Fabric mod that puts the flips in your chat with one-click
`/viewauction`.

```
backend/   Node 22 + TypeScript: ingestion, pricing, flip detection, bazaar flips, profit tracking, web UI, WebSocket feed
mod/       Fabric 1.21.1 client mod: chat feed, keybinds, /skyflip commands
deploy/    One-command install for an Oracle Cloud (or any Linux) instance, systemd unit, optional HTTPS
```

## Feature map against Coflnet Premium+

| Coflnet feature | SkyFlip |
|---|---|
| Instant flip delivery | Yes. There is no artificial delay for anyone. |
| Pre-API flips | No. Those come from Coflnet's mod-user network and cannot be reproduced. |
| Sniper + median finders | Yes. SNIPE (next-lowest BIN) and MEDIAN (trimmed median of recent sales), with Coflnet's public price API as a bootstrap reference until our own history is deep. |
| Blacklist / whitelist with per-item filters | Yes. Rules with item (exact or prefix*), rarity, kind, price, profit, percent, volume and risk conditions. Whitelist bypasses thresholds. |
| `/cofl set …` settings | `/skyflip set <key> <value>` plus shortcuts: minprofit, minpercent, purse, minvolume, mode, tier, risk. |
| Lore on hover, lbin/median/volume/seller toggles | Yes. `/skyflip show <field>`, `/skyflip lore`. |
| Flip sound and ping on big flips | Yes. `/skyflip sound`, `/skyflip ping <coins>`. |
| Profit tracking | Yes. The mod identifies your player UUID; buys and resales are matched by item UUID. `/skyflip profit [days]` and the Profit tab. |
| Bazaar flipper | Yes. Order-spread flips with weekly volume, tax, profit per hour and risk. `/skyflip bazaar [n]` and the Bazaar tab. Craft flips are not included yet. |
| Website | Yes. Flips, Bazaar, Profit and Settings tabs, token protected, usable from a phone when hosted on your server. |
| Multiple accounts | Yes. Every connected mod identifies its own player; the backend tracks all of them. |

## How it works

1. **Refresh detection.** Hypixel's `/skyblock/auctions` cache refreshes roughly once a minute and
   every page carries the refresh timestamp. The poller learns the cadence, sleeps until just
   before the next refresh, then probes page 0 every 120 ms. The moment the timestamp changes it
   fans out all other pages at once over a keep-alive connection pool.
2. **Page 0 is the flip page.** Hypixel orders the listing newest-first, so every auction created
   since the last refresh sits on page 0, the same page the probe downloads. New listings are
   diffed against the previous snapshot, evaluated and pushed to the feed the moment that page
   is parsed. The remaining pages only refresh the lowest-BIN index and are fetched in parallel
   afterwards.
3. **Decode once.** Item NBT (`item_bytes`) is decoded and keyed once per auction id and cached
   across snapshots. Each cycle only pays for the few thousand new listings.
4. **Two price references.**
   - **SNIPE**: the next-lowest active BIN for the same comparable key. Works from the first
     snapshot, no history needed.
   - **MEDIAN**: the trimmed median of recent sales for the same key, fed by
     `/skyblock/auctions_ended` and persisted in SQLite so it survives restarts.
5. **Comparable keys at five tiers.** Tier 0 encodes everything that moves price (rarity, stars,
   recomb, reforge, valuable enchants, gems, attributes, pet level/skin/held item, skins, Midas
   coins, drill parts, …). Coarser tiers drop the least important modifiers so low-volume items
   still find comparables, with a haircut because dropped modifiers usually add value.
6. **Fees.** Profit is after Hypixel's BIN listing fee (1/2/3 %) and the 1 % collection tax.

What this does **not** do: pre-API flips (Coflnet sees some listings before the public API via
its mod users' in-game data; that is a network effect, not something one install can replicate),
and anything that buys for you. Both the web UI and the mod only hand you the `/viewauction`
command; the purchase is your click.

## Run on your server (recommended)

Hosting the backend on an always-on machine means price history keeps accumulating, the website is
reachable from your phone, and the mod connects from any PC. The `deploy/` folder has a one-command
installer for Oracle Cloud Always Free (or any Ubuntu / Oracle Linux box) that sets up Node 22, a
systemd service, the firewall rule and a random access token. See [deploy/README.md](deploy/README.md).

Then in game: `/skyflip url ws://<your-ip>:3131/ws` and `/skyflip token <token>`.

## Run the backend locally

Requires Node 22.13+ (uses the built-in `node:sqlite`).

```
cd backend
npm install
npm run build
npm start
```

Open http://localhost:3131. Flips appear within a second or two of each API refresh. Settings
(min profit, min %, purse cap, risk tier, black/whitelist, flip kinds) are in the UI and saved to
`backend/data/settings.json`. The WebSocket feed is `ws://localhost:3131/ws`; REST at
`/api/status`, `/api/flips`, `/api/settings`.

MEDIAN flips need sold history. Leave it running: after a day most liquid items have enough sales,
after a week nearly everything does. SNIPE flips work immediately.

Environment variables (all optional): `PORT`, `DATA_DIR`, `SKYFLIP_TOKEN` (shared secret; set it
before exposing the port), `HYPIXEL_BASE`, `HTTP_CONNECTIONS`, `PRE_REFRESH_LEAD_MS`,
`PROBE_INTERVAL_MS`, `HISTORY_DAYS`, `COFLNET=0` (disable the Coflnet price bootstrap),
`COFLNET_RPM`, `BAZAAR_INTERVAL_MS`, `DEBUG=1`. `HTTPS_PROXY`/`NO_PROXY` are honoured.

### Price data sources

Reference prices come first from our own sold-auction history (persisted in SQLite), and while that
is thin, from the public [Coflnet API](https://sky.coflnet.com/api) per item tag and rarity. Those
flips are marked `ref: coflnet` in the UI and rated at least MEDIUM risk because the Coflnet median
ignores most modifiers. Price data provided by [Coflnet](https://sky.coflnet.com), used under their
public API terms with attribution.

### Mod commands

`/skyflip` shows status, `/skyflip help` lists everything:

- client: `toggle`, `lore`, `shortnumbers`, `hypixelonly`, `notify`, `reconnect`,
  `url <ws://…>`, `token <t>`, `risk <LOW|MEDIUM|HIGH>`, `ping <coins>`,
  `show <lbin|median|volume|percent|seller|lag>`, `ah`
- sound: `sound` (toggle), `sound <preset|vanilla id>` (presets: villager, chime, pling, orb, bell,
  level, toast, click, cat, none; default is the villager's quiet hum), `sound volume <0-100>`,
  `sound pitch <50-200>`, `sound risk <LOW|MEDIUM|HIGH>`, `sound test`, `sound list`;
  `pingsound <preset|id>` plus `volume`, `pitch`, `test` for the big-flip ping
- server settings: `minprofit <n>`, `minpercent <n>`, `purse <n>`, `minvolume <n>`,
  `mode <sniper|median|all>`, `tier <0-4>`, `set <key> <value>`
- filters: `blacklist|whitelist add <item> [risk=HIGH] [minprofit=1m] [maxprice=50m]
  [minpercent=10] [kind=SNIPE] [rarity=LEGENDARY] [volume=2]`, `remove <item>`, `list`
  (aliases `bl`, `wl`; every flip line has a `[bl]` button that pre-fills the command)
- data: `bazaar [n]`, `profit [days]`

Keybinds: `V` opens the newest flip, `B` the most profitable one from the last 20 seconds,
`Right Shift` (or `/skyflip gui`) opens the settings screen: General, Display, Sound, Server
(url, token, thresholds, mode, risk) and Filters (view, add and remove rules) tabs, plus
Bazaar and Profit buttons. Client options save instantly; server options apply on Apply/Add.

## Run offline against the mock API

A local stand-in for Hypixel's API lets you exercise the whole pipeline without hitting the real
thing (and is how the project is tested in CI-like environments without internet):

```
cd backend
npm run build
MOCK_INTERVAL_MS=10000 npm run mock &
HYPIXEL_BASE=http://127.0.0.1:3999/v2 REFRESH_INTERVAL_MS=10000 npm start
```

Unit tests: `npm test`.

## Build and install the mod

See [mod/README.md](mod/README.md). Short version: JDK 21, `cd mod && ./gradlew build`, copy
`build/libs/skyflip-0.1.0.jar` into `.minecraft/mods` with Fabric API for 1.21.1. The mod connects
to `ws://127.0.0.1:3131/ws` by default; change it with `/skyflip url ws://host:port/ws` if the
backend runs on another machine.

## Tuning for speed

- Run the backend on a machine with low latency to Hypixel's API (US-east is closest).
- `HTTP_CONNECTIONS` defaults to 32; the API has ~60–100 pages, so raising it to 64 lets every
  page download in parallel at the cost of more open sockets.
- `PRE_REFRESH_LEAD_MS` (default 2500) is how early probing starts. Hypixel's cadence drifts; the
  poller adapts, but if the log shows many probes per cycle you can lower it, and if it shows a
  detect lag over ~200 ms consistently, raise it.
- Watch the per-cycle log line: `detect lag` is how long after Hypixel's own timestamp page 0
  started carrying it, `fetch` is how long the full snapshot took. Flips are emitted at the start
  of `fetch`, not after it.
- Measured against the live API: the refresh stamp becomes visible on the CDN about 4–5 s after
  the stamp itself, for everyone. That delay is Hypixel's, not yours. What you control is the
  time from visibility to flip, which is one page-0 download (~2 MB gzipped) plus a few
  milliseconds of diffing. The log's per-flip `lag` includes both.

## Rules

Hypixel allows mods that display information and run a command on your click or key press. It
does not allow automated purchasing, auto-clicking the confirm button, or macros. This project
stays on the allowed side; do not add auto-buy.
