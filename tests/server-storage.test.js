import test from 'node:test';
import assert from 'node:assert';
import { makeBrowserStub } from './helpers.js';

import fs from 'node:fs';

const uniqueImport = (spec) => import(`${spec}?ts=${crypto.randomUUID()}`);

// Package the new server-aware storage shim so the built extension actually
// contains the NX-S0 / NX-NF split instead of the old global storage behavior.
test('build manifest includes the server-storage shim', () => {
  const build = fs.readFileSync(new URL('../nexus-addon/build.py', import.meta.url), 'utf8');
  assert.match(build, /'server-storage\.js'/);
});

test('manifest requests tabs permission for active-game detection', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../nexus-addon/manifest.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(manifest.permissions), 'permissions array exists');
  assert.ok(manifest.permissions.includes('tabs'), 'manifest includes tabs permission for active game tab detection');
});

test('server storage isolates NX-S0 from NX-NF', async () => {
  const store = makeBrowserStub();

  await import(`../nexus-addon/server-storage.js?ts=${Date.now()}`);

  assert.deepEqual(globalThis.nexusStorage.servers.s0, {
    key: 's0',
    id: 'NX-S0',
    name: 'Season 0',
    hostname: 's0.nexuslegacy.space',
    origin: 'https://s0.nexuslegacy.space',
  });
  assert.deepEqual(globalThis.nexusStorage.serverFromUrl('https://nf.nexuslegacy.space/galaxy'), {
    key: 'nf',
    id: 'NX-NF',
    name: 'New Frontier',
    hostname: 'nf.nexuslegacy.space',
    origin: 'https://nf.nexuslegacy.space',
  });

  await globalThis.nexusStorage.setActiveServer('s0');
  await globalThis.browser.storage.local.set({ foo: 's0' });
  await globalThis.nexusStorage.setActiveServer('nf');
  await globalThis.browser.storage.local.set({ foo: 'nf' });

  assert.equal(store['nexus_server:s0:foo'], 's0');
  assert.equal(store['nexus_server:nf:foo'], 'nf');
  assert.equal((await globalThis.browser.storage.local.get('foo')).foo, 'nf');
  assert.equal((await globalThis.nexusStorage.get('foo')).foo, 'nf');
});

test('storage wrapper is active in normal extension pages', async () => {
  const store = makeBrowserStub();
  globalThis.location = { hostname: 'nf.nexuslegacy.space', href: 'https://nf.nexuslegacy.space/' };

  await uniqueImport('../nexus-addon/server-storage.js');
  await globalThis.nexusStorage.setActiveServer('nf');
  await globalThis.browser.storage.local.set({ visible_only_nf: 'yes' });

  assert.equal(store['nexus_server:nf:visible_only_nf'], 'yes');
  assert.equal((await globalThis.browser.storage.local.get('visible_only_nf')).visible_only_nf, 'yes');
});

test('background requests honor the active NX-NF server when no explicit selection is saved', async () => {
  makeBrowserStub();
  globalThis.location = { hostname: 'example.com', href: 'https://example.com/' };

  await uniqueImport('../nexus-addon/server-storage.js');
  await delete globalThis.nexusStorage;
  await uniqueImport('../nexus-addon/server-storage.js');
  await uniqueImport('../nexus-addon/background.js');

  const queries = [];
  const messages = [];
  global.browser.tabs.query = async (query) => {
    queries.push(query);
    return [{ id: 7, url: 'https://nf.nexuslegacy.space/', active: true }];
  };
  global.browser.tabs.sendMessage = async (_tabId, payload) => {
    messages.push(payload);
    return { ok: true, data: { planets: [] } };
  };

  const listener = global.browser.runtime.onMessage.listeners[0];
  assert.ok(listener, 'background message listener registered');
  await listener({ type: 'GET_PLANETS' }, {}, () => {});

  assert.equal(queries.at(-1).url, 'https://nf.nexuslegacy.space/*');
  assert.equal(messages[0].type, 'GAME_FETCH');
  assert.equal(messages[0].path, '/api/planets');
  assert.equal((await globalThis.nexusStorage.getActiveServer()).key, 'nf');
});

test('dashboard server selector persists the selected server', async () => {
  const calls = [];
  const selector = {
    value: 'nf',
    listeners: {},
    addEventListener(event, fn) {
      this.listeners[event] = fn;
    },
    removeEventListener() {},
  };
  globalThis.nexusStorage = {
    setActiveServer: async (key) => {
      calls.push(`store:${key}`);
      return { key };
    },
  };

  const { bindServerSelector } = await uniqueImport('../nexus-addon/server-switch.js');
  bindServerSelector(selector, {
    onChange: async (key) => {
      calls.push(`reload:${key}`);
    },
  });

  await selector.listeners.change({ target: selector });

  assert.deepEqual(calls, ['store:nf', 'reload:nf']);
});

test('background tab updates persist the active server when the game switches to NF', async () => {
  const store = makeBrowserStub();
  globalThis.location = { hostname: 'example.com', href: 'https://example.com/' };

  const listeners = [];
  global.browser.tabs = {
    onUpdated: { addListener(fn) { listeners.push(fn); } },
    onActivated: { addListener() {} },
    query: async () => [{ url: 'https://nf.nexuslegacy.space/', active: true }],
  };

  await import(`../nexus-addon/server-storage.js?ts=${Date.now()}`);
  await import(`../nexus-addon/background.js?ts=${Date.now()}`);

  const [onUpdated] = listeners;
  assert.ok(onUpdated, 'tab update listener registered');

  await onUpdated(7, { url: 'https://nf.nexuslegacy.space/' }, { id: 7, url: 'https://nf.nexuslegacy.space/', active: true });
  assert.equal(store.nexus_active_server, 'nf');
  assert.equal((await globalThis.nexusStorage.getActiveServer()).key, 'nf');
});

test('explicitly selected server wins over active-tab heuristic', async () => {
  const store = makeBrowserStub();
  globalThis.location = { hostname: 'example.com', href: 'https://example.com/' };

  await uniqueImport('../nexus-addon/server-storage.js');
  await globalThis.nexusStorage.setActiveServer('s0');
  global.browser.tabs.query = async () => [{ id: 7, url: 'https://nf.nexuslegacy.space/', active: true }];

  await globalThis.browser.storage.local.set({ foo: 's0-only' });
  assert.equal((await globalThis.nexusStorage.get('foo')).foo, 's0-only');
  assert.equal((await globalThis.nexusStorage.getActiveServer()).key, 's0');
  assert.equal(store['nexus_server:s0:foo'], 's0-only');
});

test('storage change notifications expose nexus_active_server updates', async () => {
  const store = makeBrowserStub();
  globalThis.location = { hostname: 'example.com', href: 'https://example.com/' };

  await uniqueImport('../nexus-addon/server-storage.js');
  const seen = [];
  global.browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.nexus_active_server) seen.push(changes.nexus_active_server.newValue);
  });

  await globalThis.nexusStorage.setActiveServer('nf');
  assert.deepEqual(seen, ['nf']);
  assert.equal(store.nexus_active_server, 'nf');
});

test('active-game tab detection prefers the Nexus game tab over the extension/dashboard tab', async () => {
  const store = makeBrowserStub();
  globalThis.location = { hostname: 'example.com', href: 'https://example.com/' };

  global.browser.tabs.query = async (query) => {
    if (query && query.url === '*://*.nexuslegacy.space/*') {
      return [
        { id: 1, active: false, url: 'https://s0.nexuslegacy.space/' },
        { id: 2, active: true, url: 'https://nf.nexuslegacy.space/' },
      ];
    }
    return [{ id: 99, active: true, url: 'chrome-extension://ext/dashboard.html' }];
  };

  await uniqueImport('../nexus-addon/server-storage.js');
  const server = await globalThis.nexusStorage.getActiveServer();
  assert.equal(server.key, 'nf');
  assert.equal(store.nexus_active_server, undefined);
});

test('stray unscoped legacy keys are cleaned while scoped server data is preserved', async () => {
  const store = makeBrowserStub();
  globalThis.location = { hostname: 'example.com', href: 'https://example.com/' };

  store.nexus_server_storage_v1 = 1;
  store.pirate_daily = [{ day: '2026-08-12', raids: 99 }];
  store['nexus_server:s0:pirate_daily'] = [{ day: '2026-08-12', raids: 1 }];
  store['nexus_server:nf:pirate_daily'] = [{ day: '2026-08-12', raids: 2 }];

  await uniqueImport('../nexus-addon/server-storage.js');
  await globalThis.nexusStorage.get('pirate_daily');

  assert.equal(store.pirate_daily, undefined);
  assert.deepEqual(store['nexus_server:s0:pirate_daily'], [{ day: '2026-08-12', raids: 1 }]);
  assert.deepEqual(store['nexus_server:nf:pirate_daily'], [{ day: '2026-08-12', raids: 2 }]);
});
