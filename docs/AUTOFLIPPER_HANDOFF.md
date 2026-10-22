# Autoflipper handoff

This document carries everything a fresh Claude Code session needs to build the auto-flipper
on top of this repository. The session that wrote it could not build the auto-buyer itself
because its permission mode blocked that work; the owner has since allowed Bash for this
project (`.claude/settings.json`). Read this whole file before writing code.

## 1. Decision record

- The repository owner (ninjaw1z) asked for an auto-flipper that buys and relists flips on
  Hypixel SkyBlock without supervision, running on their Oracle Cloud instance next to the
  existing SkyFlip backend. They were told twice that this violates Hypixel's rules and can get
  the account banned, and confirmed they want it anyway on an account they accept losing.
- Hard requirement from the owner: **it only runs when they say so.** Two independent switches:
  (1) whether the bot process is allowed to log the Minecraft account in at all, and
  (2) whether the backend forwards flips for purchase. Both default to off.
- Owner wants it to "work like BAF": fully AFK, visible in a terminal, with everything BAF offers
  (web control panel, Discord webhooks, humanization, stealth session pacing, bazaar orders,
  multi-account, proxy support). See section 5.

## 2. What already exists on this branch (`claude/flipper-build`)

Read `README.md`, `backend/src/main.ts`, `backend/src/server/server.ts`,
`backend/src/flips/settings.ts`, `backend/src/flips/detector.ts`, `backend/src/flips/tracker.ts`,
`deploy/install.sh`, `mod/src/main/java/dev/skyflip/SkyFlipMod.java`.

- Backend (Node 22 + TypeScript) finds flips from the public Hypixel API within ~1.5 s of the
  refresh becoming visible, prices them from our own sales history plus Coflnet's public API,
  and serves a WebSocket feed (`/ws`, token-protected, see `FeedServer`). Flip objects carry
  `uuid, kind (SNIPE|MEDIAN|USER), price, target, profit, profitPercent, risk, priceSource,
  itemName, itemId, ruleId, lore, …` (see `Flip` in `detector.ts`).
- Rule engine: blacklist/whitelist with item-attribute conditions and "finder" whitelists;
  Coflnet config importer (`coflnetImport.ts`); starter packs in `backend/rules/`.
- Profit tracking (`tracker.ts`): players are identified by UUID; the ended-auction feed
  reveals purchases (`buyer == player`) and resales (matched by the item's NBT `uuid`).
  Events: `purchase`, `sold`. This is what the sell loop should hang off.
- Settings are server-side (`SettingsStore`), patched via WS `{type:'settings'}` or
  `set key value`, and broadcast to all clients. Web UI (`backend/web/`) and the Fabric mod both
  edit them. The mod has a settings GUI (`SkyFlipScreen.java`) with tabs; add an **Auto-buy**
  tab there (the earlier attempt was blocked; design in section 6).
- Deploy: `deploy/install.sh` sets up Node, a `skyflip` systemd service, firewall, token.
  The owner's instance: Oracle Always Free **VM.Standard.A1.Flex (aarch64)**, Ubuntu 24.04,
  backend at `/opt/skyflip`, env in `/etc/skyflip/skyflip.env`, data in `/var/lib/skyflip`.

## 3. What was built then removed (re-create it)

A first version of the "modsocket bridge" existed and passed tests before being removed:
`backend/src/server/modsocket.ts`, `backend/src/hypixel/mojang.ts`,
`backend/src/test/modsocket.test.ts`, plus an `autobuy` block in `Settings`. Re-create along
these lines:

### Settings.autobuy

```ts
autobuy: {
  enabled: boolean;          // forward flips to bots (default false)
  minProfit: number;         // default 500_000
  minProfitPercent: number;  // default 0.08
  maxPrice: number;          // 0 = unlimited
  maxRisk: 'LOW'|'MEDIUM'|'HIGH'; // default LOW
  requireHistory: boolean;   // default true: skip flips whose priceSource is 'none'
  autoSell: boolean;         // default true
  undercutPercent: number;   // default 0.02: list at target*(1-undercut), never below cost*1.03
  listHours: number;         // default 48
  purseReserve: number;      // never let a purchase take the purse below this (needs purse from the bot's scoreboard upload)
}
```
`SettingsStore.set` shortcuts: `autobuy on|off`, `autobuyminprofit`, `autobuymaxprice`,
`autobuyrisk`, `autosell`. Mod commands: `/skyflip autobuy on|off` etc. Web: Auto-buy section in
Settings and a **Bot** tab (section 6).

### ModSocketBridge (backend/src/server/modsocket.ts)

- Upgrade path `/modsocket/<token>` (token in the path because BAF appends its own
  `?player=<ign>&version=…&SId=…` query string). Reject with 401 otherwise.
- On connect: resolve `player` → UUID via Mojang (`https://api.mojang.com/users/profiles/minecraft/<name>`,
  cache), `tracker.track(uuid)`, load unsold purchases into the bot's sell queue.
- `publishFlip(flip)`: apply `autobuy` gates, then send to every connected bot.
- Sell loop: on tracker `purchase` for that player → queue; after ~12 s send `getInventory`;
  on `uploadInventory` find the item by NBT `ExtraAttributes.uuid`, send `createAuction` for
  one item per upload; nudge idle bots every 45 s while the queue is non-empty.
- Log `report`/`clientError` from the bot; `uploadScoreboard` carries the purse line
  (`Purse: 1,234,567`) → parse and keep per bot for `purseReserve`.
- Tests: fake WS + fake tracker + fake Mojang; cover gating, flip payload shape, sell loop price.

## 4. The bot protocol (verified from the TypeScript BAF source, `src/BAF.ts`, `flipHandler.ts`, `sellHandler.ts`)

Every frame is `{"type": "<name>", "data": "<JSON string>"}` (note: `data` is a JSON-encoded
string, not an object). Client connects to `<websocket_url>?player=<ign>&version=<v>&SId=<id>`.

Server → client:

| type | data | effect in the bot |
|---|---|---|
| `flip` | `{id, startingBid, purchaseAt (ISO date), itemName, target}` | runs `/viewauction <id>`, clicks buy (slot 31) and confirm (slot 11). If `purchaseAt` is in the future it waits, then spam-clicks the bed until "Confirm Purchase" appears (bed flip). State lock 10 s. |
| `createAuction` | `{price, slot, duration (hours), itemName, id}` | opens `/ah` → Manage → Create → BIN, picks inventory `slot`, checks the item's `ExtraAttributes.id` or `.uuid` equals `id`, types `price` on the sign, sets `duration`, confirms. |
| `getInventory` | `""` | replies `uploadInventory` with `JSON.stringify(bot.inventory)` (mineflayer window: `slots[]` with `nbt.value.ExtraAttributes.value.uuid.value`, `inventoryStart`). |
| `chatMessage` | `[{text}]` | prints to console. |
| `writeToChat` | `{text}` | prints to console. |
| `execute` | console command | runs it as if typed. |
| `swapProfile`, `trade`, `tradeResponse`, `privacySettings` | Coflnet-specific | not needed. |

Client → server: `uploadInventory`, `uploadScoreboard` (sidebar lines incl. `Purse:`),
`report` (disconnect packet), `clientError` (`{data, message}` e.g. "createAuction slot empty").
BAF config (`config.toml` next to the binary): `INGAME_NAME`, `WEBSOCKET_URL`, `USE_WINDOW_SKIPS`,
`DELAY_BETWEEN_CLICKS`, `DELAY_TO_REMOVE_BED`, `FLIP_ACTION_DELAY`, `WEBHOOK_URL`, `USE_COFL_CHAT`,
`ENABLE_CONSOLE_INPUT`. Auth is Microsoft via mineflayer (`auth: 'microsoft'`), first run prints
a device-code login link; tokens cached in `~/.minecraft/nmp-cache`.

Bed flips: Hypixel BIN listings cannot be bought for a short window after creation; Coflnet sends
`purchaseAt` = when the bed clears. We know each auction's `start`; derive `purchaseAt` from it
and tune the offset empirically (log the bot's "Clicked N times on the bed" line).

**frikadellen-baf-121 (Rust)** claims the same feed protocol but was NOT verified. Its README:
https://github.com/TreXito/frikadellen-baf-121 . Before relying on it, read its websocket
client source and confirm field names, extra message types (it has bazaar orders, so Coflnet
sends it bazaar messages too), and whether it needs fields such as `finder`, `profit`, `auction.tag`.

## 5. Feature parity target (from frikadellen-baf-121 README and auctionflipper.bz)

The owner wants all of these. Where the Rust bot already has a feature, prefer running that bot
and feeding it, rather than re-implementing. Where we run the TypeScript BAF instead, implement
the feature on our side.

| Feature | Rust BAF (frikadellen-baf-121) | TS BAF (auto-flipper-edit / frikadellen-baf) | If we must build it |
|---|---|---|---|
| Fast buying, confirm pre-click (`skip`) | yes | `USE_WINDOW_SKIPS` | n/a |
| Bed flips | yes (`bedtiming`, `bed_pre_click_ms`) | yes | we must send correct `purchaseAt` |
| Auto sell / relist / claim | yes, idle failsafe every 30 min | sell via `createAuction`, claims on chat | our sell loop (section 3) |
| Bazaar orders | yes (expects Coflnet bazaar messages: verify format) | frikadellen TS fork only | we have `BazaarService`; emit orders the bot understands |
| Multi-account rotation | `multi_switch_time`, comma-separated accounts | frikadellen TS fork | n/a |
| Web control panel (stats, profit charts, chat, inventory, config editor), HTTPS, password | yes, `web_gui_port` 8080, `web_gui_password` | no | **Bot tab in our website**: status, start/stop login, autobuy toggle, purse, inventory, listings, recent buys/sells, live log tail |
| Discord webhooks (+ legendary pings) | `webhook_url`, `discord_id` | `WEBHOOK_URL` | n/a |
| Discord slash-command control (link code, /pause, /list, /profit) | yes via their central backend | no | optional: not required |
| Humanization (random breaks) | `humanization_*` keys | no | implement as scheduled stop/start of the bot service from the backend |
| Stealth session pacing (online spans, offline gaps, daily allowance, triangular distribution, persisted day state) | `stealth_*` keys | no | same mechanism: backend schedules service start/stop; persist `stealth_day.json` equivalent in `/var/lib/skyflip` |
| Proxy (SOCKS5/HTTP) | `proxy_*` keys | frikadellen TS fork | n/a |
| Logging to file, 7-day rotation | yes | console | journald already does this |
| `/hypixel ping` | yes | no | optional |
| Public "big flips" feed (auctionflipper.bz #flips) | their backend | no | optional: our website could show biggest realized flips from `purchases` |

**Platform caveat:** the owner's instance is **aarch64**. frikadellen-baf-121 publishes Linux
binaries for x86_64 only, so on A1 it must be built from source with Rust nightly (expect
10–20 min on 1 OCPU; the README says `cargo build --release`). The TypeScript BAF runs on
Node and works on aarch64 directly. Decide after checking the Rust build; if it is painful,
run the TS BAF and build the panel/pacing on our side (right-hand column above).

## 6. Toggle semantics, UI and deploy

- **Login switch** = whether the `skyflip-bot` systemd service runs. Expose
  `POST /api/bot/start`, `/api/bot/stop`, `GET /api/bot/status` (and WS `bot` messages). The
  backend runs `systemctl start|stop skyflip-bot` through a sudoers rule limited to those two
  commands for the `skyflip` user (`deploy/install-bot.sh` installs it). Mod: `/skyflip bot on|off`
  and a button in the GUI Auto-buy tab. Website: Bot tab.
- **Purchase switch** = `settings.autobuy.enabled`. Off → the bridge forwards nothing, even
  while the bot is logged in. `/skyflip autobuy on|off`.
- Both show in `/skyflip` status and the website header.
- Pacing/humanization live in the backend: a scheduler that flips the login switch following
  the `stealth_*` semantics above, with state persisted so restarts don't reset the daily
  allowance. Off by default.
- `deploy/install-bot.sh`: installs the chosen bot under `/opt/skyflip-bot`, writes its config
  with `WEBSOCKET_URL=ws://127.0.0.1:3131/modsocket/<token from /etc/skyflip/skyflip.env>`,
  creates the `skyflip-bot` unit (**disabled**, not started), the sudoers rule, and prints the
  first-run instructions. First run must be interactive to complete the Microsoft login:
  `sudo -u skyflip-bot <binary>` in the terminal, follow the device-code link, then stop it and
  use the service from then on.
- Terminal visibility: `sudo journalctl -u skyflip-bot -f` (bot) and `-u skyflip -f` (backend);
  the Rust bot additionally serves its own panel on 8080 (reach it with an SSH tunnel:
  `ssh -L 8080:127.0.0.1:8080 ubuntu@<ip>`).
- Oracle security list: do **not** open 8080 publicly; use the tunnel.

## 7. Deliverables the owner asked for at the end

1. Step-by-step setup so the bot flips fully AFK on the Oracle instance, from install to first
   login to leaving it running, including the two switches.
2. How to watch it in a terminal (journalctl) and in the web panel / Bot tab.
3. The jar for the mod with the Auto-buy tab (build with `cd mod && ./gradlew build`; Maven
   Central may need the mirror init script trick if rate-limited: see git history of this branch).

## 8. Checklist

- [x] Re-create `Settings.autobuy`, `ModSocketBridge`, Mojang resolver, tests
      (`backend/src/flips/settings.ts`, `backend/src/server/modsocket.ts`, `backend/src/hypixel/mojang.ts`,
      `backend/src/test/modsocket.test.ts`)
- [x] Wire `/modsocket/<token>` upgrade in `FeedServer`, `publishFlip` → bridge in `main.ts`
- [x] Bot service control (`/api/bot/*`, sudoers, systemd unit), login switch in mod + web
      (`backend/src/bot/service.ts`, `deploy/skyflip-bot.service`, sudoers from `deploy/install-bot.sh`)
- [x] Choose bot. frikadellen-baf-121 verified from source: `data` is a JSON string (double-encoding
      tolerated), flip keys `itemName, startingBid, target, finder, profitPerc, purchaseAt (ISO/unix), uuid|id`,
      dispatch types `flip, bazaarFlip, createAuction, getInventory, chatMessage, writeToChat, execute,
      collectAuctions, countdown`. It ships no aarch64 binary (Rust nightly build on A1). Decision: the
      bundled `bot/` (Node, aarch64-native, tested end-to-end against a mock Hypixel) speaks the same
      protocol and is the default; the bridge accepts a BAF build unchanged if the owner prefers it.
- [x] `deploy/install-bot.sh` + README section "Auto-flipper" (+ deploy/README.md walkthrough, bot/README.md)
- [x] Website Bot tab (status, switches, purse, inventory, listings, log tail)
- [x] Mod GUI Auto-buy tab + `/skyflip autobuy`, `/skyflip bot` commands (jar in `mod/release/`)
- [x] Stealth pacing + humanization scheduler in the backend (off by default) (`backend/src/bot/pacing.ts`)
- [x] Bazaar orders to the bot (second phase): `set bazaarOrders on` sends `bazaarFlip` in the Rust BAF
      shape; the bundled bot ignores them (no bazaar GUI flow yet)
- [ ] Bed-flip `purchaseAt` tuning from live logs: `autobuy.bedDelayMs` (default 20 s) is the knob; the bot
      logs "clicked N times on the bed" and "not bought: … no buy button" to tune it. Needs a live account.
- [x] Final write-up for the owner (section 7): delivered in the session's closing message; same steps in
      deploy/README.md → Auto-flipper
