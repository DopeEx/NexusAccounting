// Receives API requests from the extension background and executes them from
// the logged-in game origin. The background can inject this into an already
// open game tab when the original content script listener is missing.
(function installNexusGameApiBridge() {
  'use strict';

  const extensionApi = typeof browser !== 'undefined' ? browser : chrome;
  const runtime = extensionApi.runtime;

  function onGameFetch(msg, sender, sendResponse) {
    void sender;
    if (!msg || msg.type !== 'GAME_FETCH') return;

    fetch(msg.path, {
      method: msg.method || 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: msg.body != null ? JSON.stringify(msg.body) : undefined,
    }).then(async response => {
      const text = await response.text();
      const meta = {
        status: response.status,
        retryAfter: response.headers.get('Retry-After'),
        rateLimitRemaining: response.headers.get('RateLimit-Remaining'),
        rateLimitReset: response.headers.get('RateLimit-Reset'),
      };

      if (!response.ok) {
        let message = `${response.status}`;
        try {
          const json = JSON.parse(text);
          message = json.message || json.error || message;
        } catch {
          if (text) message = `${response.status}: ${text.slice(0, 200)}`;
        }
        sendResponse({ error: message, ...meta });
        return;
      }

      let data = {};
      try { data = JSON.parse(text); } catch { /* empty/non-JSON response */ }
      sendResponse({ ok: true, data, ...meta });
    }).catch(error => sendResponse({ error: error.message }));

    return true;
  }

  // Re-register safely on repeated injections or extension reloads.
  const previousListener = globalThis.__nexusGameApiBridgeListener;
  if (previousListener) {
    try { runtime.onMessage.removeListener(previousListener); } catch { /* old context */ }
  }
  runtime.onMessage.addListener(onGameFetch);
  globalThis.__nexusGameApiBridgeListener = onGameFetch;
})();
