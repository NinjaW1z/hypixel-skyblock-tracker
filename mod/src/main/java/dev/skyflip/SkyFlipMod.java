package dev.skyflip;

import com.google.gson.JsonObject;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandManager;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.command.v2.FabricClientCommandSource;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ServerInfo;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.InputUtil;
import net.minecraft.sound.SoundEvents;
import net.minecraft.text.ClickEvent;
import net.minecraft.text.HoverEvent;
import net.minecraft.text.MutableText;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;
import org.lwjgl.glfw.GLFW;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Locale;

/**
 * SkyFlip client mod.
 *
 * Shows flips from the local backend as clickable chat lines. Clicking a line, or pressing the
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

    @Override
    public void onInitializeClient() {
        config = FlipConfig.load();

        openLatest = KeyBindingHelper.registerKeyBinding(new KeyBinding(
            "key.skyflip.open_latest", InputUtil.Type.KEYSYM, GLFW.GLFW_KEY_V, "category.skyflip"));
        openBest = KeyBindingHelper.registerKeyBinding(new KeyBinding(
            "key.skyflip.open_best", InputUtil.Type.KEYSYM, GLFW.GLFW_KEY_B, "category.skyflip"));

        feed = new FeedClient(config.url, this::onFlip, this::onStatus);
        feed.start();

        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            while (openLatest.wasPressed()) openFlip(newestFresh());
            while (openBest.wasPressed()) openFlip(bestFresh());
        });

        ClientCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess) -> dispatcher.register(
            ClientCommandManager.literal("skyflip")
                .executes(ctx -> status(ctx.getSource()))
                .then(ClientCommandManager.literal("toggle").executes(ctx -> {
                    config.enabled = !config.enabled; config.save();
                    chat("flips " + (config.enabled ? "§aenabled" : "§cdisabled"));
                    return 1;
                }))
                .then(ClientCommandManager.literal("sound").executes(ctx -> {
                    config.sound = !config.sound; config.save();
                    chat("sound " + (config.sound ? "§aon" : "§coff"));
                    return 1;
                }))
                .then(ClientCommandManager.literal("reconnect").executes(ctx -> { feed.reconnect(); return 1; }))
                .then(ClientCommandManager.literal("url").then(ClientCommandManager.argument("url", StringArgumentType.greedyString())
                    .executes(ctx -> {
                        config.url = StringArgumentType.getString(ctx, "url"); config.save();
                        feed.setUrl(config.url);
                        chat("feed url set to §e" + config.url);
                        return 1;
                    })))
                .then(ClientCommandManager.literal("risk").then(ClientCommandManager.argument("level", StringArgumentType.word())
                    .executes(ctx -> {
                        String lvl = StringArgumentType.getString(ctx, "level").toUpperCase(Locale.ROOT);
                        if (!lvl.equals("LOW") && !lvl.equals("MEDIUM") && !lvl.equals("HIGH")) { chat("§crisk must be LOW, MEDIUM or HIGH"); return 0; }
                        config.maxRisk = lvl; config.save();
                        chat("showing flips up to risk §e" + lvl);
                        return 1;
                    })))
                .then(ClientCommandManager.literal("minprofit").then(ClientCommandManager.argument("coins", IntegerArgumentType.integer(0))
                    .executes(ctx -> {
                        JsonObject patch = new JsonObject();
                        patch.addProperty("minProfit", IntegerArgumentType.getInteger(ctx, "coins"));
                        feed.sendSettings(patch);
                        chat("server minProfit set to §e" + fmt(IntegerArgumentType.getInteger(ctx, "coins")));
                        return 1;
                    })))
                .then(ClientCommandManager.literal("maxprice").then(ClientCommandManager.argument("coins", IntegerArgumentType.integer(0))
                    .executes(ctx -> {
                        JsonObject patch = new JsonObject();
                        patch.addProperty("maxPrice", IntegerArgumentType.getInteger(ctx, "coins"));
                        feed.sendSettings(patch);
                        chat("server maxPrice set to §e" + fmt(IntegerArgumentType.getInteger(ctx, "coins")));
                        return 1;
                    })))
                .then(ClientCommandManager.literal("hypixelonly").executes(ctx -> {
                    config.hypixelOnly = !config.hypixelOnly; config.save();
                    chat("hypixel-only " + (config.hypixelOnly ? "§aon" : "§coff"));
                    return 1;
                }))
        ));
    }

    // ---- feed callbacks (background thread) ----

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
            if (config.sound) client.player.playSound(SoundEvents.ENTITY_EXPERIENCE_ORB_PICKUP, 0.7f, 1.6f);
        });
    }

    private void onStatus(String s) {
        MinecraftClient.getInstance().execute(() -> chat("§7" + s));
    }

    // ---- rendering ----

    private Text render(Flip f) {
        String kindColor = "SNIPE".equals(f.kind) ? "§b" : "§e";
        String riskColor = "LOW".equals(f.risk) ? "§a" : "MEDIUM".equals(f.risk) ? "§e" : "§c";
        String name = f.itemName + (f.count > 1 ? " x" + f.count : "");

        MutableText line = Text.literal(PREFIX)
            .append(Text.literal(kindColor + f.kind + " "))
            .append(Text.literal(rarityColor(f.rarity) + name + " "))
            .append(Text.literal("§7" + fmt(f.price) + " §8→ §7" + fmt(f.target) + " "))
            .append(Text.literal("§a+" + fmt(f.profit) + " §2(" + Math.round(f.profitPercent * 100) + "%) "))
            .append(Text.literal(riskColor + "[" + f.risk.charAt(0) + "]"));

        StringBuilder hover = new StringBuilder();
        hover.append("§6").append(f.itemName).append('\n');
        if (f.summary != null && !f.summary.isEmpty()) hover.append("§7").append(f.summary).append('\n');
        hover.append("§7Price: §f").append(fmt(f.price)).append('\n');
        hover.append("§7Target: §f").append(fmt(f.target)).append(" §8(after fees +").append(fmt(f.profit)).append(")\n");
        if (f.lowestBin != null) hover.append("§7Next lowest BIN: §f").append(fmt(f.lowestBin)).append('\n');
        if (f.median != null) hover.append("§7Sold median: §f").append(fmt(f.median)).append('\n');
        hover.append("§7Sales/day: §f").append(f.salesPerDay).append("  §7Key tier: §f").append(f.keyTier).append('\n');
        hover.append("§7Lag: §f").append(f.latencyMs).append("ms\n");
        hover.append("§eClick to run ").append(f.command);

        return line.styled(style -> style
            .withClickEvent(new ClickEvent(ClickEvent.Action.RUN_COMMAND, f.command))
            .withHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT, Text.literal(hover.toString()))));
    }

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

    static String fmt(long n) {
        if (n >= 1_000_000_000L) return String.format(Locale.ROOT, "%.2fb", n / 1e9);
        if (n >= 10_000_000L) return String.format(Locale.ROOT, "%.0fm", n / 1e6);
        if (n >= 1_000_000L) return String.format(Locale.ROOT, "%.1fm", n / 1e6);
        if (n >= 1_000L) return String.format(Locale.ROOT, "%.0fk", n / 1e3);
        return Long.toString(n);
    }

    // ---- actions (always triggered by an explicit key press or click) ----

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
        MinecraftClient client = MinecraftClient.getInstance();
        if (f == null) { chat("§7no fresh flip in the last " + config.staleAfterSeconds + "s"); return; }
        if (client.getNetworkHandler() == null) return;
        // sendChatCommand takes the command without the leading slash.
        client.getNetworkHandler().sendChatCommand("viewauction " + f.uuid);
    }

    private int status(FabricClientCommandSource src) {
        chat((feed.connected ? "§aconnected" : "§cdisconnected") + " §7to §e" + config.url);
        chat("§7flips " + (config.enabled ? "§aon" : "§coff") + " §7· sound " + (config.sound ? "§aon" : "§coff")
            + " §7· risk ≤ §e" + config.maxRisk + " §7· hypixel-only " + (config.hypixelOnly ? "§aon" : "§coff"));
        chat("§7keys: §f" + openLatest.getBoundKeyLocalizedText().getString() + " §7open latest · §f"
            + openBest.getBoundKeyLocalizedText().getString() + " §7open best");
        chat("§7commands: toggle · sound · reconnect · url <ws://…> · risk <LOW|MEDIUM|HIGH> · minprofit <n> · maxprice <n> · hypixelonly");
        return 1;
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
