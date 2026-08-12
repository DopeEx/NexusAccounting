// Service-worker entry. Static imports only (Chrome MV3 forbids top-level await
// in service workers), evaluated in order: the polyfill defines `browser.*`
// before the server-aware storage shim and background.js run. Firefox provides
// `browser` natively; the polyfill is a no-op there.
import './browser-polyfill.js';
import './server-storage.js';
import './background.js';
