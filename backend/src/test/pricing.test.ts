import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimmedMedian } from '../pricing/stats.js';
import { netAfterFees, listingFee, collectionTax } from '../pricing/tax.js';
import { SalesBook, LowestBinBook } from '../pricing/priceBook.js';

test('trimmed median ignores manipulation', () => {
  const r = trimmedMedian([100, 102, 98, 101, 99, 5000, 1]);
  assert.equal(r.median, 100);
  assert.equal(r.kept, 5);
  assert.equal(trimmedMedian([]).median, 0);
  assert.equal(trimmedMedian([7]).median, 7);
});

test('fees', () => {
  assert.equal(listingFee(5_000_000), 50_000);
  assert.equal(listingFee(50_000_000), 1_000_000);
  assert.equal(listingFee(200_000_000), 6_000_000);
  assert.equal(collectionTax(900_000), 0);
  assert.equal(collectionTax(2_000_000), 20_000);
  assert.equal(netAfterFees(10_000_000), 10_000_000 - 200_000 - 100_000);
});

test('sales book picks the finest tier with volume and haircuts coarser tiers', () => {
  const book = new SalesBook(7);
  const now = Date.now();
  const keys = ['X|LEG|S10|RC', 'X|LEG|S10', 'X|LEG', 'X|LEG', 'X'];
  // only 2 exact sales, 6 at tier 1
  book.record(keys, 100, now - 1000, true);
  book.record(keys, 110, now - 2000, true);
  for (let i = 0; i < 4; i++) book.record(['other|LEG|S10|RC|G', 'X|LEG|S10', 'X|LEG', 'X|LEG', 'X'], 200, now - 3000 - i, true);
  const est = book.estimate(keys, now)!;
  assert.equal(est.tier, 1);
  assert.equal(est.volume, 6);
  assert.equal(est.price, Math.floor(200 * 0.96)); // trimmed median of [100,110,200,200,200,200]
  assert.equal(book.estimate(['nope', 'nope', 'nope', 'nope', 'nope'], now), undefined);
});

test('sales book expires old sales', () => {
  const book = new SalesBook(1);
  const now = Date.now();
  const keys = ['K', 'K', 'K', 'K', 'K'];
  for (let i = 0; i < 5; i++) book.record(keys, 100, now - 2 * 86_400_000, true);
  assert.equal(book.estimate(keys, now), undefined);
});

test('lowest bin book returns the cheapest other listing and swaps atomically', () => {
  const lb = new LowestBinBook();
  lb.beginSnapshot();
  lb.add(['K0', 'K1'], 'a', 500);
  lb.add(['K0', 'K1'], 'b', 300);
  lb.add(['K0', 'K1'], 'c', 400);
  lb.add(['K0', 'K1'], 'd', 900);
  assert.equal(lb.lowestOther('K0', 'zzz'), undefined, 'not committed yet');
  lb.commit();
  assert.equal(lb.lowestOther('K0', 'zzz')?.price, 300);
  assert.equal(lb.lowestOther('K0', 'b')?.price, 400);
  assert.equal(lb.lowestOther('K1', 'b')?.uuid, 'c');
  assert.equal(lb.lowestOther('nope', 'b'), undefined);
});

test('identical tier keys are counted once', () => {
  const book = new SalesBook(7);
  const now = Date.now();
  book.record(['X|LEG', 'X|LEG', 'X|LEG', 'X|LEG', 'X'], 100, now, true);
  book.record(['X|LEG', 'X|LEG', 'X|LEG', 'X|LEG', 'X'], 100, now, true);
  assert.equal(book.estimate(['X|LEG', 'X|LEG', 'X|LEG', 'X|LEG', 'X'], now), undefined, '2 sales must not look like 6');
  const lb = new LowestBinBook();
  lb.beginSnapshot(); lb.add(['K', 'K'], 'a', 5); lb.commit();
  assert.deepEqual(lb.othersOf('K', 'zzz'), [5]);
});
