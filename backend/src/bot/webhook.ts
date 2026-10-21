import { request } from 'undici';
import { log } from '../util/log.js';

/** Discord webhook sender with a small queue so bursts don't hit Discord's rate limit. */
export class DiscordWebhook {
  private queue: string[] = [];
  private sending = false;
  constructor(private readonly urlOf: () => string, private readonly minGapMs = 1_500) {}

  send(text: string): void {
    if (!this.urlOf()) return;
    this.queue.push(text.slice(0, 1_900));
    if (this.queue.length > 20) this.queue.shift();
    if (!this.sending) void this.drain();
  }

  private async drain(): Promise<void> {
    this.sending = true;
    try {
      while (this.queue.length) {
        const url = this.urlOf();
        const content = this.queue.shift()!;
        if (!url) continue;
        try {
          const res = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }), headersTimeout: 8_000, bodyTimeout: 8_000 });
          await res.body.text();
          if (res.statusCode >= 400) log.warn(`discord webhook HTTP ${res.statusCode}`);
        } catch (e) { log.warn('discord webhook failed:', (e as Error).message); }
        await new Promise((r) => setTimeout(r, this.minGapMs));
      }
    } finally { this.sending = false; }
  }
}
