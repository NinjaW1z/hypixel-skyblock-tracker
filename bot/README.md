# SkyFlip bot (auto-flipper)

A headless Minecraft client that buys the flips the SkyFlip backend forwards to it, claims them,
lists what the backend tells it to list, and claims the coins. It speaks the Coflnet/BAF modsocket
protocol, so the backend cannot tell it apart from a BAF build, and a BAF build can replace it.

**Automated purchasing is against Hypixel's rules and gets accounts banned. Use an account you
accept losing. The bot never logs in or buys until you turn the two switches on (see the root
README, "Auto-flipper").**

## What it does

1. Logs into Hypixel with a Microsoft account (device-code sign-in on the first run; tokens are
   cached in `authDir`), joins SkyBlock, runs `homeCommand` (`/is` by default) and parks there.
2. Connects to the backend's bridge as its Minecraft username and uploads the sidebar (purse,
   location) every 10 s and its inventory on request.
3. On `flip`: `/viewauction <id>` → verifies the item name and price in the GUI → "Buy Item Right
   Now" → "Confirm". Bed (grace-period) auctions are opened just before `purchaseAt` and the bed
   is clicked until the buy button appears.
4. After a purchase: Auction House → View Bids → claims the item (Claim All when offered), then
   uploads the inventory so the backend can send `createAuction`.
5. On `createAuction`: Manage Auctions → Create Auction → puts the slot's item in, switches to
   BIN, types the price in the sign, picks the duration preset, confirms. Reports
   `clientError` when the slot is empty, the item moved, or no auction slot is free.
6. Every 45 s when idle (never in the seconds around an API refresh): claims sold/expired
   auctions from Manage Auctions and books sales it sees there.

Everything is one GUI flow at a time; a flip always pre-empts maintenance.

## Modes

- `dry` (default): logs in, opens the auction, verifies item and price, **never clicks Confirm**,
  never lists. Use this for the first session to watch the GUI flow in the log.
- `live`: buys and lists.
- `offline`: no Minecraft at all; connects to the bridge and logs what it would buy.

## Configuration

Environment (what `deploy/install-bot.sh` writes to `/etc/skyflip/bot.env`):

| Variable | Meaning |
|---|---|
| `WEBSOCKET_URL` | `ws://127.0.0.1:3131/modsocket/<SKYFLIP_TOKEN>` (or `SKYFLIP_URL=ws://…/ws` plus `SKYFLIP_TOKEN`) |
| `BOT_MODE` | `dry`, `live` or `offline` |
| `MC_ACCOUNT` | Microsoft account e-mail of the bot account (cache key for the sign-in) |
| `MC_AUTH_DIR` | token cache directory |
| `DATA_DIR` | where `bot-state.json` (purchases, totals) lives |
| `SKYFLIP_BOT_CONFIG` | path of the JSON config below |
| `MC_HOST`, `MC_PORT`, `MC_VERSION` | default `mc.hypixel.net`, `25565`, `1.8.9` |
| `MC_AUTH=offline` | only for the local mock server |
| `DEBUG=1` | logs every window with its slot names (use this when Hypixel moves a button) |

JSON config (`config.example.json`), all optional:

- `buy`: bot-side safety net (the backend decides *what* to buy): `maxPrice`, `maxAgeMs`,
  `purseReserve`, `maxBuysPerCycle`, `maxBuysPerHour`, `maxSpendPerHour`, `maxOpenFlips`,
  `itemCooldownMs`, `requirePriceCheck`, `bedGraceMs`, `bedPreOpenMs`.
- `sell`: `enabled`, `reserveAuctionSlots`, `maxAuctionSlots` (14 without a booster cookie).
- `timing`: `commandDelayMs`, `windowTimeoutMs`, `chatTimeoutMs`, `maintenanceIntervalMs`,
  `refreshGuardMs`, `antiAfk`, `reconnectMinMs`/`reconnectMaxMs`, `scoreboardIntervalMs`.
- `minecraft.homeCommand`: command after joining SkyBlock (`/is`); empty to stay where you spawn.

## Running by hand

```bash
cd bot && npm install && npm run build
WEBSOCKET_URL=ws://127.0.0.1:3131/modsocket/<token> MC_ACCOUNT=you@example.com BOT_MODE=dry npm start
```

The first run prints `Microsoft sign-in needed: open https://www.microsoft.com/link and enter
code XXXXXXXX`. Do that in any browser with the bot account; the token is cached afterwards.

## Testing without Hypixel

`src/scripts/mock-hypixel-server.ts` is a tiny 1.8 server that imitates the auction menus
(BIN view, confirm, View Bids, Manage Auctions, Create BIN Auction with the sign and duration
menus, Claim All) and the SkyBlock sidebar. `npm test` runs the unit tests and an end-to-end
test against it: buy → claim → list on `createAuction` → sale booked → sniped purchase fails
cleanly → pause honoured. To poke at it by hand:

```bash
node dist/scripts/mock-hypixel-server.js &
MC_HOST=127.0.0.1 MC_AUTH=offline MC_ACCOUNT=Tester BOT_MODE=live WEBSOCKET_URL=ws://127.0.0.1:3131/modsocket/<token> npm start
```

## When Hypixel changes a menu

Buttons are found by display name first and by their long-standing slot numbers second
(`src/gui.ts`, `GUI`). Run with `DEBUG=1`, find the `window open "<title>" [slot:name, …]` line
for the menu that failed, and adjust the regex or fallback slot there.

## Kicks and bans

A kick whose text looks like a ban (`banned`, `suspicious activity`, `watchdog`) stops the bot
for good and reports it to the backend (Bot tab, Discord webhook). Any other disconnect
reconnects with backoff from 30 s to 10 min.
