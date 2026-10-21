/**
 * Shapes returned by Hypixel `GET /skyblock/bazaar`.
 *
 * Naming is from the BAZAAR's point of view, which is the reverse of a player's:
 *  - `buy_summary`  = the orders a player BUYS from  = other players' SELL OFFERS, lowest price first.
 *                     buy_summary[0].pricePerUnit is the instabuy price (quick_status.buyPrice ~ it).
 *  - `sell_summary` = the orders a player SELLS into = other players' BUY ORDERS, highest price first.
 *                     sell_summary[0].pricePerUnit is the instasell price (quick_status.sellPrice ~ it).
 *  - `buyMovingWeek`  = units players instabought/filled from sell offers over 7 days (demand).
 *  - `sellMovingWeek` = units players sold into buy orders over 7 days (supply).
 * Verified against live data: buy_summary[0] > sell_summary[0] for every product with both sides.
 */
export interface BazaarOrderSummary {
  amount: number;
  pricePerUnit: number;
  orders: number;
}

export interface BazaarQuickStatus {
  productId: string;
  sellPrice: number;
  sellVolume: number;
  sellMovingWeek: number;
  sellOrders: number;
  buyPrice: number;
  buyVolume: number;
  buyMovingWeek: number;
  buyOrders: number;
}

export interface BazaarProduct {
  product_id: string;
  sell_summary: BazaarOrderSummary[];
  buy_summary: BazaarOrderSummary[];
  quick_status: BazaarQuickStatus;
}

export interface BazaarResponse {
  success: boolean;
  lastUpdated: number;
  products: Record<string, BazaarProduct>;
}

export type BazaarRisk = 'LOW' | 'MEDIUM' | 'HIGH';

/** One order-flip opportunity: buy order below, sell offer above, pocket the spread. */
export interface BazaarFlip {
  productId: string;
  /** Human name derived from the id, e.g. ENCHANTED_LAPIS_LAZULI_BLOCK -> "Enchanted Lapis Lazuli Block". */
  name: string;
  /** Place a buy order just above the current highest buy order (+0.1). */
  buyOrderPrice: number;
  /** Place a sell offer just below the current lowest sell offer (-0.1). */
  sellOrderPrice: number;
  /** Current lowest sell offer: what instabuying costs right now. */
  instaBuy: number;
  /** Current highest buy order: what instaselling pays right now. */
  instaSell: number;
  /** sellOrderPrice - buyOrderPrice, before tax. */
  spread: number;
  /** Spread minus bazaar tax on the sell side. */
  profitPerUnit: number;
  /** profitPerUnit / buyOrderPrice. */
  profitPercent: number;
  /** Units players bought per week (demand; how fast your sell offer fills). */
  buyMovingWeek: number;
  /** Units players sold per week (supply; how fast your buy order fills). */
  sellMovingWeek: number;
  /** min(buyMovingWeek, sellMovingWeek) / 168: the binding side of the round trip. */
  unitsPerHour: number;
  /** profitPerUnit * min(unitsPerHour, maxUnitsPerHour). */
  profitPerHour: number;
  buyOrders: number;
  sellOrders: number;
  /** "/bz <name>" */
  command: string;
  risk: BazaarRisk;
}

export interface BazaarOptions {
  /** Bazaar tax on sales. Default 1.25%; 1.125% with the Bazaar Flipper I perk, 1% with II. */
  taxRate?: number;
  /** Cap on how many units per hour one flipper is assumed to move. Default 5000. */
  maxUnitsPerHour?: number;
}

export interface BazaarFilter {
  minProfitPerHour?: number;
  minProfitPercent?: number;
  /** Max buy-order price per unit. */
  maxPrice?: number;
  /** Require at least this weekly volume on the thinner side. */
  minVolumeWeek?: number;
  limit?: number;
  /** Highest risk to include. */
  risk?: BazaarRisk;
}
