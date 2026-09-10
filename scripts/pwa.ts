import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

// Precache the complete UI, including the lazily loaded Canvas. Never cache API
// responses here: authenticated workspace data belongs to the actor-scoped replica.
export function pwa(): Plugin {
  return {
    name: 'mem-brane-pwa',
    apply: 'build',
    generateBundle(_, bundle) {
      const files = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];
      const hash = createHash('sha256');
      for (const file of files.filter((file) => file !== '/'))
        hash.update(readFileSync(`public${file}`));
      for (const [name, item] of Object.entries(bundle)) {
        files.push(`/${name}`);
        hash.update(item.type === 'chunk' ? item.code : item.source);
      }
      const version = hash.digest('hex').slice(0, 16);
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: `const CACHE = 'mem-brane-shell-${version}';
const FILES = ${JSON.stringify(files)};
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
});
// A new version waits until all old app windows close. Never force a reload
// while another window may be typing or committing a local transaction.
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('mem-brane-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/health') return;
  if (event.request.mode === 'navigate') {
    event.respondWith(caches.open(CACHE).then(cache => cache.match('/')).then(cached => cached || fetch(event.request)));
  } else if (FILES.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(url.pathname)).then(cached => cached || fetch(event.request)));
  }
});`,
      });
    },
  };
}
