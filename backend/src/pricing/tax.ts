/**
 * Auction house costs borne by the reseller.
 *  - BIN listing fee: 1% under 10M, 2% from 10M, 3% from 100M (charged on creation).
 *  - Collection tax: 1% of the sale when the sale is over 1M (charged on claim).
 * Both are applied to the resale price (the flip target).
 */
export function listingFee(price: number): number {
  const rate = price >= 100_000_000 ? 0.03 : price >= 10_000_000 ? 0.02 : 0.01;
  return Math.floor(price * rate);
}
export function collectionTax(price: number): number {
  return price > 1_000_000 ? Math.floor(price * 0.01) : 0;
}
export function netAfterFees(price: number): number {
  return price - listingFee(price) - collectionTax(price);
}
