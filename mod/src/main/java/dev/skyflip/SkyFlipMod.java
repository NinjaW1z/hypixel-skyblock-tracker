package dev.skyflip;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandManager;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.command.v2.FabricClientCommandSource;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ServerInfo;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.InputUtil;
import net.minecraft.registry.Registries;
import net.minecraft.sound.SoundEvent;
import net.minecraft.sound.SoundEvents;
import net.minecraft.util.Identifier;
import net.minecraft.text.ClickEvent;
import net.minecraft.text.HoverEvent;
import net.minecraft.text.MutableText;
import net.minecraft.text.Text;
import org.lwjgl.glfw.GLFW;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Locale;
import java.util.UUID;

/**
 * SkyFlip client mod.
 *
 * Shows flips from your SkyFlip backend as clickable chat lines. Clicking a line, or pressing a
 * keybind, runs /viewauction for that auction; the purchase itself is always your click in the
 * confirmation GUI. Nothing here buys, bids, or acts without a key press.
 */
public final class SkyFlipMod implements ClientModInitializer {
    public static final String PREFIX = "§6[SkyFlip]§r ";
    private static final int MAX_RECENT = 30;

    private FlipConfig config;
    private FeedClient feed;
    private final Deque<Flip> recent = new ArrayDeque<>();
    private KeyBinding openLatest;
    private KeyBinding openBest;
    private KeyBinding openGui;
    /** Latest server-side settings (thresholds, filters) as sent by the backend. */
    private volatile JsonObject serverSettings;

    FlipConfig config() { return config; }
    FeedClient feed() { return feed; }
    JsonObject serverSettings() { return serverSettings; }

    @Override
    public void onInitializeClient() {
        config = FlipConfig.load();

        openLatest = KeyBindingHelper.registerKeyBinding(new KeyBinding(
            "key.skyflip.open_latest", InputUtil.Type.KEYSYM, GLFW.GLFW_KEY_V, "category.skyflip"));
        openBest = KeyBindingHelper.registerKeyBinding(new KeyBinding(
            "key.skyflip.open_best", InputUtil.Type.KEYSYM, GLFW.GLFW_KEY_B, "category.skyflip"));
        openGui = KeyBindingHelper.registerKeyBinding(new KeyBinding(
            "key.skyflip.gui", InputUtil.Type.KEYSYM, GLFW.GLFW_KEY_RIGHT_SHIFT, "category.skyflip"));

        feed = new FeedClient(config.url, config.token, this::onFlip, this::onServerMessage, this::onStatus);
        feed.start();

        ClientPlayConnectionEvents.JOIN.register((handler, sender, client) -> {
            UUID id = client.getSession().getUuidOrNull();
            feed.identify(id == null ? null : id.toString(), client.getSession().getUsername());
        });

        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            while (openLatest.wasPressed()) openFlip(newestFresh());
            while (openBest.wasPressed()) openFlip(bestFresh());
            while (openGui.wasPressed()) openGui();
        });

        ClientCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess) -> dispatcher.register(buildCommand()));
    }

    // ------------------------------------------------------------------ commands

    private LiteralArgumentBuilder<FabricClientCommandSource> buildCommand() {
        LiteralArgumentBuilder<FabricClientCommandSource> root = ClientCommandManager.literal("skyflip")
            .executes(ctx -> status());

        // client toggles
        root.then(lit("toggle", () -> { config.enabled = !config.enabled; config.save(); chat("flips " + onOff(config.enabled)); }));
        root.then(ClientCommandManager.literal("sound")
            .executes(ctx -> { config.sound = !config.sound; config.save(); chat("sound " + onOff(config.sound)); return 1; })
            .then(ClientCommandManager.literal("list").executes(ctx -> { chat("§7presets: §f" + String.join(", ", SOUND_PRESETS.keySet()) + " §7or any vanilla id, e.g. §fentity.villager.ambient"); return 1; }))
            .then(ClientCommandManager.literal("test").executes(ctx -> { playFlipSound(false); return 1; }))
            .then(ClientCommandManager.literal("volume").then(ClientCommandManager.argument("percent", IntegerArgumentType.integer(0, 100))
                .executes(ctx -> { config.soundVolume = IntegerArgumentType.getInteger(ctx, "percent") / 100f; config.save(); playFlipSound(false); chat("sound volume §e" + IntegerArgumentType.getInteger(ctx, "percent") + "%"); return 1; })))
            .then(ClientCommandManager.literal("pitch").then(ClientCommandManager.argument("percent", IntegerArgumentType.integer(50, 200))
                .executes(ctx -> { config.soundPitch = IntegerArgumentType.getInteger(ctx, "percent") / 100f; config.save(); playFlipSound(false); chat("sound pitch §e" + IntegerArgumentType.getInteger(ctx, "percent") + "%"); return 1; })))
            .then(ClientCommandManager.literal("risk").then(ClientCommandManager.argument("level", StringArgumentType.word())
                .executes(ctx -> {
                    String lvl = StringArgumentType.getString(ctx, "level").toUpperCase(Locale.ROOT);
                    if (!lvl.equals("LOW") && !lvl.equals("MEDIUM") && !lvl.equals("HIGH")) { chat("§crisk must be LOW, MEDIUM or HIGH"); return 0; }
                    config.soundMaxRisk = lvl; config.save(); chat("sound only for flips up to risk §e" + lvl); return 1;
                })))
            .then(ClientCommandManager.argument("name", StringArgumentType.word())
                .executes(ctx -> {
                    String name = StringArgumentType.getString(ctx, "name");
                    if (resolveSound(name) == null) { chat("§cunknown sound \"" + name + "\". /skyflip sound list"); return 0; }
                    config.soundName = name; config.save(); playFlipSound(false); chat("flip sound set to §e" + name); return 1;
                })));
        root.then(ClientCommandManager.literal("pingsound")
            .then(ClientCommandManager.literal("test").executes(ctx -> { playFlipSound(true); return 1; }))
            .then(ClientCommandManager.literal("volume").then(ClientCommandManager.argument("percent", IntegerArgumentType.integer(0, 100))
                .executes(ctx -> { config.pingVolume = IntegerArgumentType.getInteger(ctx, "percent") / 100f; config.save(); playFlipSound(true); return 1; })))
            .then(ClientCommandManager.literal("pitch").then(ClientCommandManager.argument("percent", IntegerArgumentType.integer(50, 200))
                .executes(ctx -> { config.pingPitch = IntegerArgumentType.getInteger(ctx, "percent") / 100f; config.save(); playFlipSound(true); return 1; })))
            .then(ClientCommandManager.argument("name", StringArgumentType.word())
                .executes(ctx -> {
                    String name = StringArgumentType.getString(ctx, "name");
                    if (resolveSound(name) == null) { chat("§cunknown sound \"" + name + "\". /skyflip sound list"); return 0; }
                    config.pingSoundName = name; config.save(); playFlipSound(true); chat("ping sound set to §e" + name); return 1;
                })));
        root.then(lit("lore", () -> { config.showLore = !config.showLore; config.save(); chat("lore on hover " + onOff(config.showLore)); }));
        root.then(lit("shortnumbers", () -> { config.shortNumbers = !config.shortNumbers; config.save(); chat("short numbers " + onOff(config.shortNumbers)); }));
        root.then(lit("hypixelonly", () -> { config.hypixelOnly = !config.hypixelOnly; config.save(); chat("hypixel-only " + onOff(config.hypixelOnly)); }));
        root.then(lit("notify", () -> { config.notifySales = !config.notifySales; config.save(); chat("purchase/sale notifications " + onOff(config.notifySales)); }));
        root.then(lit("reconnect", () -> feed.reconnect()));
        root.then(lit("ah", () -> sendCommand("ah")));
        root.then(lit("help", this::help));
        root.then(lit("gui", () -> MinecraftClient.getInstance().send(this::openGui)));
        root.then(lit("settings", () -> MinecraftClient.getInstance().send(this::openGui)));

        root.then(ClientCommandManager.literal("url").then(ClientCommandManager.argument("url", StringArgumentType.greedyString())
            .executes(ctx -> { config.url = StringArgumentType.getString(ctx, "url").trim(); config.save(); feed.setUrl(config.url); chat("feed url set to §e" + config.url); return 1; })));
        root.then(ClientCommandManager.literal("token").then(ClientCommandManager.argument("token", StringArgumentType.greedyString())
            .executes(ctx -> { config.token = StringArgumentType.getString(ctx, "token").trim(); config.save(); feed.setToken(config.token); chat("token saved, reconnecting"); return 1; })));
        root.then(ClientCommandManager.literal("risk").then(ClientCommandManager.argument("level", StringArgumentType.word())
            .executes(ctx -> {
                String lvl = StringArgumentType.getString(ctx, "level").toUpperCase(Locale.ROOT);
                if (!lvl.equals("LOW") && !lvl.equals("MEDIUM") && !lvl.equals("HIGH")) { chat("§crisk must be LOW, MEDIUM or HIGH"); return 0; }
                config.maxRisk = lvl; config.save();
                serverSet("maxRisk", lvl);
                chat("showing flips up to risk §e" + lvl);
                return 1;
            })));
        root.then(ClientCommandManager.literal("ping").then(ClientCommandManager.argument("coins", StringArgumentType.word())
            .executes(ctx -> { config.pingAbove = parseCoins(StringArgumentType.getString(ctx, "coins")); config.save(); chat("ping for flips over §e" + fmt(config.pingAbove)); return 1; })));
        root.then(ClientCommandManager.literal("show").then(ClientCommandManager.argument("field", StringArgumentType.word())
            .executes(ctx -> { toggleShow(StringArgumentType.getString(ctx, "field")); return 1; })));

        // server settings
        root.then(ClientCommandManager.literal("set")
            .then(ClientCommandManager.argument("key", StringArgumentType.word())
                .then(ClientCommandManager.argument("value", StringArgumentType.greedyString())
                    .executes(ctx -> { serverSet(StringArgumentType.getString(ctx, "key"), StringArgumentType.getString(ctx, "value")); return 1; }))));
        for (String alias : new String[] { "minprofit", "minpercent", "purse", "maxprice", "minvolume", "mode", "tier" }) {
            root.then(ClientCommandManager.literal(alias).then(ClientCommandManager.argument("value", StringArgumentType.greedyString())
                .executes(ctx -> { serverSet(alias, StringArgumentType.getString(ctx, "value")); return 1; })));
        }
        root.then(ruleCommands("blacklist", "blacklist"));
        root.then(ruleCommands("whitelist", "whitelist"));
        root.then(ruleCommands("bl", "blacklist"));
        root.then(ruleCommands("wl", "whitelist"));

        // data requests
        root.then(ClientCommandManager.literal("bazaar")
            .executes(ctx -> { requestBazaar(10); return 1; })
            .then(ClientCommandManager.argument("count", IntegerArgumentType.integer(1, 30)).executes(ctx -> { requestBazaar(IntegerArgumentType.getInteger(ctx, "count")); return 1; })));
        root.then(ClientCommandManager.literal("bz").executes(ctx -> { requestBazaar(10); return 1; }));
        root.then(ClientCommandManager.literal("profit")
            .executes(ctx -> { requestProfit(7); return 1; })
            .then(ClientCommandManager.argument("days", IntegerArgumentType.integer(1, 90)).executes(ctx -> { requestProfit(IntegerArgumentType.getInteger(ctx, "days")); return 1; })));
        return root;
    }

    /** `<alias> add <item> [key=value ...]`, `<alias> remove <item>`, `<alias> list` for a rule list. */
    private LiteralArgumentBuilder<FabricClientCommandSource> ruleCommands(String alias, String list) {
        LiteralArgumentBuilder<FabricClientCommandSource> b = ClientCommandManager.literal("add");
        b.then(ClientCommandManager.argument("spec", StringArgumentType.greedyString()).executes(ctx -> {
            JsonObject rule = parseRule(StringArgumentType.getString(ctx, "spec"));
            if (rule == null) { chat("§cusage: /skyflip " + list + " add <ITEM_ID|PET_TYPE|prefix*> [risk=HIGH] [minprofit=1m] [maxprice=50m] [minpercent=10] [kind=SNIPE] [rarity=LEGENDARY] [volume=2]"); return 0; }
            JsonObject m = new JsonObject();
            m.addProperty("type", "rule"); m.addProperty("list", list); m.addProperty("action", "add"); m.add("rule", rule);
            feed.send(m);
            return 1;
        }));
        LiteralArgumentBuilder<FabricClientCommandSource> node = ClientCommandManager.literal(alias);
        node.then(b);
        node.then(ClientCommandManager.literal("remove").then(ClientCommandManager.argument("item", StringArgumentType.word()).executes(ctx -> {
            JsonObject m = new JsonObject();
            m.addProperty("type", "rule"); m.addProperty("list", list); m.addProperty("action", "remove"); m.addProperty("item", StringArgumentType.getString(ctx, "item"));
            feed.send(m);
            return 1;
        })));
        node.then(ClientCommandManager.literal("list").executes(ctx -> {
            JsonObject m = new JsonObject();
            m.addProperty("type", "rule"); m.addProperty("list", list); m.addProperty("action", "list");
            feed.send(m);
            return 1;
        }));
        return node;
    }

    static JsonObject parseRule(String spec) {
        String[] parts = spec.trim().split("\\s+");
        if (parts.length == 0 || parts[0].isEmpty()) return null;
        JsonObject r = new JsonObject();
        r.addProperty("item", parts[0].toUpperCase(Locale.ROOT));
        for (int i = 1; i < parts.length; i++) {
            int eq = parts[i].indexOf('=');
            if (eq <= 0) return null;
            String k = parts[i].substring(0, eq).toLowerCase(Locale.ROOT), v = parts[i].substring(eq + 1);
            switch (k) {
                case "risk" -> r.addProperty("risk", v.toUpperCase(Locale.ROOT));
                case "kind" -> r.addProperty("kind", v.toUpperCase(Locale.ROOT));
                case "rarity" -> r.addProperty("rarity", v.toUpperCase(Locale.ROOT));
                case "minprofit" -> r.addProperty("minProfit", parseCoins(v));
                case "minprice" -> r.addProperty("minPrice", parseCoins(v));
                case "maxprice" -> r.addProperty("maxPrice", parseCoins(v));
                case "minpercent" -> { double p = Double.parseDouble(v); r.addProperty("minProfitPercent", p > 1 ? p / 100 : p); }
                case "volume", "minvolume" -> r.addProperty("minSalesPerDay", Double.parseDouble(v));
                case "note" -> r.addProperty("note", v);
                default -> { return null; }
            }
        }
        return r;
    }

    private LiteralArgumentBuilder<FabricClientCommandSource> lit(String name, Runnable action) {
        return ClientCommandManager.literal(name).executes(ctx -> { action.run(); return 1; });
    }

    void serverSet(String key, String value) {
        JsonObject m = new JsonObject();
        m.addProperty("type", "set"); m.addProperty("key", key); m.addProperty("value", value);
        feed.send(m);
    }

    void requestBazaar(int n) {
        JsonObject m = new JsonObject(); m.addProperty("type", "bazaar"); m.addProperty("limit", n); feed.send(m);
    }

    void requestProfit(int days) {
        JsonObject m = new JsonObject(); m.addProperty("type", "profit"); m.addProperty("days", days);
        if (feed.playerUuid != null) m.addProperty("uuid", feed.playerUuid);
        feed.send(m);
    }

    private void toggleShow(String field) {
        switch (field.toLowerCase(Locale.ROOT)) {
            case "lbin", "lowestbin" -> config.showLowestBin = !config.showLowestBin;
            case "median", "med" -> config.showMedian = !config.showMedian;
            case "volume", "vol" -> config.showVolume = !config.showVolume;
            case "percent", "pct" -> config.showProfitPercent = !config.showProfitPercent;
            case "seller" -> config.showSeller = !config.showSeller;
            case "lag" -> config.showLag = !config.showLag;
            default -> { chat("§cfields: lbin, median, volume, percent, seller, lag"); return; }
        }
        config.save();
        chat("display updated: lbin " + onOff(config.showLowestBin) + " §7median " + onOff(config.showMedian) + " §7volume " + onOff(config.showVolume)
            + " §7percent " + onOff(config.showProfitPercent) + " §7seller " + onOff(config.showSeller) + " §7lag " + onOff(config.showLag));
    }

    // ------------------------------------------------------------------ feed callbacks (background thread)

    private void onFlip(Flip f) {
        MinecraftClient.getInstance().execute(() -> {
            synchronized (recent) {
                recent.addFirst(f);
                while (recent.size() > MAX_RECENT) recent.removeLast();
            }
            if (!config.enabled || !config.riskAllowed(f.risk)) return;
            if (config.hypixelOnly && !onHypixel()) return;
            MinecraftClient client = MinecraftClient.getInstance();
            if (client.player == null) return;
            client.player.sendMessage(render(f), false);
            if (config.sound && riskRank(f.risk) <= riskRank(config.soundMaxRisk)) {
                playFlipSound(config.pingAbove > 0 && f.profit >= config.pingAbove);
            }
        });
    }

    private void onServerMessage(JsonObject m) {
        MinecraftClient.getInstance().execute(() -> {
            String type = m.has("type") ? m.get("type").getAsString() : "";
            if ((type.equals("hello") || type.equals("settings")) && m.has("settings")) {
                serverSettings = m.getAsJsonObject("settings");
                if (MinecraftClient.getInstance().currentScreen instanceof SkyFlipScreen sc) sc.onServerSettings();
            }
            switch (type) {
                case "msg" -> {
                    String text = (m.has("level") && m.get("level").getAsString().equals("error") ? "§c" : "§7") + m.get("text").getAsString();
                    if (MinecraftClient.getInstance().currentScreen instanceof SkyFlipScreen sc) sc.setStatus(text); else chat(text);
                }
                case "identified" -> chat("§7tracking profit for §f" + (m.has("name") && !m.get("name").isJsonNull() ? m.get("name").getAsString() : "you"));
                case "rules" -> {
                    JsonArray rules = m.getAsJsonArray("rules");
                    chat("§7" + m.get("list").getAsString() + " (" + rules.size() + ")");
                    for (JsonElement r : rules) chat("§8- §f" + r.toString());
                }
                case "bazaar" -> { if (m.has("requested")) renderBazaar(m.getAsJsonArray("flips")); }
                case "profit" -> renderProfit(m.getAsJsonObject("summary"));
                case "purchase" -> {
                    if (!config.notifySales) return;
                    JsonObject p = m.getAsJsonObject("purchase");
                    String predicted = m.has("flip") && !m.get("flip").isJsonNull() ? " §7(predicted §a+" + fmt(m.getAsJsonObject("flip").get("profit").getAsLong()) + "§7)" : "";
                    chat("§abought §f" + p.get("itemName").getAsString() + " §7for §6" + fmt(p.get("price").getAsLong()) + predicted);
                }
                case "sold" -> {
                    if (!config.notifySales) return;
                    JsonObject p = m.getAsJsonObject("purchase");
                    long paid = p.get("price").getAsLong(), got = p.get("soldPrice").getAsLong();
                    long net = got - fee(got) - paid;
                    chat("§esold §f" + p.get("itemName").getAsString() + " §7for §6" + fmt(got) + " §7→ " + (net >= 0 ? "§a+" : "§c") + fmt(net));
                }
                default -> { }
            }
        });
    }

    private void onStatus(String s) {
        MinecraftClient.getInstance().execute(() -> chat("§7" + s));
    }

    // ------------------------------------------------------------------ rendering

    private Text render(Flip f) {
        String kindColor = "SNIPE".equals(f.kind) ? "§b" : "§e";
        String riskColor = "LOW".equals(f.risk) ? "§a" : "MEDIUM".equals(f.risk) ? "§e" : "§c";
        String name = f.itemName + (f.count > 1 ? " x" + f.count : "");

        MutableText line = Text.literal(PREFIX)
            .append(Text.literal(kindColor + f.kind + " "))
            .append(Text.literal(rarityColor(f.rarity) + name + " "))
            .append(Text.literal("§7" + fmt(f.price) + " §8→ §7" + fmt(f.target) + " "))
            .append(Text.literal("§a+" + fmt(f.profit)));
        if (config.showProfitPercent) line.append(Text.literal(" §2(" + Math.round(f.profitPercent * 100) + "%)"));
        line.append(Text.literal(" " + riskColor + "[" + f.risk.charAt(0) + "]"));
        if (config.showLowestBin && f.lowestBin != null) line.append(Text.literal(" §8LBIN §7" + fmt(f.lowestBin)));
        if (config.showMedian && f.median != null) line.append(Text.literal(" §8MED §7" + fmt(f.median)));
        if (config.showVolume && f.salesPerDay > 0) line.append(Text.literal(" §8VOL §7" + trim(f.salesPerDay) + "/d"));
        if (config.showLag) line.append(Text.literal(" §8" + f.latencyMs + "ms"));
        if (config.showSeller && f.seller != null) line.append(Text.literal(" §8by " + f.seller.substring(0, Math.min(8, f.seller.length()))));

        StringBuilder hover = new StringBuilder();
        hover.append(rarityColor(f.rarity)).append(f.itemName).append('\n');
        if (config.showLore && f.lore != null && !f.lore.isEmpty()) {
            for (String l : f.lore) hover.append(l).append('\n');
            hover.append('\n');
        } else if (f.summary != null && !f.summary.isEmpty()) hover.append("§7").append(f.summary).append('\n');
        hover.append("§7Price: §f").append(fmtFull(f.price)).append('\n');
        hover.append("§7Target: §f").append(fmtFull(f.target)).append(" §8(after fees §a+").append(fmt(f.profit)).append("§8)\n");
        if (f.lowestBin != null) hover.append("§7Next lowest BIN: §f").append(fmtFull(f.lowestBin)).append('\n');
        if (f.median != null) hover.append("§7Sold median: §f").append(fmtFull(f.median)).append(" §8(").append(f.priceSource).append(")\n");
        hover.append("§7Sales/day: §f").append(trim(f.salesPerDay)).append("  §7Key tier: §f").append(f.keyTier).append("  §7Risk: ").append(riskColor).append(f.risk).append('\n');
        hover.append("§7Lag: §f").append(f.latencyMs).append("ms §8· listed ").append(f.ageMs / 1000).append("s before the API refresh\n");
        hover.append("§eClick to run ").append(f.command);

        MutableText main = line.styled(style -> style
            .withClickEvent(new ClickEvent(ClickEvent.Action.RUN_COMMAND, f.command))
            .withHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT, Text.literal(hover.toString()))));

        MutableText copy = Text.literal(" §8[§7copy§8]").styled(style -> style
            .withClickEvent(new ClickEvent(ClickEvent.Action.COPY_TO_CLIPBOARD, f.uuid))
            .withHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT, Text.literal("§7Copy auction id"))));
        MutableText bl = Text.literal(" §8[§cbl§8]").styled(style -> style
            .withClickEvent(new ClickEvent(ClickEvent.Action.SUGGEST_COMMAND, "/skyflip blacklist add " + f.ruleId + " "))
            .withHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT, Text.literal("§7Blacklist " + f.ruleId))));
        return main.append(copy).append(bl);
    }

    private void renderBazaar(JsonArray flips) {
        chat("§7top bazaar order flips (" + flips.size() + ") §8buy order → sell offer, profit/unit after tax, est. profit/hour");
        for (JsonElement e : flips) {
            JsonObject b = e.getAsJsonObject();
            String risk = b.get("risk").getAsString();
            String riskColor = "LOW".equals(risk) ? "§a" : "MEDIUM".equals(risk) ? "§e" : "§c";
            String cmd = b.get("command").getAsString();
            MutableText t = Text.literal(PREFIX + "§f" + b.get("name").getAsString() + " §7" + fmt(b.get("buyOrderPrice").getAsLong()) + " §8→ §7" + fmt(b.get("sellOrderPrice").getAsLong())
                + " §a+" + fmt(b.get("profitPerUnit").getAsLong()) + "/u §2(" + Math.round(b.get("profitPercent").getAsDouble() * 100) + "%) §6" + fmt(b.get("profitPerHour").getAsLong()) + "/h " + riskColor + "[" + risk.charAt(0) + "]")
                .styled(style -> style
                    .withClickEvent(new ClickEvent(ClickEvent.Action.RUN_COMMAND, cmd))
                    .withHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT, Text.literal(
                        "§7Weekly volume: §f" + fmt(b.get("buyMovingWeek").getAsLong()) + " §7bought · §f" + fmt(b.get("sellMovingWeek").getAsLong()) + " §7sold\n"
                        + "§7Orders: §f" + b.get("buyOrders").getAsInt() + " §7buy · §f" + b.get("sellOrders").getAsInt() + " §7sell\n"
                        + "§7Units/hour you can move: §f" + Math.round(b.get("unitsPerHour").getAsDouble()) + "\n§eClick to run " + cmd))));
            MinecraftClient client = MinecraftClient.getInstance();
            if (client.player != null) client.player.sendMessage(t, false);
        }
    }

    private void renderProfit(JsonObject s) {
        long realized = s.get("realizedProfit").getAsLong();
        chat("§7profit over the last " + (s.get("sinceMs").getAsLong() / 86_400_000L) + "d: bought §f" + s.get("bought").getAsInt() + " §7sold §f" + s.get("sold").getAsInt()
            + " §7spent §6" + fmt(s.get("spent").getAsLong()) + " §7revenue §6" + fmt(s.get("revenue").getAsLong()) + " §7realized " + (realized >= 0 ? "§a+" : "§c") + fmt(realized)
            + " §7pending §f" + s.get("pending").getAsInt() + " §8(" + fmt(s.get("pendingValue").getAsLong()) + ")");
        JsonArray recentRows = s.getAsJsonArray("recent");
        int shown = 0;
        for (JsonElement e : recentRows) {
            if (shown++ >= 8) break;
            JsonObject p = e.getAsJsonObject();
            boolean sold = p.has("soldPrice") && !p.get("soldPrice").isJsonNull();
            String tail = sold ? " §7→ sold §6" + fmt(p.get("soldPrice").getAsLong()) : " §8unsold";
            chat("§8- §f" + p.get("itemName").getAsString() + " §7paid §6" + fmt(p.get("price").getAsLong()) + tail);
        }
    }

    private void openGui() {
        MinecraftClient.getInstance().setScreen(new SkyFlipScreen(this));
    }

    private int status() {
        chat((feed.connected ? "§aconnected" : "§cdisconnected") + " §7to §e" + config.url + (config.token.isEmpty() ? " §8(no token)" : ""));
        chat("§7flips " + onOff(config.enabled) + " §7· sound " + onOff(config.sound) + " §8(" + config.soundName + " " + Math.round(config.soundVolume * 100) + "%)" + " §7· risk ≤ §e" + config.maxRisk + " §7· hypixel-only " + onOff(config.hypixelOnly) + " §7· lore " + onOff(config.showLore));
        chat("§7keys: §f" + openLatest.getBoundKeyLocalizedText().getString() + " §7open latest · §f" + openBest.getBoundKeyLocalizedText().getString() + " §7open best · §f" + openGui.getBoundKeyLocalizedText().getString() + " §7settings GUI · §f/skyflip help §7for commands");
        return 1;
    }

    private void help() {
        chat("§7client: §ftoggle · lore · shortnumbers · hypixelonly · notify · reconnect · url <ws://…> · token <t> · risk <LOW|MEDIUM|HIGH> · ping <coins> · show <lbin|median|volume|percent|seller|lag> · ah");
        chat("§7sound: §fsound (toggle) · sound <preset|id> · sound list · sound test · sound volume <0-100> · sound pitch <50-200> · sound risk <LOW|MEDIUM|HIGH> · pingsound <preset|id> · pingsound volume/pitch/test");
        chat("§7server: §fminprofit <n> · minpercent <n> · purse <n> · minvolume <n> · mode <sniper|median|all> · tier <0-4> · set <key> <value>");
        chat("§7filters: §fblacklist|whitelist add <item> [risk=HIGH] [minprofit=1m] [maxprice=50m] [minpercent=10] [kind=SNIPE] [rarity=X] [volume=2] · remove <item> · list");
        chat("§7data: §fbazaar [n] · profit [days]");
    }

    // ------------------------------------------------------------------ sounds

    static final java.util.Map<String, String> SOUND_PRESETS = new java.util.LinkedHashMap<>();
    static {
        SOUND_PRESETS.put("villager", "entity.villager.ambient");   // quiet "hmm"
        SOUND_PRESETS.put("chime", "block.amethyst_block.chime");
        SOUND_PRESETS.put("pling", "block.note_block.pling");
        SOUND_PRESETS.put("orb", "entity.experience_orb.pickup");
        SOUND_PRESETS.put("bell", "block.note_block.bell");
        SOUND_PRESETS.put("level", "entity.player.levelup");
        SOUND_PRESETS.put("toast", "ui.toast.in");
        SOUND_PRESETS.put("click", "ui.button.click");
        SOUND_PRESETS.put("cat", "entity.cat.purr");
        SOUND_PRESETS.put("none", "");
    }

    /** Preset name or vanilla sound id → SoundEvent; null when unknown. "none" resolves to a silent marker. */
    private static SoundEvent resolveSound(String name) {
        String id = SOUND_PRESETS.getOrDefault(name.toLowerCase(Locale.ROOT), name);
        if (id.isEmpty()) return SoundEvents.INTENTIONALLY_EMPTY;
        Identifier ident = Identifier.tryParse(id.contains(":") ? id : "minecraft:" + id);
        return ident == null ? null : Registries.SOUND_EVENT.get(ident);
    }

    void playFlipSound(boolean ping) {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client.player == null) return;
        SoundEvent ev = resolveSound(ping ? config.pingSoundName : config.soundName);
        if (ev == null || ev == SoundEvents.INTENTIONALLY_EMPTY) return;
        client.player.playSound(ev, ping ? config.pingVolume : config.soundVolume, ping ? config.pingPitch : config.soundPitch);
    }

    private static int riskRank(String r) {
        if (r == null) return 2;
        return switch (r) { case "LOW" -> 0; case "MEDIUM" -> 1; default -> 2; };
    }

    // ------------------------------------------------------------------ helpers

    private static String rarityColor(String r) {
        if (r == null) return "§f";
        return switch (r) {
            case "UNCOMMON" -> "§a";
            case "RARE" -> "§9";
            case "EPIC" -> "§5";
            case "LEGENDARY" -> "§6";
            case "MYTHIC" -> "§d";
            case "DIVINE" -> "§b";
            case "SPECIAL", "VERY_SPECIAL" -> "§c";
            default -> "§f";
        };
    }

    private String fmt(long n) {
        if (!config.shortNumbers) return fmtFull(n);
        if (n >= 1_000_000_000L) return String.format(Locale.ROOT, "%.2fb", n / 1e9);
        if (n >= 10_000_000L) return String.format(Locale.ROOT, "%.0fm", n / 1e6);
        if (n >= 1_000_000L) return String.format(Locale.ROOT, "%.1fm", n / 1e6);
        if (n >= 1_000L) return String.format(Locale.ROOT, "%.0fk", n / 1e3);
        return Long.toString(n);
    }
    private static String fmtFull(long n) { return String.format(Locale.ROOT, "%,d", n); }
    private static String trim(double d) { return d == Math.floor(d) ? Long.toString((long) d) : String.format(Locale.ROOT, "%.1f", d); }
    private static String onOff(boolean b) { return b ? "§aon" : "§coff"; }
    private static long fee(long price) {
        long listing = (long) Math.floor(price * (price >= 100_000_000L ? 0.03 : price >= 10_000_000L ? 0.02 : 0.01));
        long collect = price > 1_000_000L ? (long) Math.floor(price * 0.01) : 0;
        return listing + collect;
    }

    static long parseCoins(String v) {
        String s = v.trim().toLowerCase(Locale.ROOT).replace(",", "").replace("_", "");
        double mult = 1;
        if (s.endsWith("k")) { mult = 1e3; s = s.substring(0, s.length() - 1); }
        else if (s.endsWith("m")) { mult = 1e6; s = s.substring(0, s.length() - 1); }
        else if (s.endsWith("b")) { mult = 1e9; s = s.substring(0, s.length() - 1); }
        return (long) (Double.parseDouble(s) * mult);
    }

    // ------------------------------------------------------------------ actions (always from an explicit key press or click)

    private Flip newestFresh() {
        long cutoff = System.currentTimeMillis() - config.staleAfterSeconds * 1000L;
        synchronized (recent) {
            for (Flip f : recent) if (f.receivedAt >= cutoff && config.riskAllowed(f.risk)) return f;
        }
        return null;
    }

    private Flip bestFresh() {
        long cutoff = System.currentTimeMillis() - config.staleAfterSeconds * 1000L;
        Flip best = null;
        synchronized (recent) {
            for (Flip f : recent) {
                if (f.receivedAt < cutoff || !config.riskAllowed(f.risk)) continue;
                if (best == null || f.profit > best.profit) best = f;
            }
        }
        return best;
    }

    private void openFlip(Flip f) {
        if (f == null) { chat("§7no fresh flip in the last " + config.staleAfterSeconds + "s"); return; }
        sendCommand("viewauction " + f.uuid);
    }

    private static void sendCommand(String withoutSlash) {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client.getNetworkHandler() != null) client.getNetworkHandler().sendChatCommand(withoutSlash);
    }

    private static boolean onHypixel() {
        ServerInfo s = MinecraftClient.getInstance().getCurrentServerEntry();
        return s != null && s.address != null && s.address.toLowerCase(Locale.ROOT).contains("hypixel.net");
    }

    private static void chat(String msg) {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client.player != null) client.player.sendMessage(Text.literal(PREFIX + msg), false);
    }
}
