import { test } from 'node:test';
import assert from 'node:assert';

import { makeBrowserStub, loadBackground } from './helpers.js';
import { marketTradeNet, resourceWeight } from '../nexus-addon/common.js';

test('resourceWeight and marketTradeNet compute consistent ore-equivalent values', () => {
  assert.equal(resourceWeight('ore'), 1);
  assert.equal(resourceWeight('silicates'), 2);
  assert.equal(resourceWeight('hydrogen'), 3);
  assert.equal(resourceWeight('alloys'), 5);
  assert.equal(resourceWeight('cryo_ice'), 10); // fallback to RARE_WEIGHT

  const trade = {
    sellerId: 7,
    buyerId: 9,
    amountSold: 5400,
    resourceSold: 'hydrogen',
    amountPaid: 600,
    resourcePaid: 'cryo_ice',
    commissionSeller: 30,
    commissionBuyer: 270,
  };

  assert.deepEqual(marketTradeNet(trade, 9), {
    soldByMe: false,
    fee: 270,
    paidResource: 'cryo_ice',
    receivedResource: 'hydrogen',
    paid: 600,
    received: 5130,
    oreEquivalent: 9390,
  });

  assert.deepEqual(marketTradeNet(trade, 7), {
    soldByMe: true,
    fee: 30,
    paidResource: 'hydrogen',
    receivedResource: 'cryo_ice',
    paid: 5400,
    received: 570,
    oreEquivalent: -10500,
  });
});

test('getMarketTrades loads every paginated page', async () => {
  makeBrowserStub();
  const paths = [];

  globalThis.browser.tabs.query = async () => [{ id: 17 }];
  globalThis.browser.tabs.sendMessage = async (tabId, message) => {
    assert.equal(tabId, 17);
    paths.push(message.path);
    const pageMatch = message.path.match(/[?&]page=(\d+)/);
    const page = pageMatch ? Number(pageMatch[1]) : 1;

    const all = [
      { id: 1, createdAt: '2026-08-10T10:00:00Z' },
      { id: 2, createdAt: '2026-08-11T10:00:00Z' },
      { id: 3, createdAt: '2026-08-12T10:00:00Z' },
      { id: 4, createdAt: '2026-08-13T10:00:00Z' },
      { id: 5, createdAt: '2026-08-14T10:00:00Z' },
    ];

    const limit = 2;
    const start = (page - 1) * limit;
    return {
      ok: true,
      data: {
        trades: all.slice(start, start + limit),
        pagination: { total: all.length, limit },
      },
    };
  };

  const bg = await loadBackground();
  const result = await bg.getMarketTrades();

  assert.equal(result.error, undefined);
  assert.equal(result.trades.length, 5);
  assert.deepEqual(result.trades.map(t => t.id), [1, 2, 3, 4, 5]);

  const tradeCalls = paths.filter(path => path.startsWith('/api/market/my-trades'));
  assert.deepEqual(tradeCalls, [
    '/api/market/my-trades?page=1&limit=100',
    '/api/market/my-trades?page=2&limit=2',
    '/api/market/my-trades?page=3&limit=2',
  ]);
});
