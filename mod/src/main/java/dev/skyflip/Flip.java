package dev.skyflip;

/** One flip as sent by the backend over the WebSocket feed. Field names match the JSON. */
public final class Flip {
    public String uuid;
    public String kind;        // SNIPE | MEDIAN
    public String itemId;
    public String itemName;
    public String rarity;
    public int count;
    public long price;
    public long target;
    public long profit;
    public double profitPercent;
    public Long lowestBin;
    public Long median;
    public double salesPerDay;
    public int keyTier;
    public String risk;        // LOW | MEDIUM | HIGH
    public long latencyMs;
    public long detectedAt;
    public long ageMs;
    public String command;     // "/viewauction <uuid>"
    public String summary;

    public long receivedAt = System.currentTimeMillis();
}
