package dev.skyflip;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/**
 * WebSocket client for the SkyFlip backend. Uses the JDK's HttpClient so the mod
 * carries no extra dependencies. Reconnects with backoff; delivers parsed flips
 * on a background thread (the caller hops to the render thread).
 */
public final class FeedClient implements WebSocket.Listener {
    private static final Gson GSON = new Gson();
    private final ScheduledExecutorService exec = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "skyflip-feed");
        t.setDaemon(true);
        return t;
    });
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final Consumer<Flip> onFlip;
    private final Consumer<String> onStatus;
    private final StringBuilder partial = new StringBuilder();
    private final AtomicBoolean wantConnected = new AtomicBoolean(false);
    private volatile WebSocket socket;
    private volatile String url;
    private int backoffMs = 1_000;
    public volatile boolean connected = false;

    public FeedClient(String url, Consumer<Flip> onFlip, Consumer<String> onStatus) {
        this.url = url;
        this.onFlip = onFlip;
        this.onStatus = onStatus;
    }

    public void start() {
        wantConnected.set(true);
        exec.execute(this::connect);
    }

    public void stop() {
        wantConnected.set(false);
        WebSocket s = socket;
        if (s != null) s.sendClose(WebSocket.NORMAL_CLOSURE, "bye");
    }

    public void setUrl(String url) {
        this.url = url;
        reconnect();
    }

    public void reconnect() {
        WebSocket s = socket;
        if (s != null) s.abort();
        socket = null;
        connected = false;
        backoffMs = 500;
        exec.execute(this::connect);
    }

    /** Push a settings patch to the backend (same shape as the REST /api/settings body). */
    public void sendSettings(JsonObject patch) {
        WebSocket s = socket;
        if (s == null) return;
        JsonObject msg = new JsonObject();
        msg.addProperty("type", "settings");
        msg.add("settings", patch);
        s.sendText(GSON.toJson(msg), true);
    }

    private void connect() {
        if (!wantConnected.get() || socket != null) return;
        try {
            http.newWebSocketBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .buildAsync(URI.create(url), this)
                .whenComplete((ws, err) -> {
                    if (err != null) {
                        scheduleReconnect("connect failed: " + rootMessage(err));
                    } else {
                        socket = ws;
                        connected = true;
                        backoffMs = 1_000;
                        onStatus.accept("connected to " + url);
                    }
                });
        } catch (RuntimeException e) {
            scheduleReconnect("bad url: " + e.getMessage());
        }
    }

    private void scheduleReconnect(String why) {
        socket = null;
        connected = false;
        if (!wantConnected.get()) return;
        onStatus.accept(why + " · retrying in " + (backoffMs / 1000) + "s");
        exec.schedule(this::connect, backoffMs, TimeUnit.MILLISECONDS);
        backoffMs = Math.min(backoffMs * 2, 15_000);
    }

    private static String rootMessage(Throwable t) {
        while (t.getCause() != null) t = t.getCause();
        return t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
    }

    // ---- WebSocket.Listener ----

    @Override
    public void onOpen(WebSocket webSocket) {
        webSocket.request(1);
    }

    @Override
    public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
        partial.append(data);
        if (last) {
            String text = partial.toString();
            partial.setLength(0);
            handle(text);
        }
        webSocket.request(1);
        return null;
    }

    private void handle(String text) {
        try {
            JsonObject msg = JsonParser.parseString(text).getAsJsonObject();
            String type = msg.has("type") ? msg.get("type").getAsString() : "";
            if (type.equals("flip")) {
                onFlip.accept(GSON.fromJson(msg.get("flip"), Flip.class));
            } else if (type.equals("hello")) {
                int n = msg.has("flips") ? msg.getAsJsonArray("flips").size() : 0;
                onStatus.accept("feed ready (" + n + " recent flips on server)");
            }
        } catch (RuntimeException ignored) {
            // malformed frame: ignore
        }
    }

    @Override
    public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
        scheduleReconnect("feed closed (" + statusCode + ")");
        return null;
    }

    @Override
    public void onError(WebSocket webSocket, Throwable error) {
        scheduleReconnect("feed error: " + rootMessage(error));
    }
}
