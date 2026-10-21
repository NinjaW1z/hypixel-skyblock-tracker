package dev.skyflip;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/** Persisted in config/skyflip.json. */
public final class FlipConfig {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final Path FILE = FabricLoader.getInstance().getConfigDir().resolve("skyflip.json");

    /** WebSocket endpoint of the backend. */
    public String url = "ws://127.0.0.1:3131/ws";
    /** Show flips in chat. */
    public boolean enabled = true;
    /** Ping on each flip. */
    public boolean sound = true;
    /** Only show flips while connected to Hypixel (the command only works there anyway). */
    public boolean hypixelOnly = true;
    /** Hide flips with this risk or worse: "HIGH" hides nothing, "MEDIUM" hides HIGH, "LOW" hides MEDIUM+HIGH. */
    public String maxRisk = "HIGH";
    /** Drop flips older than this many seconds when pressing the open keybind. */
    public int staleAfterSeconds = 20;

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
        int allowed = rank(maxRisk);
        return rank(risk) <= allowed;
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
