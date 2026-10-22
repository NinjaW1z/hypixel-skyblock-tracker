/** Shapes returned by the Hypixel v2 SkyBlock auction endpoints. */

export interface Bid {
  auction_id: string;
  bidder: string;
  profile_id: string;
  amount: number;
  timestamp: number;
}

export interface Auction {
  uuid: string;
  auctioneer: string;
  profile_id: string;
  coop?: string[];
  start: number;
  end: number;
  item_name: string;
  item_lore: string;
  extra?: string;
  category: string;
  /** Rarity: COMMON, UNCOMMON, RARE, EPIC, LEGENDARY, MYTHIC, DIVINE, SPECIAL, VERY_SPECIAL */
  tier: string;
  starting_bid: number;
  /** v2 returns a base64 string; older payloads wrap it in an object. */
  item_bytes: string | { type: number; data: string };
  claimed: boolean;
  claimed_bidders?: unknown[];
  highest_bid_amount: number;
  last_updated?: number;
  /** Present and true only for Buy-It-Now auctions. */
  bin?: boolean;
  bids?: Bid[];
}

export interface AuctionsPage {
  success: boolean;
  page: number;
  totalPages: number;
  totalAuctions: number;
  lastUpdated: number;
  auctions: Auction[];
}

export interface EndedAuction {
  auction_id: string;
  seller: string;
  seller_profile: string;
  buyer: string;
  buyer_profile?: string;
  timestamp: number;
  price: number;
  bin: boolean;
  item_bytes: string | { type: number; data: string };
}

export interface EndedResponse {
  success: boolean;
  lastUpdated: number;
  auctions: EndedAuction[];
}

export function itemBytesOf(a: { item_bytes: string | { type: number; data: string } }): string {
  return typeof a.item_bytes === 'string' ? a.item_bytes : a.item_bytes.data;
}
