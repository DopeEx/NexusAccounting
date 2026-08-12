// Server registry + browser.storage.local adapter.
//
// Nexus Accounting used to have one implicit universe (Season 0), so every
// value lived at an unprefixed storage key. The adapter keeps the existing API
// while prefixing keys with the selected universe. That prevents report ids,
// planet caches and preferences from leaking between NX-S0 and NX-NF.
(function initNexusServerStorage() {
  'use strict';

  if (globalThis.nexusStorage) return;

  const ACTIVE_SERVER_KEY = 'nexus_active_server';
  const MIGRATION_KEY = 'nexus_server_storage_v1';
  const PREFIX = 'nexus_server:';
  const SERVERS = Object.freeze({
    s0: Object.freeze({
      key: 's0',
      id: 'NX-S0',
      name: 'Season 0',
      hostname: 's0.nexuslegacy.space',
      origin: 'https://s0.nexuslegacy.space',
    }),
    nf: Object.freeze({
      key: 'nf',
      id: 'NX-NF',
      name: 'New Frontier',
      hostname: 'nf.nexuslegacy.space',
      origin: 'https://nf.nexuslegacy.space',
    }),
  });

  function normalizeServerKey(key) {
    return Object.hasOwn(SERVERS, key) ? key : 's0';
  }

  function serverKeyFromHostname(hostname) {
    const host = String(hostname || '').toLowerCase();
    return Object.values(SERVERS).find(server => server.hostname === host)?.key || null;
  }

  function serverFromUrl(url) {
    try {
      const key = serverKeyFromHostname(new URL(url).hostname);
      return key ? SERVERS[key] : null;
    } catch {
      return null;
    }
  }

  function extensionApi() {
    return globalThis.browser || globalThis.chrome;
  }

  const baseLocal = extensionApi()?.storage?.local;
  let forcedServerKey = null;

  function rawStorage() {
    const local = baseLocal || extensionApi()?.storage?.local;
    if (!local) throw new Error('browser.storage.local unavailable');
    return local;
  }

  function pageServerKey() {
    return serverKeyFromHostname(globalThis.location?.hostname);
  }

  async function tabServerKey() {
    const candidates = [];

    for (const query of [
      { url: '*://*.nexuslegacy.space/*' },
      { active: true, currentWindow: true },
      {},
    ]) {
      try {
        const tabs = await (extensionApi()?.tabs?.query?.(query) || []);
        candidates.push(...(Array.isArray(tabs) ? tabs : []));
      } catch {
        // ignore and continue; some browsers hide tab URLs unless the tabs
        // permission is granted.
      }
    }

    const gameTabs = candidates.filter(t => t?.url && t.url.includes('nexuslegacy.space'));
    const active = gameTabs.find(t => t?.active) || gameTabs[0] || null;
    if (!active?.url) return null;
    return serverFromUrl(active.url)?.key || null;
  }

  async function getActiveServerKey() {
    if (forcedServerKey) return forcedServerKey;

    const pageKey = pageServerKey();
    if (pageKey) return pageKey;

    const stored = await rawStorage().get(ACTIVE_SERVER_KEY);
    const storedKey = stored[ACTIVE_SERVER_KEY];
    if (storedKey != null) return normalizeServerKey(storedKey);

    const tabKey = await tabServerKey();
    if (tabKey) return tabKey;

    return 's0';
  }

  async function getActiveServer() {
    return SERVERS[await getActiveServerKey()];
  }

  async function setActiveServer(key) {
    if (!Object.hasOwn(SERVERS, key)) throw new Error(`Unknown Nexus Legacy server: ${key}`);
    await rawStorage().set({ [ACTIVE_SERVER_KEY]: key });
    return SERVERS[key];
  }

  async function withServer(key, run) {
    const normalized = normalizeServerKey(key);
    const prevForced = forcedServerKey;
    forcedServerKey = normalized;
    try {
      await rawStorage().set({ [ACTIVE_SERVER_KEY]: normalized });
      return await run(SERVERS[normalized]);
    } finally {
      forcedServerKey = prevForced;
    }
  }

  let migrationBrowser = null;
  let migrationPromise = null;

  function scopedKey(serverKey, key) {
    return `${PREFIX}${serverKey}:${key}`;
  }

  function isInternalKey(key) {
    return key === ACTIVE_SERVER_KEY || key === MIGRATION_KEY || key.startsWith(PREFIX);
  }

  async function ensureMigrated() {
    if (migrationBrowser !== extensionApi()) {
      migrationBrowser = extensionApi();
      migrationPromise = null;
    }
    if (migrationPromise) return migrationPromise;

    migrationPromise = (async () => {
      const local = rawStorage();
      const all = await local.get(null);
      const legacyKeys = Object.keys(all).filter(key => !isInternalKey(key));
      if (legacyKeys.length) {
        const migrated = {};
        for (const key of legacyKeys) {
          const s0Key = scopedKey('s0', key);
          const nfKey = scopedKey('nf', key);
          // Keep existing scoped values untouched. If both are missing, preserve
          // the legacy value under s0 (historic default universe).
          if (!Object.hasOwn(all, s0Key) && !Object.hasOwn(all, nfKey)) {
            migrated[s0Key] = all[key];
          }
        }
        if (Object.keys(migrated).length) await local.set(migrated);
        await local.remove(legacyKeys);
      }
      if (!all[MIGRATION_KEY]) await local.set({ [MIGRATION_KEY]: 1 });
    })();

    return migrationPromise;
  }

  async function get(keys) {
    await ensureMigrated();
    const serverKey = await getActiveServerKey();
    const prefix = scopedKey(serverKey, '');
    const local = rawStorage();

    if (keys == null) {
      const all = await local.get(null);
      const result = {};
      for (const [key, value] of Object.entries(all)) {
        if (key.startsWith(prefix)) result[key.slice(prefix.length)] = value;
      }
      return result;
    }

    const defaults = !Array.isArray(keys) && typeof keys === 'object' ? keys : null;
    const requested = typeof keys === 'string' ? [keys] : defaults ? Object.keys(defaults) : keys;
    const prefixed = requested.map(key => scopedKey(serverKey, key));
    const stored = await local.get(prefixed);
    const result = {};
    for (let i = 0; i < requested.length; i++) {
      const key = requested[i];
      const storageKey = prefixed[i];
      if (Object.hasOwn(stored, storageKey)) result[key] = stored[storageKey];
      else if (defaults && Object.hasOwn(defaults, key)) result[key] = defaults[key];
    }
    return result;
  }

  async function set(items) {
    await ensureMigrated();
    const serverKey = await getActiveServerKey();
    const scoped = {};
    for (const [key, value] of Object.entries(items)) scoped[scopedKey(serverKey, key)] = value;
    await rawStorage().set(scoped);
  }

  async function remove(keys) {
    await ensureMigrated();
    const serverKey = await getActiveServerKey();
    const list = Array.isArray(keys) ? keys : [keys];
    await rawStorage().remove(list.map(key => scopedKey(serverKey, key)));
  }

  async function clear() {
    await ensureMigrated();
    const serverKey = await getActiveServerKey();
    const prefix = scopedKey(serverKey, '');
    const all = await rawStorage().get(null);
    const keys = Object.keys(all).filter(key => key.startsWith(prefix));
    if (keys.length) await rawStorage().remove(keys);
  }

  async function exportFullStorage() {
    await ensureMigrated();
    return await (baseLocal || rawStorage()).get(null);
  }

  async function restoreFullStorage(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Storage snapshot must be an object');
    }
    await ensureMigrated();
    const local = baseLocal || rawStorage();
    await local.clear();
    if (Object.keys(data).length) await local.set(data);
  }

  async function clearAllStorage() {
    await ensureMigrated();
    await (baseLocal || rawStorage()).clear();
  }

  const listenerWrappers = new WeakMap();
  const onChanged = Object.freeze({
    addListener(listener) {
      if (listenerWrappers.has(listener)) return;
      const wrapper = (changes, area) => {
        if (area !== 'local') return;
        void (async () => {
          const serverKey = await getActiveServerKey();
          const prefix = scopedKey(serverKey, '');
          const forwarded = {};
          const scoped = {};
          for (const [key, change] of Object.entries(changes)) {
            if (key === ACTIVE_SERVER_KEY || key === MIGRATION_KEY) {
              forwarded[key] = change;
            } else if (key.startsWith(prefix)) {
              scoped[key.slice(prefix.length)] = change;
            }
          }
          if (Object.keys(forwarded).length || Object.keys(scoped).length) {
            listener({ ...forwarded, ...scoped }, area);
          }
        })();
      };
      listenerWrappers.set(listener, wrapper);
      extensionApi().storage.onChanged.addListener(wrapper);
    },
    removeListener(listener) {
      const wrapper = listenerWrappers.get(listener);
      if (!wrapper) return;
      extensionApi().storage.onChanged.removeListener(wrapper);
      listenerWrappers.delete(listener);
    },
  });

  function wrapStorageLocal() {
    return {
      get: async (keys) => {
        if (keys === null) return await get(null);
        if (typeof keys === 'string') return await get(keys);
        if (Array.isArray(keys)) return await get(keys);
        if (keys && typeof keys === 'object') return await get(keys);
        return {};
      },
      set: async (items) => {
        if (!items || typeof items !== 'object') return;
        await set(items);
      },
      remove: async (keys) => {
        await remove(keys);
      },
      clear: async () => {
        await clear();
      },
      onChanged,
    };
  }

  const app = extensionApi();
  if (app?.storage?.local) app.storage.local = wrapStorageLocal(baseLocal || app.storage.local);

  globalThis.nexusStorage = Object.freeze({
    get,
    set,
    remove,
    clear,
    exportFullStorage,
    restoreFullStorage,
    clearAllStorage,
    onChanged,
    servers: SERVERS,
    getActiveServer,
    setActiveServer,
    withServer,
    serverFromUrl,
  });

  const tabs = app?.tabs;
  if (tabs?.onUpdated?.addListener) {
    tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (!tab?.active) return;
      const key = tab?.url ? serverFromUrl(tab.url)?.key : null;
      if (!key) return;
      if (changeInfo.url || changeInfo.status === 'complete') {
        void setActiveServer(key).catch(() => {});
      }
    });
  }
  if (tabs?.onActivated?.addListener) {
    tabs.onActivated.addListener(async () => {
      try {
        const [activeTab] = await tabs.query({ active: true, currentWindow: true });
        const key = activeTab?.url ? serverFromUrl(activeTab.url)?.key : null;
        if (key) await setActiveServer(key);
      } catch {
        // Ignore invalid tab state. The page-based sync below is still enough.
      }
    });
  }

  const detected = pageServerKey();
  if (detected) void setActiveServer(detected).catch(() => {});
})();
