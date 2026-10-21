import test from 'node:test';
import assert from 'node:assert/strict';
import { stripColor, normalizeName, parseCoins, coinsInLine, parsePurseLine, classifyChat, looksLikeBan, reasonText, priceForSign, fmtCoins } from '../text.js';

test('stripColor and normalizeName', () => {
  assert.equal(stripColor('§6§lLEGENDARY §fHyperion'), 'LEGENDARY Hyperion');
  assert.equal(normalizeName('§dHyperion §6✪✪✪✪✪'), 'hyperion');
  assert.equal(normalizeName('  Aspect of the  End '), 'aspect of the end');
});

test('coin parsing', () => {
  assert.equal(parseCoins('1,234,567'), 1_234_567);
  assert.equal(parseCoins('1.5m'), 1_500_000);
  assert.equal(parseCoins('12k coins'), 12_000);
  assert.ok(Number.isNaN(parseCoins('abc')));
  assert.equal(coinsInLine('§7Price: §61,234,567 coins'), 1_234_567);
  assert.equal(coinsInLine('§7Price: §6950 coins'), 950);
  assert.ok(Number.isNaN(coinsInLine('§7Seller: §bSomeone')));
  assert.equal(parsePurseLine('§fPurse: §612,345,678'), 12_345_678);
  assert.equal(parsePurseLine('Piggy: 1,000 §e(+500)'), 1_000);
  assert.equal(parsePurseLine('Bits: 1,000'), undefined);
});

test('chat classification', () => {
  assert.deepEqual(classifyChat('§aYou purchased §6Hyperion §afor §61,000,000 coins!'), { type: 'purchased', item: 'Hyperion', price: 1_000_000 });
  assert.equal(classifyChat('You claimed Hyperion from the auction house!').type, 'claimed');
  assert.equal(classifyChat('This auction has already been sold!').type, 'buyFailed');
  assert.equal(classifyChat("You don't have enough coins to purchase this!").type, 'buyFailed');
  assert.equal(classifyChat('You cannot afford this!').type, 'buyFailed');
  assert.equal(classifyChat('BIN Auction started for Hyperion!').type, 'listed');
  assert.equal(classifyChat('Auction started for Hyperion!').type, 'listed');
  assert.equal(classifyChat('You have reached the maximum number of auctions!').type, 'listFailed');
  assert.equal(classifyChat('Please wait a moment before doing that again!').type, 'ratelimited');
  assert.equal(classifyChat('You were spawned in Limbo.').type, 'limbo');
  assert.deepEqual(classifyChat('[Auction] Steve bought Hyperion for 1,000,000 coins CLICK'), { type: 'sold', item: 'Hyperion', price: 1_000_000 });
  assert.equal(classifyChat('Welcome to Hypixel SkyBlock!').type, 'none');
});

test('ban detection and reasons', () => {
  assert.ok(looksLikeBan('§cYou are permanently banned from this server!\n§7Reason: §fCheating'));
  assert.ok(looksLikeBan('{"text":"Suspicious activity has been detected on your account"}'));
  assert.ok(!looksLikeBan('Internal server error'));
  assert.ok(!looksLikeBan('You were kicked for being idle'));
  assert.equal(reasonText('{"text":"a","extra":[{"text":"b"},"c"]}'), 'abc');
  assert.equal(reasonText({ translate: 'multiplayer.disconnect.generic' }), 'multiplayer.disconnect.generic');
});

test('sign price and formatting', () => {
  assert.equal(priceForSign(1_234_567.9), '1234567');
  assert.equal(priceForSign(0), '1');
  assert.equal(fmtCoins(1_500_000), '1.50m');
  assert.equal(fmtCoins(25_000_000), '25.0m');
  assert.equal(fmtCoins(950), '950');
  assert.equal(fmtCoins(-2_500), '-2.5k');
});
