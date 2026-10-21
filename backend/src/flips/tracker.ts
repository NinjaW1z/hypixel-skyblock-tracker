import { EventEmitter } from 'node:events';
import type { Store } from '../storage/db.js';
import type { Flip } from './detector.js';
import type { ItemData } from '../nbt/decode.js';

/** One sold auction from the ended feed, already decoded. */
export interface SaleEvent {
  auctionId: string;
  seller: string;
  buyer: string;
  price: number;
  ts: number;
  bin: boolean;
  item: ItemData;
}

export interface Purchase {
  auctionId: string;
  player: string;
  itemId: string;
  itemName: string;
  /** ExtraAttributes.uuid of the item, used to recognise the resale. */
  itemUuid?: string;
  price: number;
  boughtAt: number;
  /** Profit the detector predicted when it flagged this auction, if it did. */
  predictedProfit?: number;
  soldAt?: number;
  soldPrice?: number;
  soldAuctionId?: string;
}

export interface ProfitSummary {
  player: string;
  sinceMs: number;
  bought: number;
  sold: number;
  spent: number;
  revenue: number;
  realizedProfit: number;
  pending: number;
  pendingValue: number;
  recent: Purchase[];
}

/**
 * Coflnet-style profit tracking. Players identify themselves from the mod (their UUID);
 * every sold auction is then checked: a purchase by a tracked player is recorded, and a later
 * sale by that player of the same item (matched by the item's own NBT uuid) closes it out.
 */
export class ProfitTracker extends EventEmitter {
  private readonly players = new Set<string>();
  private readonly flagged = new Map<string, Flip>();

  constructor(private readonly store: Store) {
    super();
    for (const p of store.loadPlayers()) this.players.add(p);
  }

  track(playerUuid: string): void {
    const u = normalizeUuid(playerUuid);
    if (!u || this.players.has(u)) return;
    this.players.add(u);
    this.store.savePlayer(u);
  }

  get trackedPlayers(): string[] { return [...this.players]; }

  /** Remember what we predicted so a purchase can be compared to it later. */
  rememberFlip(f: Flip): void {
    this.flagged.set(f.uuid, f);
    if (this.flagged.size > 20_000) {
      for (const k of this.flagged.keys()) { this.flagged.delete(k); if (this.flagged.size <= 15_000) break; }
    }
  }

  onSale(s: SaleEvent): void {
    if (this.players.size === 0) return;
    const buyer = normalizeUuid(s.buyer);
    const seller = normalizeUuid(s.seller);
    const itemUuid = typeof s.item.raw.uuid === 'string' ? s.item.raw.uuid : undefined;

    if (buyer && this.players.has(buyer)) {
      const flip = this.flagged.get(s.auctionId);
      const p: Purchase = {
        auctionId: s.auctionId, player: buyer, itemId: s.item.id, itemName: s.item.name, itemUuid,
        price: s.price, boughtAt: s.ts, predictedProfit: flip?.profit,
      };
      this.store.savePurchase(p);
      this.emit('purchase', p, flip);
    }
    if (seller && this.players.has(seller) && itemUuid) {
      const open = this.store.findOpenPurchase(seller, itemUuid);
      if (open) {
        open.soldAt = s.ts; open.soldPrice = s.price; open.soldAuctionId = s.auctionId;
        this.store.savePurchase(open);
        this.emit('sold', open);
      }
    }
  }

  summary(playerUuid: string, sinceMs = 7 * 86_400_000, now = Date.now()): ProfitSummary {
    const player = normalizeUuid(playerUuid) ?? playerUuid;
    const rows = this.store.purchasesSince(player, now - sinceMs);
    const out: ProfitSummary = { player, sinceMs, bought: rows.length, sold: 0, spent: 0, revenue: 0, realizedProfit: 0, pending: 0, pendingValue: 0, recent: rows.slice(-25).reverse() };
    for (const r of rows) {
      out.spent += r.price;
      if (r.soldPrice !== undefined) {
        out.sold++;
        const net = r.soldPrice - Math.floor(r.soldPrice * (r.soldPrice >= 100_000_000 ? 0.03 : r.soldPrice >= 10_000_000 ? 0.02 : 0.01)) - (r.soldPrice > 1_000_000 ? Math.floor(r.soldPrice * 0.01) : 0);
        out.revenue += net;
        out.realizedProfit += net - r.price;
      } else {
        out.pending++;
        out.pendingValue += r.price;
      }
    }
    return out;
  }
}

export function normalizeUuid(u: string | undefined): string | undefined {
  if (!u) return undefined;
  const h = u.replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(h) ? h : undefined;
}
