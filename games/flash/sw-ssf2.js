/**
 * Kente's Korner — SSF2 Asset Service Worker
 *
 * Two-level cache strategy:
 *   L1 → SW Cache API  (in-browser, fast, session-persistent)
 *   L2 → kente-server disk cache  (games/flash/ssf2-cache/, cross-session)
 *
 * Flow for every McLeod request Ruffle makes:
 *   1. Check SW Cache API → hit → return immediately (fully offline)
 *   2. Miss → fetch via localhost:7777/api/flash/proxy (saves to disk + returns)
 *   3. Store proxy response in SW Cache API for next time
 *   4. Fallback → direct McLeod fetch if proxy is unreachable
 */

const CACHE_NAME        = 'kente-ssf2-assets-v1';
const PROXY_BASE        = 'http://localhost:7777/api/flash/proxy?url=';
const MCLEOD_HOSTS      = new Set([
  'www.supersmashflash.com', 'supersmashflash.com',
  'www.mcleodgaming.com',    'mcleodgaming.com',
]);

function isMcLeod(url) {
  try { return MCLEOD_HOSTS.has(new URL(url).hostname); }
  catch { return false; }
}

function broadcast(msg) {
  self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
    .then(clients => clients.forEach(c => c.postMessage(msg)));
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
self.addEventListener('install',  ()  => self.skipWaiting());
self.addEventListener('activate', evt => evt.waitUntil(self.clients.claim()));

// ── Fetch interception ───────────────────────────────────────────────────────
self.addEventListener('fetch', evt => {
  const url = evt.request.url;
  if (!isMcLeod(url)) return;   // pass through non-McLeod requests

  evt.respondWith(handleMcLeod(url, evt.request));
});

async function handleMcLeod(url, request) {
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(url);

  // ── L1 hit: SW cache ────────────────────────────────────────────────────
  if (cached) {
    broadcast({ type: 'hit', url });
    return cached;
  }

  // ── L2: fetch via kente-server proxy (writes to disk) ───────────────────
  try {
    const proxyResp = await fetch(PROXY_BASE + encodeURIComponent(url), {
      credentials: 'omit',
    });

    if (proxyResp.ok) {
      // Promote to L1 (keyed by original McLeod URL so future Ruffle
      // requests for that URL get the SW-cached copy directly)
      await cache.put(url, proxyResp.clone());
      broadcast({ type: 'fetched', url });
      return proxyResp;
    }
    // Proxy returned an error — fall through to direct fetch
  } catch (_proxyErr) {
    // kente-server not running — fall through to direct fetch
  }

  // ── Fallback: direct McLeod fetch (online-only) ─────────────────────────
  try {
    const direct = await fetch(request);
    if (direct.ok) {
      await cache.put(url, direct.clone());
      broadcast({ type: 'fetched-direct', url });
    }
    return direct;
  } catch (err) {
    broadcast({ type: 'error', url, msg: String(err) });
    return new Response('Asset unavailable offline', { status: 503 });
  }
}

// ── Message handler (commands from the page) ─────────────────────────────────
self.addEventListener('message', async evt => {
  if (evt.data?.type === 'get-stats') {
    const cache  = await caches.open(CACHE_NAME);
    const keys   = await cache.keys();
    evt.source.postMessage({ type: 'stats', count: keys.length });
  }
  if (evt.data?.type === 'clear-cache') {
    await caches.delete(CACHE_NAME);
    broadcast({ type: 'cache-cleared' });
  }
});

