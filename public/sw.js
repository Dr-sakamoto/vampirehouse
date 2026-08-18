// オフライン対応のためのService Worker。
// ビルドごとに増えるハッシュ付きファイル名を事前にリストアップする代わりに、
// installの時点でindex.htmlを取得してそこから参照されているJS/CSSを読み取り、
// アプリ本体一式（アプリシェル）を先読みキャッシュしておく。
// それ以外のリソース（盤面画像など）はアクセスされた時点でランタイムキャッシュする。
const CACHE_NAME = 'vampirehouse-v2';
const APP_SHELL = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL);
      try {
        const html = await (await cache.match('./index.html')).text();
        const assetPaths = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
        await Promise.all(assetPaths.map((path) => cache.add(path).catch(() => {})));
      } catch {
        // index.htmlの解析に失敗しても、ランタイムキャッシュでフォールバックできるので致命的ではない
      }
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() =>
          caches
            .match(request, { ignoreVary: true })
            .then((cached) => cached || caches.match('./index.html', { ignoreVary: true }))
        )
    );
    return;
  }

  // <script crossorigin>タグ等はOriginヘッダー付きのリクエストになり、
  // installでの先読みキャッシュ時（Originヘッダーなし）と`Vary: Origin`が食い違ってマッチしないことがあるため、
  // Varyヘッダーは無視して同一URLならヒットさせる
  event.respondWith(
    caches.match(request, { ignoreVary: true }).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
