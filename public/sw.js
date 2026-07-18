/*
 * Gabarit du service worker CADENCE.
 * `npm run build` remplace les deux marqueurs ci-dessous avec la révision du
 * build et la liste exhaustive des fichiers réellement émis dans `dist/`.
 */
const CACHE_PREFIX = 'cadence-';
const BUILD_REVISION = '__CADENCE_BUILD_REVISION__';
const CACHE_NAME = `${CACHE_PREFIX}precache-${BUILD_REVISION}`;
const PRECACHE_ENTRIES = /* __CADENCE_PRECACHE_ENTRIES__ */ [];
const PRECACHE_URLS = PRECACHE_ENTRIES.map(({ url }) => url);

const SCOPE_URL = self.registration.scope;
const SCOPE_PATH = new URL(SCOPE_URL).pathname;
const APP_SHELL_URL = new URL('./index.html', SCOPE_URL).href;

function isCacheable(response) {
  return response && response.ok && (response.type === 'basic' || response.type === 'default');
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const requests = PRECACHE_URLS.map((url) => new Request(new URL(url, SCOPE_URL), { cache: 'reload' }));
    await cache.addAll(requests);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const obsolete = keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME);
    await Promise.all(obsolete.map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) await cache.put(APP_SHELL_URL, response.clone());
    return response;
  } catch (error) {
    return (await cache.match(APP_SHELL_URL))
      || (await cache.match(request, { ignoreSearch: true }))
      || Response.error();
  }
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (isCacheable(response)) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (error) { return; }
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE_PATH)) return;

  event.respondWith(request.mode === 'navigate'
    ? networkFirstNavigation(request)
    : cacheFirstAsset(request));
});
