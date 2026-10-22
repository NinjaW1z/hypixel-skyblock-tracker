import { encodeItemBytes, type ItemSpec } from '../nbt/encode.js';
import type { Auction } from '../hypixel/types.js';

let n = 0;
export function auction(spec: ItemSpec & { price: number; bin?: boolean; uuid?: string; start?: number }): Auction {
  const id = spec.uuid ?? `uuid-${++n}`;
  return {
    uuid: id, auctioneer: 'seller', profile_id: 'p', start: spec.start ?? Date.now() - 5000, end: Date.now() + 1e6,
    item_name: spec.name ?? spec.id, item_lore: '', category: 'misc', tier: spec.rarity ?? 'COMMON', starting_bid: spec.price,
    item_bytes: encodeItemBytes(spec), claimed: false, highest_bid_amount: 0, bin: spec.bin ?? true, bids: [],
  };
}
