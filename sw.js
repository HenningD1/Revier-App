// Service Worker: sorgt dafür, dass die App ohne Netz startet und angesehene
// Kartenkacheln offline verfügbar bleiben.
//
// Strategien:
//  * Eigene Dateien (App-Code):  Netz zuerst (max. 3 s), sonst Cache  -> Updates kommen sofort an
//  * Leaflet vom CDN:            Cache zuerst (Version ist fest in der URL)
//  * Kartenkacheln:              Cache zuerst, sonst Netz + in Cache legen (begrenzte Anzahl)
//
// Bei Änderungen am App-Code VERSION hochzählen, damit Browser das Update erkennen.

const VERSION = '0.2.0';
const SHELL_CACHE = 'shell-' + VERSION;
const CDN_CACHE = 'cdn-v1';
const TILE_CACHE = 'tiles-v1';
const TILE_MAX = 6000;           // ca. 6000 Kacheln ≈ 100–300 MB je nach Kartentyp

const SHELL_FILES = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/config.js', './js/store.js', './js/geo.js', './js/io.js',
  './js/draw.js', './js/gps.js', './js/ui.js', './js/compass.js', './js/icons.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'
];
const CDN_FILES = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];
const TILE_HOSTS = [
  'sgx.geodatenzentrum.de', 'tile.openstreetmap.org', 'tile.opentopomap.org',
  'a.tile.opentopomap.org', 'b.tile.opentopomap.org', 'c.tile.opentopomap.org', 'www.wms.nrw.de'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL_FILES);
    const cdn = await caches.open(CDN_CACHE);
    for (const url of CDN_FILES) {
      try { if (!(await cdn.match(url))) await cdn.add(url); } catch (e) { /* beim nächsten Start erneut */ }
    }
    // Beim allerersten Installieren sofort aktiv werden
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('shell-') && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', async event => {
  const msg = event.data || {};
  const reply = data => event.ports && event.ports[0] && event.ports[0].postMessage(data);
  if (msg.type === 'skip-waiting') self.skipWaiting();
  if (msg.type === 'clear-tiles') { await caches.delete(TILE_CACHE); reply({ ok: true }); }
  if (msg.type === 'tile-count') {
    const c = await caches.open(TILE_CACHE);
    reply({ count: (await c.keys()).length });
  }
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
  } else if (CDN_FILES.includes(req.url)) {
    event.respondWith(cacheFirst(req, CDN_CACHE));
  } else if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(tile(req));
  }
  // alles andere: normal übers Netz
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
    ]);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req, { ignoreSearch: true }) ||
      (req.mode === 'navigate' ? await cache.match('./index.html') : null);
    return hit || Response.error();
  }
}

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

let putsSinceTrim = 0;

async function tile(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  try {
    // Mit CORS anfragen: nur so ist die Antwort "lesbar" und wird nicht als
    // undurchsichtige (opaque) Antwort mit riesigem Platzverbrauch gespeichert.
    const res = await fetch(req.url, { mode: 'cors', credentials: 'omit' });
    if (res.ok) {
      cache.put(req.url, res.clone());
      if (++putsSinceTrim >= 100) { putsSinceTrim = 0; trim(cache); }
    }
    return res;
  } catch (e) {
    // Server ohne CORS-Freigabe oder offline: normal laden (dann ohne Cache)
    try { return await fetch(req); } catch (_) { return Response.error(); }
  }
}

async function trim(cache) {
  const keys = await cache.keys();
  const excess = keys.length - TILE_MAX;
  // älteste Einträge zuerst (Cache-Schlüssel liegen in Einfügereihenfolge vor)
  for (let i = 0; i < excess + Math.round(TILE_MAX * 0.05) && i < keys.length && excess > 0; i++) {
    await cache.delete(keys[i]);
  }
}
