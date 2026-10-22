package dev.skyflip;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/** Persisted in config/skyflip.json. Server-side settings (thresholds, filters) live on the backend. */
public final class FlipConfig {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final Path FILE = FabricLoader.getInstance().getConfigDir().resolve("skyflip.json");

    /** WebSocket endpoint of the backend. */
    public String url = "ws://127.0.0.1:3131/ws";
    /** Shared secret (SKYFLIP_TOKEN on the server); empty when the server has none. */
    public String token = "";
    /** Show flips in chat. */
    public boolean enabled = true;
    /** Play a sound on each flip. */
    public boolean sound = true;
    /** Sound for a normal flip: a preset name (villager, chime, pling, orb, bell, level, toast, click) or any vanilla id like entity.villager.ambient. */
    public String soundName = "villager";
    /** 0.0 - 1.0 */
    public float soundVolume = 0.35f;
    /** 0.5 - 2.0 */
    public float soundPitch = 1.0f;
    /** Sound for flips over pingAbove. */
    public String pingSoundName = "chime";
    public float pingVolume = 0.6f;
    public float pingPitch = 1.0f;
    /** Only play sounds for flips at this risk or safer: HIGH = all, MEDIUM = LOW+MEDIUM, LOW = LOW only. */
    public String soundMaxRisk = "HIGH";
    /** Only show flips while connected to Hypixel (the command only works there anyway). */
    public boolean hypixelOnly = true;
    /** Hide flips with this risk or worse on the client side: HIGH hides nothing, MEDIUM hides HIGH, LOW hides MEDIUM+HIGH. */
    public String maxRisk = "HIGH";
    /** Drop flips older than this many seconds when pressing the open keybind. */
    public int staleAfterSeconds = 20;

    // ---- chat line visibility (Coflnet "/cofl set mod..." equivalents) ----
    public boolean showLowestBin = true;
    public boolean showMedian = true;
    public boolean showVolume = true;
    public boolean showProfitPercent = true;
    public boolean showSeller = false;
    public boolean showLag = false;
    public boolean showLore = true;
    public boolean shortNumbers = true;
    /** Ping (louder sound) when profit is at least this many coins. 0 = never. */
    public long pingAbove = 10_000_000L;
    /** Print purchase/sale notifications for your own flips. */
    public boolean notifySales = true;

    public static FlipConfig load() {
        try {
            if (Files.exists(FILE)) {
                FlipConfig c = GSON.fromJson(Files.readString(FILE), FlipConfig.class);
                if (c != null) return c;
            }
        } catch (IOException | RuntimeException ignored) {
        }
        FlipConfig c = new FlipConfig();
        c.save();
        return c;
    }

    public void save() {
        try {
            Files.createDirectories(FILE.getParent());
            Files.writeString(FILE, GSON.toJson(this));
        } catch (IOException ignored) {
        }
    }

    public boolean riskAllowed(String risk) {
        return rank(risk) <= rank(maxRisk);
    }

    private static int rank(String r) {
        if (r == null) return 2;
        return switch (r) {
            case "LOW" -> 0;
            case "MEDIUM" -> 1;
            default -> 2;
        };
    }
}
