# SkyFlip mod (Fabric, Minecraft 1.21.1)

Client-side mod that connects to the SkyFlip backend's WebSocket feed and shows flips in chat.

- Each flip is a clickable chat line. Clicking runs `/viewauction <id>`, which opens Hypixel's
  own auction GUI. You confirm the purchase there by hand.
- `V` opens the newest flip, `B` opens the most profitable flip from the last 20 seconds.
  Rebind both under Options → Controls → SkyFlip.
- `/skyflip` shows status and lists the sub-commands (toggle, sound, reconnect, url, risk,
  minprofit, maxprice, hypixelonly).

Nothing in the mod buys, bids, or runs a command without your click or key press. That keeps it
on the same side of Hypixel's rules as the Coflnet mod, which works the same way.

## Build

Requires JDK 21 and internet access to `maven.fabricmc.net`, `piston-meta.mojang.com`,
`libraries.minecraft.net` and Maven Central.

```
cd mod
./gradlew build
```

The jar lands in `build/libs/skyflip-0.1.0.jar`. Drop it into your `.minecraft/mods` folder next to
the matching [Fabric API](https://modrinth.com/mod/fabric-api) jar for 1.21.1, using the Fabric
loader for 1.21.1.

To target another Minecraft version, update `minecraft_version`, `yarn_mappings`,
`loader_version` and `fabric_version` in `gradle.properties` from https://fabricmc.net/develop.

## Config

`config/skyflip.json` is created on first launch:

```json
{
  "url": "ws://127.0.0.1:3131/ws",
  "enabled": true,
  "sound": true,
  "hypixelOnly": true,
  "maxRisk": "HIGH",
  "staleAfterSeconds": 20
}
```
