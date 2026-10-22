/** Mirror of the backend's Flip (backend/src/flips/detector.ts). Only the fields the bot reads are required. */
export interface Flip {
  uuid: string;
  kind: 'SNIPE' | 'MEDIAN' | 'USER';
  itemId: string;
  ruleId: string;
  itemName: string;
  rarity: string;
  count: number;
  /** Total purchase price (whole stack). */
  price: number;
  /** Expected resale price (whole stack), before fees. */
  target: number;
  profit: number;
  profitPercent: number;
  lowestBin?: number;
  median?: number;
  priceSource: 'sales' | 'coflnet' | 'none';
  salesPerDay: number;
  keyTier: number;
  key?: string;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  whitelisted: boolean;
  seller: string;
  latencyMs: number;
  apiLastUpdated: number;
  detectedAt: number;
  ageMs: number;
  end: number;
  command: string;
  summary?: string;
  lore?: string[];
  /** When the auction becomes purchasable (bed / grace period), ms epoch. */
  purchaseAt?: number;
}

/** `createAuction` from the backend: list this inventory slot as a BIN. */
export interface CreateAuctionRequest {
  price: number;
  /** mineflayer inventory slot index. */
  slot: number;
  /** Hours. */
  duration: number;
  itemName: string;
  /** ExtraAttributes.uuid (or id) the slot must carry. */
  id: string;
}

export type Risk = Flip['risk'];

/** What the bot remembers about something it bought. */
export interface Purchase {
  auctionId: string;
  itemName: string;
  itemId: string;
  count: number;
  price: number;
  /** Resale target the detector predicted (whole stack, before fees). */
  target: number;
  boughtAt: number;
  /** ExtraAttributes.uuid of the item once known (from the inventory or the backend's purchase event). */
  itemUuid?: string;
  /** Lifecycle: bought → (claimed) → listed → sold. 'lost' when the item never showed up. */
  state: 'bought' | 'claimed' | 'listed' | 'sold' | 'lost';
  /** Current/last listing price. */
  listPrice?: number;
  listedAt?: number;
  /** How many times it has been (re)listed. */
  listings: number;
  soldAt?: number;
  soldPrice?: number;
  /** Last error from a GUI flow, for the status screen. */
  lastError?: string;
  /** Flip kind that produced it, for stats. */
  kind: Flip['kind'];
}

export interface BotStats {
  startedAt: number;
  bought: number;
  spent: number;
  listed: number;
  sold: number;
  revenue: number;
  failed: number;
  skipped: number;
}

export type BotState = 'starting' | 'auth' | 'connecting' | 'joining' | 'idle' | 'buying' | 'claiming' | 'listing' | 'paused' | 'offline' | 'stopped' | 'banned';

/** Snapshot reported to the backend (and from there to the web UI and mod). */
export interface BotStatus {
  state: BotState;
  mode: 'live' | 'dry' | 'offline';
  player?: string;
  uuid?: string;
  purse?: number;
  purseUpdatedAt?: number;
  location?: string;
  stats: BotStats;
  pending: Purchase[];
  /** Last few human-readable events, newest last. */
  events: BotEvent[];
  /** Set while Microsoft sign-in is waiting for the user. */
  authMessage?: string;
  paused: boolean;
  updatedAt: number;
}

export interface BotEvent {
  ts: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}
