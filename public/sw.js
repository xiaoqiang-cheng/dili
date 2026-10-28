/* Only the public application shell is cached. API/auth/messages never enter CacheStorage. */
const BASE = new URL(self.registration.scope);
const PREFIX = `dili-shell-`;
const CACHE = `${PREFIX}v2:${BASE.pathname}`;
const shell = BASE.href;
// Hashed assets referenced by a shell document; anything else is not cached at install.
const shellAssets = html => [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => new URL(match[1], BASE))
  .filter(url => url.origin === BASE.origin && url.pathname.startsWith(`${BASE.pathname}assets/`)).map(url => url.href);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const response = await fetch(shell, { cache: 'reload' });
    if (!response.ok) throw new Error('Shell unavailable');
    await cache.addAll(shellAssets(await response.clone().text()));
    await cache.put(shell, response);
  })());
});
// Older versions of this cache for the same scope are removed once this one is active.
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key.endsWith(`:${BASE.pathname}`) && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

/** Refreshes the cached shell and the assets it references. A failure keeps the old shell. */
async function refreshShell(cache) {
  const response = await fetch(shell, { cache: 'no-store' });
  if (!response.ok || response.type !== 'basic') return response;
  const html = await response.clone().text();
  const missing = [];
  for (const asset of shellAssets(html)) if (!(await cache.match(asset))) missing.push(asset);
  // Install the new shell only once every asset it needs is cached, so an offline
  // reopen never gets a shell pointing at scripts it cannot load.
  await cache.addAll(missing);
  await cache.put(shell, response.clone());
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== BASE.origin) return;
  // The shell is the same document whatever the query (e.g. ?machineHome= from the
  // machine list); assets are only served from cache by their exact hashed path.
  const isShell = request.mode === 'navigate' && url.pathname === BASE.pathname;
  const isAsset = !url.search && url.pathname.startsWith(`${BASE.pathname}assets/`);
  if (!isShell && !isAsset) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (isShell) {
      // Open instantly from the cached shell, refresh it in the background (the page
      // offers "加载新版界面" when a new build lands). Without a cache, wait for the network.
      const cached = await cache.match(shell);
      const refreshed = refreshShell(cache);
      if (cached) { event.waitUntil(refreshed.catch(() => {})); return cached; }
      return refreshed;
    }
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
    return response;
  })());
});
