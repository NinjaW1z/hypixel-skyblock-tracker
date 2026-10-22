package dev.skyflip;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.client.gui.widget.CyclingButtonWidget;
import net.minecraft.client.gui.widget.SliderWidget;
import net.minecraft.client.gui.widget.TextFieldWidget;
import net.minecraft.text.Text;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.Consumer;
import java.util.function.DoubleConsumer;

/**
 * In-game settings screen. Vanilla widgets only, so the mod stays dependency-free.
 * Client-side options save to config/skyflip.json immediately; server-side options
 * (thresholds, filters) are sent to the backend when you press Apply or Add.
 */
public final class SkyFlipScreen extends Screen {
    private enum Tab { GENERAL, DISPLAY, SOUND, SERVER, FILTERS, AUTOBUY }

    private final SkyFlipMod mod;
    private final FlipConfig cfg;
    private Tab tab = Tab.GENERAL;
    private String status = "";
    private int filterPage = 0;
    private boolean showWhitelist = false;
    private TextFieldWidget ruleField;
    private TextFieldWidget urlField, tokenField, minProfitField, minPercentField, purseField, minVolumeField;
    private TextFieldWidget abMinProfitField, abMinPercentField, abMaxPriceField, abReserveField;

    private int left, colW;
    private static final int TOP = 56;
    private static final int ROW = 24;

    public SkyFlipScreen(SkyFlipMod mod) {
        super(Text.literal("SkyFlip"));
        this.mod = mod;
        this.cfg = mod.config();
    }

    @Override
    public boolean shouldPause() { return false; }

    @Override
    protected void init() {
        left = Math.max(20, (width - 420) / 2);
        colW = 200;

        int x = left;
        for (Tab t : Tab.values()) {
            final Tab tt = t;
            String label = t == Tab.AUTOBUY ? "Auto-buy" : t.name().charAt(0) + t.name().substring(1).toLowerCase(Locale.ROOT);
            addDrawableChild(ButtonWidget.builder(Text.literal((tab == t ? "§e" : "") + label), btn -> { tab = tt; filterPage = 0; rebuild(); })
                .dimensions(x, 28, 68, 20).build());
            x += 70;
        }

        switch (tab) {
            case GENERAL -> buildGeneral();
            case DISPLAY -> buildDisplay();
            case SOUND -> buildSound();
            case SERVER -> buildServer();
            case FILTERS -> buildFilters();
            case AUTOBUY -> buildAutobuy();
        }

        addDrawableChild(ButtonWidget.builder(Text.literal("Bazaar"), b -> { mod.requestBazaar(10); close(); }).dimensions(left, height - 28, 70, 20).build());
        addDrawableChild(ButtonWidget.builder(Text.literal("Profit"), b -> { mod.requestProfit(7); close(); }).dimensions(left + 74, height - 28, 70, 20).build());
        addDrawableChild(ButtonWidget.builder(Text.literal("Reconnect"), b -> mod.feed().reconnect()).dimensions(left + 148, height - 28, 80, 20).build());
        addDrawableChild(ButtonWidget.builder(Text.literal("Done"), b -> close()).dimensions(left + 420 - 80, height - 28, 80, 20).build());
    }

    private void rebuild() { clearChildren(); init(); }

    // ------------------------------------------------------------------ widget helpers

    private static int row(int i) { return TOP + i * ROW; }
    private int colX(int col) { return left + col * (colW + 20); }

    private void toggle(int col, int rowIdx, String label, boolean value, Consumer<Boolean> set) {
        addDrawableChild(CyclingButtonWidget.onOffBuilder(value).build(colX(col), row(rowIdx), colW, 20, Text.literal(label), (btn, v) -> { set.accept(v); cfg.save(); }));
    }

    private <T> void cycle(int col, int rowIdx, String label, List<T> values, T current, Consumer<T> set) {
        addDrawableChild(CyclingButtonWidget.<T>builder(v -> Text.literal(String.valueOf(v))).values(values).initially(current)
            .build(colX(col), row(rowIdx), colW, 20, Text.literal(label), (btn, v) -> { set.accept(v); cfg.save(); }));
    }

    private void slider(int col, int rowIdx, String label, double min, double max, double value, String unit, DoubleConsumer set) {
        addDrawableChild(new SliderWidget(colX(col), row(rowIdx), colW, 20, Text.literal(label + ": " + Math.round(value) + unit), (value - min) / (max - min)) {
            @Override protected void updateMessage() { setMessage(Text.literal(label + ": " + Math.round(min + this.value * (max - min)) + unit)); }
            @Override protected void applyValue() { set.accept(min + this.value * (max - min)); cfg.save(); }
        });
    }

    private TextFieldWidget field(int col, int rowIdx, String placeholder, String value, int maxLen) {
        TextFieldWidget f = new TextFieldWidget(textRenderer, colX(col), row(rowIdx) + 8, colW, 18, Text.literal(placeholder));
        f.setMaxLength(maxLen);
        f.setText(value == null ? "" : value);
        f.setPlaceholder(Text.literal("§8" + placeholder));
        addDrawableChild(f);
        return f;
    }

    private void label(DrawContext ctx, int col, int rowIdx, String text) {
        ctx.drawTextWithShadow(textRenderer, Text.literal("§7" + text), colX(col), row(rowIdx) - 1, 0xFFFFFF);
    }

    // ------------------------------------------------------------------ tabs

    private void buildGeneral() {
        toggle(0, 0, "Show flips", cfg.enabled, v -> cfg.enabled = v);
        toggle(1, 0, "Only on Hypixel", cfg.hypixelOnly, v -> cfg.hypixelOnly = v);
        cycle(0, 1, "Max risk (client)", List.of("LOW", "MEDIUM", "HIGH"), cfg.maxRisk, v -> cfg.maxRisk = v);
        toggle(1, 1, "Buy/sell notifications", cfg.notifySales, v -> cfg.notifySales = v);
        slider(0, 2, "Keybind stale after", 5, 60, cfg.staleAfterSeconds, "s", v -> cfg.staleAfterSeconds = (int) Math.round(v));
        slider(1, 2, "Ping above", 0, 100, cfg.pingAbove / 1_000_000.0, "m coins", v -> cfg.pingAbove = Math.round(v) * 1_000_000L);
    }

    private void buildDisplay() {
        toggle(0, 0, "Lore on hover", cfg.showLore, v -> cfg.showLore = v);
        toggle(1, 0, "Short numbers", cfg.shortNumbers, v -> cfg.shortNumbers = v);
        toggle(0, 1, "Lowest BIN", cfg.showLowestBin, v -> cfg.showLowestBin = v);
        toggle(1, 1, "Median", cfg.showMedian, v -> cfg.showMedian = v);
        toggle(0, 2, "Volume", cfg.showVolume, v -> cfg.showVolume = v);
        toggle(1, 2, "Profit %", cfg.showProfitPercent, v -> cfg.showProfitPercent = v);
        toggle(0, 3, "Seller", cfg.showSeller, v -> cfg.showSeller = v);
        toggle(1, 3, "Lag", cfg.showLag, v -> cfg.showLag = v);
    }

    private void buildSound() {
        List<String> presets = new ArrayList<>(SkyFlipMod.SOUND_PRESETS.keySet());
        toggle(0, 0, "Sound", cfg.sound, v -> cfg.sound = v);
        cycle(1, 0, "Sound for risk up to", List.of("LOW", "MEDIUM", "HIGH"), cfg.soundMaxRisk, v -> cfg.soundMaxRisk = v);
        cycle(0, 1, "Flip sound", presets, presets.contains(cfg.soundName) ? cfg.soundName : presets.get(0), v -> { cfg.soundName = v; mod.playFlipSound(false); });
        addDrawableChild(ButtonWidget.builder(Text.literal("Test"), b -> mod.playFlipSound(false)).dimensions(colX(1), row(1), 60, 20).build());
        slider(0, 2, "Volume", 0, 100, cfg.soundVolume * 100, "%", v -> cfg.soundVolume = (float) (v / 100));
        slider(1, 2, "Pitch", 50, 200, cfg.soundPitch * 100, "%", v -> cfg.soundPitch = (float) (v / 100));
        cycle(0, 4, "Ping sound (big flips)", presets, presets.contains(cfg.pingSoundName) ? cfg.pingSoundName : presets.get(0), v -> { cfg.pingSoundName = v; mod.playFlipSound(true); });
        addDrawableChild(ButtonWidget.builder(Text.literal("Test"), b -> mod.playFlipSound(true)).dimensions(colX(1), row(4), 60, 20).build());
        slider(0, 5, "Ping volume", 0, 100, cfg.pingVolume * 100, "%", v -> cfg.pingVolume = (float) (v / 100));
        slider(1, 5, "Ping pitch", 50, 200, cfg.pingPitch * 100, "%", v -> cfg.pingPitch = (float) (v / 100));
    }

    private void buildServer() {
        JsonObject s = mod.serverSettings();
        urlField = field(0, 0, "ws://host:3131/ws", cfg.url, 200);
        tokenField = field(1, 0, "token", cfg.token, 200);
        addDrawableChild(ButtonWidget.builder(Text.literal("Save & connect"), b -> {
            cfg.url = urlField.getText().trim(); cfg.token = tokenField.getText().trim(); cfg.save();
            mod.feed().setToken(cfg.token); mod.feed().setUrl(cfg.url);
            status = "reconnecting…";
        }).dimensions(left, row(1) + 4, 120, 20).build());

        minProfitField = field(0, 3, "e.g. 500k", s == null ? "" : fmtCoins(s.get("minProfit").getAsLong()), 16);
        minPercentField = field(1, 3, "e.g. 5", s == null ? "" : String.valueOf(Math.round(s.get("minProfitPercent").getAsDouble() * 100)), 8);
        purseField = field(0, 4, "0 = any", s == null ? "" : fmtCoins(s.get("maxPrice").getAsLong()), 16);
        minVolumeField = field(1, 4, "e.g. 1", s == null ? "" : String.valueOf(s.get("minSalesPerDay").getAsDouble()), 8);
        if (s != null) {
            JsonObject kinds = s.getAsJsonObject("kinds");
            String mode = kinds.get("SNIPE").getAsBoolean() && kinds.get("MEDIAN").getAsBoolean() ? "all" : kinds.get("SNIPE").getAsBoolean() ? "sniper" : "median";
            cycle(0, 5, "Mode", List.of("all", "sniper", "median"), mode, v -> mod.serverSet("mode", v));
            cycle(1, 5, "Max risk (server)", List.of("LOW", "MEDIUM", "HIGH"), s.get("maxRisk").getAsString(), v -> mod.serverSet("maxRisk", v));
            cycle(0, 6, "Key tier (0 exact … 4 loose)", List.of(0, 1, 2, 3, 4), s.get("maxKeyTier").getAsInt(), v -> mod.serverSet("maxKeyTier", String.valueOf(v)));
            cycle(1, 6, "Whitelist only", List.of("off", "on"), s.get("whitelistOnly").getAsBoolean() ? "on" : "off", v -> mod.serverSet("whitelistOnly", v));
        }
        addDrawableChild(ButtonWidget.builder(Text.literal("Apply thresholds"), b -> {
            JsonObject patch = new JsonObject();
            try {
                patch.addProperty("minProfit", SkyFlipMod.parseCoins(minProfitField.getText()));
                patch.addProperty("minProfitPercent", Double.parseDouble(minPercentField.getText().trim()) / 100.0);
                patch.addProperty("maxPrice", SkyFlipMod.parseCoins(purseField.getText()));
                patch.addProperty("minSalesPerDay", Double.parseDouble(minVolumeField.getText().trim()));
            } catch (RuntimeException e) { status = "§cinvalid number"; return; }
            JsonObject m = new JsonObject(); m.addProperty("type", "settings"); m.add("settings", patch);
            mod.feed().send(m);
            status = "§athresholds sent";
        }).dimensions(left, row(7) + 4, 120, 20).build());
    }

    private void buildAutobuy() {
        JsonObject s = mod.serverSettings();
        JsonObject b = mod.botStatus();
        JsonObject ab = s != null && s.has("autobuy") && s.get("autobuy").isJsonObject() ? s.getAsJsonObject("autobuy") : null;
        JsonObject svc = b != null && b.has("service") && b.get("service").isJsonObject() ? b.getAsJsonObject("service") : null;
        boolean loginOn = svc != null && svc.get("desired").getAsString().equals("on");
        boolean autobuyOn = ab != null && ab.get("enabled").getAsBoolean();
        addDrawableChild(CyclingButtonWidget.onOffBuilder(loginOn).build(colX(0), row(0), colW, 20, Text.literal("Login switch (bot service)"), (btn, v) -> { mod.botControl(v ? "login-on" : "login-off"); status = v ? "§estarting the bot service…" : "§estopping the bot service…"; }));
        addDrawableChild(CyclingButtonWidget.onOffBuilder(autobuyOn).build(colX(1), row(0), colW, 20, Text.literal("Auto-buy switch (forward flips)"), (btn, v) -> { mod.botControl(v ? "autobuy-on" : "autobuy-off"); status = v ? "§aauto-buy on" : "§cauto-buy off"; }));
        if (ab == null) return;
        abMinProfitField = field(0, 2, "e.g. 500k", fmtCoins(ab.get("minProfit").getAsLong()), 16);
        abMinPercentField = field(1, 2, "e.g. 8", String.valueOf(Math.round(ab.get("minProfitPercent").getAsDouble() * 100)), 8);
        abMaxPriceField = field(0, 3, "0 = any", fmtCoins(ab.get("maxPrice").getAsLong()), 16);
        abReserveField = field(1, 3, "e.g. 5m", fmtCoins(ab.get("purseReserve").getAsLong()), 16);
        cycle(0, 4, "Max risk", List.of("LOW", "MEDIUM", "HIGH"), ab.get("maxRisk").getAsString(), v -> mod.serverSet("autobuyRisk", v));
        cycle(1, 4, "Auto-sell", List.of("off", "on"), ab.get("autoSell").getAsBoolean() ? "on" : "off", v -> mod.serverSet("autoSell", v));
        cycle(0, 5, "Require price history", List.of("off", "on"), ab.get("requireHistory").getAsBoolean() ? "on" : "off", v -> { JsonObject p = new JsonObject(); JsonObject a = new JsonObject(); a.addProperty("requireHistory", v.equals("on")); p.add("autobuy", a); JsonObject m = new JsonObject(); m.addProperty("type", "settings"); m.add("settings", p); mod.feed().send(m); });
        JsonObject pc = s.has("pacing") && s.get("pacing").isJsonObject() ? s.getAsJsonObject("pacing") : null;
        if (pc != null) {
            cycle(1, 5, "Stealth pacing", List.of("off", "on"), pc.get("enabled").getAsBoolean() ? "on" : "off", v -> mod.serverSet("pacing", v));
            cycle(0, 6, "Humanization breaks", List.of("off", "on"), pc.get("humanize").getAsBoolean() ? "on" : "off", v -> mod.serverSet("humanize", v));
        }
        addDrawableChild(ButtonWidget.builder(Text.literal("Apply thresholds"), b2 -> {
            JsonObject patch = new JsonObject();
            try {
                patch.addProperty("minProfit", SkyFlipMod.parseCoins(abMinProfitField.getText()));
                patch.addProperty("minProfitPercent", Double.parseDouble(abMinPercentField.getText().trim()) / 100.0);
                patch.addProperty("maxPrice", SkyFlipMod.parseCoins(abMaxPriceField.getText()));
                patch.addProperty("purseReserve", SkyFlipMod.parseCoins(abReserveField.getText()));
            } catch (RuntimeException e) { status = "§cinvalid number"; return; }
            JsonObject outer = new JsonObject(); outer.add("autobuy", patch);
            JsonObject m = new JsonObject(); m.addProperty("type", "settings"); m.add("settings", outer);
            mod.feed().send(m);
            status = "§aauto-buy thresholds sent";
        }).dimensions(left, row(7) + 4, 120, 20).build());
        addDrawableChild(ButtonWidget.builder(Text.literal("Refresh"), b2 -> { mod.requestBotStatus(); status = "§7refreshing…"; }).dimensions(left + 124, row(7) + 4, 70, 20).build());
    }

    private void buildFilters() {
        JsonObject s = mod.serverSettings();
        cycle(0, 0, "List", List.of("blacklist", "whitelist"), showWhitelist ? "whitelist" : "blacklist", v -> { showWhitelist = v.equals("whitelist"); filterPage = 0; rebuild(); });
        ruleField = field(1, 0, "ITEM [risk=HIGH] [minprofit=1m] …", "", 200);
        addDrawableChild(ButtonWidget.builder(Text.literal("Add"), b -> {
            JsonObject rule = SkyFlipMod.parseRule(ruleField.getText());
            if (rule == null) { status = "§cusage: ITEM_ID or PET_TYPE or prefix* then key=value pairs"; return; }
            JsonObject m = new JsonObject(); m.addProperty("type", "rule"); m.addProperty("list", showWhitelist ? "whitelist" : "blacklist"); m.addProperty("action", "add"); m.add("rule", rule);
            mod.feed().send(m);
            ruleField.setText("");
            status = "§arule sent";
        }).dimensions(colX(1) + colW + 4, row(0) + 7, 40, 20).build());
        if (s == null) return;
        JsonArray rules = s.getAsJsonArray(showWhitelist ? "whitelist" : "blacklist");
        int perPage = perPage();
        int start = filterPage * perPage;
        for (int i = start; i < Math.min(rules.size(), start + perPage); i++) {
            JsonObject r = rules.get(i).getAsJsonObject();
            final String item = r.has("item") ? r.get("item").getAsString() : "";
            addDrawableChild(ButtonWidget.builder(Text.literal("§c✕"), b -> {
                JsonObject m = new JsonObject(); m.addProperty("type", "rule"); m.addProperty("list", showWhitelist ? "whitelist" : "blacklist"); m.addProperty("action", "remove"); m.addProperty("item", item);
                mod.feed().send(m);
                status = "removing rules for " + item + "…";
            }).dimensions(left, row(2 + (i - start)), 20, 20).build());
        }
        if (rules.size() > perPage) {
            addDrawableChild(ButtonWidget.builder(Text.literal("<"), b -> { if (filterPage > 0) { filterPage--; rebuild(); } }).dimensions(left + 300, row(1), 20, 20).build());
            addDrawableChild(ButtonWidget.builder(Text.literal(">"), b -> { if ((filterPage + 1) * perPage < rules.size()) { filterPage++; rebuild(); } }).dimensions(left + 324, row(1), 20, 20).build());
        }
    }

    private int perPage() { return Math.max(1, (height - 32 - row(2)) / ROW - 1); }

    // ------------------------------------------------------------------ render

    @Override
    public void render(DrawContext ctx, int mouseX, int mouseY, float delta) {
        renderBackground(ctx, mouseX, mouseY, delta);
        super.render(ctx, mouseX, mouseY, delta);
        ctx.drawTextWithShadow(textRenderer, Text.literal("§6§lSkyFlip §r" + (mod.feed().connected ? "§aconnected" : "§cdisconnected") + " §8" + cfg.url), left, 10, 0xFFFFFF);
        switch (tab) {
            case SERVER -> {
                label(ctx, 0, 0, "Feed url"); label(ctx, 1, 0, "Token");
                ctx.drawTextWithShadow(textRenderer, Text.literal("§8Thresholds and filters live on the server and are shared with the website."), left, row(2) + 6, 0xFFFFFF);
                label(ctx, 0, 3, "Min profit"); label(ctx, 1, 3, "Min profit %");
                label(ctx, 0, 4, "Purse / max price"); label(ctx, 1, 4, "Min sales per day");
            }
            case FILTERS -> {
                label(ctx, 1, 0, "New rule");
                JsonObject s = mod.serverSettings();
                if (s == null) {
                    ctx.drawTextWithShadow(textRenderer, Text.literal("§7not connected: rules appear once the feed is connected"), left, row(2), 0xFFFFFF);
                    break;
                }
                JsonArray rules = s.getAsJsonArray(showWhitelist ? "whitelist" : "blacklist");
                int perPage = perPage();
                int start = filterPage * perPage;
                ctx.drawTextWithShadow(textRenderer, Text.literal("§7" + rules.size() + " rule" + (rules.size() == 1 ? "" : "s") + (rules.size() > perPage ? "  page " + (filterPage + 1) : "")), left, row(1) + 6, 0xFFFFFF);
                for (int i = start; i < Math.min(rules.size(), start + perPage); i++) {
                    JsonObject r = rules.get(i).getAsJsonObject();
                    StringBuilder sb = new StringBuilder();
                    for (var e : r.entrySet()) {
                        if (e.getKey().equals("item")) sb.insert(0, "§f" + e.getValue().getAsString() + " §7");
                        else sb.append(e.getKey()).append('=').append(e.getValue().isJsonPrimitive() ? e.getValue().getAsString() : e.getValue().toString()).append(' ');
                    }
                    ctx.drawTextWithShadow(textRenderer, Text.literal(sb.toString()), left + 26, row(2 + (i - start)) + 6, 0xFFFFFF);
                }
            }
            case SOUND -> ctx.drawTextWithShadow(textRenderer, Text.literal("§8Presets here; any vanilla id via /skyflip sound <id>. Ping plays above the General tab's threshold."), left, row(3) + 6, 0xFFFFFF);
            case AUTOBUY -> {
                ctx.drawTextWithShadow(textRenderer, Text.literal(mod.botSummary()), left, row(1) + 6, 0xFFFFFF);
                if (mod.serverSettings() == null) { ctx.drawTextWithShadow(textRenderer, Text.literal("§7not connected: settings appear once the feed is connected"), left, row(2), 0xFFFFFF); break; }
                label(ctx, 0, 2, "Min profit (auto-buy)"); label(ctx, 1, 2, "Min profit %");
                label(ctx, 0, 3, "Max price per flip"); label(ctx, 1, 3, "Purse reserve");
                ctx.drawTextWithShadow(textRenderer, Text.literal("§8Both switches are off by default. Nothing is bought unless login and auto-buy are both on. Against Hypixel's rules."), left, row(8) + 10, 0xFFFFFF);
            }
            default -> { }
        }
        if (!status.isEmpty()) ctx.drawTextWithShadow(textRenderer, Text.literal(status), left, height - 44, 0xFFFFFF);
    }

    /** Called by the mod when server settings change so open tabs refresh. */
    public void onServerSettings() {
        if (tab == Tab.FILTERS || tab == Tab.SERVER || tab == Tab.AUTOBUY) MinecraftClient.getInstance().execute(this::rebuild);
    }

    /** Called by the mod when a bot status push arrives so the Auto-buy tab shows live switches. */
    public void onBotStatus() {
        if (tab == Tab.AUTOBUY && !(getFocused() instanceof TextFieldWidget)) MinecraftClient.getInstance().execute(this::rebuild);
    }

    public void setStatus(String s) { status = s; }

    private static String fmtCoins(long n) {
        if (n == 0) return "0";
        if (n % 1_000_000_000L == 0) return (n / 1_000_000_000L) + "b";
        if (n % 1_000_000L == 0) return (n / 1_000_000L) + "m";
        if (n % 1_000L == 0) return (n / 1_000L) + "k";
        return Long.toString(n);
    }
}
