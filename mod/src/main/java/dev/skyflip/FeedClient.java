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
 * WebSocket client for the SkyFlip backend. Uses the JDK's HttpClient so the mod carries no
 * extra dependencies. Reconnects with backoff; delivers parsed messages on a background
 * thread (the caller hops to the render thread).
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
    private final Consumer<JsonObject> onMessage;
    private final Consumer<String> onStatus;
    private final StringBuilder partial = new StringBuilder();
    private final AtomicBoolean wantConnected = new AtomicBoolean(false);
    private volatile WebSocket socket;
    private volatile String url;
    private volatile String token;
    private int backoffMs = 1_000;
    public volatile boolean connected = false;
    /** Set on connect so the backend can attribute purchases/sales. */
    public volatile String playerUuid;
    public volatile String playerName;

    public FeedClient(String url, String token, Consumer<Flip> onFlip, Consumer<JsonObject> onMessage, Consumer<String> onStatus) {
        this.url = url;
        this.token = token;
        this.onFlip = onFlip;
        this.onMessage = onMessage;
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

    public void setUrl(String url) { this.url = url; reconnect(); }
    public void setToken(String token) { this.token = token == null ? "" : token; reconnect(); }

    public void reconnect() {
        WebSocket s = socket;
        if (s != null) s.abort();
        socket = null;
        connected = false;
        backoffMs = 500;
        exec.execute(this::connect);
    }

    /** Send any JSON message to the backend (see server protocol: settings, set, rule, bazaar, profit, identify). */
    public void send(JsonObject msg) {
        WebSocket s = socket;
        if (s == null) { onStatus.accept("not connected"); return; }
        s.sendText(GSON.toJson(msg), true);
    }

    public void identify(String uuid, String name) {
        this.playerUuid = uuid;
        this.playerName = name;
        if (socket == null || uuid == null) return;
        JsonObject m = new JsonObject();
        m.addProperty("type", "identify");
        m.addProperty("uuid", uuid);
        if (name != null) m.addProperty("name", name);
        send(m);
    }

    private void connect() {
        if (!wantConnected.get() || socket != null) return;
        try {
            WebSocket.Builder b = http.newWebSocketBuilder().connectTimeout(Duration.ofSeconds(5));
            if (token != null && !token.isEmpty()) b.header("Authorization", "Bearer " + token);
            b.buildAsync(URI.create(url), this).whenComplete((ws, err) -> {
                if (err != null) {
                    String msg = rootMessage(err);
                    if (msg.contains("401")) {
                        onStatus.accept("§cserver rejected the token. Set it with /skyflip token <token>");
                        scheduleReconnect(null, 15_000);
                    } else {
                        scheduleReconnect("connect failed: " + msg, -1);
                    }
                } else {
                    socket = ws;
                    connected = true;
                    backoffMs = 1_000;
                    onStatus.accept("connected to " + url);
                    if (playerUuid != null) identify(playerUuid, playerName);
                }
            });
        } catch (RuntimeException e) {
            scheduleReconnect("bad url: " + e.getMessage(), -1);
        }
    }

    private void scheduleReconnect(String why, int fixedDelayMs) {
        socket = null;
        connected = false;
        if (!wantConnected.get()) return;
        int delay = fixedDelayMs > 0 ? fixedDelayMs : backoffMs;
        if (why != null) onStatus.accept(why + " · retrying in " + (delay / 1000) + "s");
        exec.schedule(this::connect, delay, TimeUnit.MILLISECONDS);
        if (fixedDelayMs <= 0) backoffMs = Math.min(backoffMs * 2, 15_000);
    }

    private static String rootMessage(Throwable t) {
        while (t.getCause() != null) t = t.getCause();
        return t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
    }

    // ---- WebSocket.Listener ----

    @Override
    public void onOpen(WebSocket webSocket) { webSocket.request(1); }

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
            if (type.equals("flip")) onFlip.accept(GSON.fromJson(msg.get("flip"), Flip.class));
            else onMessage.accept(msg);
        } catch (RuntimeException ignored) {
            // malformed frame: ignore
        }
    }

    @Override
    public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
        scheduleReconnect("feed closed (" + statusCode + ")", -1);
        return null;
    }

    @Override
    public void onError(WebSocket webSocket, Throwable error) {
        scheduleReconnect("feed error: " + rootMessage(error), -1);
    }
}
