import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadBackground, makeBrowserStub } from './helpers.js';

test('REFRESH_DEBRIS fetches live fields and updates the saved snapshot', async () => {
  const store = makeBrowserStub({
    system_zones: { A1: 'open' },
    debris_fields: [{ id: 'stale', debrisId: 4, systemId: 99, ore: 500 }],
  });
  const requests = [];
  globalThis.browser.alarms.get = async () => null;
  globalThis.browser.tabs.query = async () => [{ id: 42, url: 'https://s0.nexuslegacy.space/' }];
  globalThis.browser.tabs.sendMessage = async (_tabId, message) => {
    requests.push(message);
    return {
      ok: true,
      data: {
        debris: [{
          id: 5,
          systemName: 'A1',
          ore: 1000,
          silicates: 500,
          alloys: 100,
          expiresAt: '2026-10-12T12:00:00.000Z',
        }],
      },
    };
  };

  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  const response = await listener({ type: 'REFRESH_DEBRIS' });

  assert.deepEqual(response, { ok: true });
  assert.equal(requests[0].path, '/api/fleet/system-debris');
  assert.equal(store.debris_fields.length, 1);
  assert.equal(store.debris_fields[0].id, '5');
  assert.equal(store.debris_fields[0].ore, 1000);
  assert.equal(store.debris_fields[0].zone, 'open');
});

test('REFRESH_DEBRIS preserves the saved snapshot when the live request fails', async () => {
  const previousFields = [{ id: '5', debrisId: 5, ore: 900, first_seen: '2026-10-10T12:00:00.000Z' }];
  const store = makeBrowserStub({ debris_fields: previousFields });
  globalThis.browser.alarms.get = async () => null;
  globalThis.browser.tabs.query = async () => [{ id: 42, url: 'https://s0.nexuslegacy.space/' }];
  globalThis.browser.tabs.sendMessage = async () => ({
    ok: false,
    status: 400,
    error: 'Invalid request',
  });

  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  const response = await listener({ type: 'REFRESH_DEBRIS' });

  assert.match(response.error, /Invalid request/);
  assert.deepEqual(store.debris_fields, previousFields);
});
