// オフラインでもアプリを開けるよう、画面のファイルだけをキャッシュする。
// ファイルを更新したら VERSION を上げること。
const VERSION = 'v8';
const CACHE = `dokusho-memo-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/zxing-library-0.21.3.min.js',
  'vendor/qrcode-generator-1.4.4.js',
  'vendor/zxing-wasm-reader-3.1.4.js',
  'vendor/zxing_reader-3.1.4.wasm',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API（Apps Script）への通信や POST には関与しない
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // ネット優先、つながらなければキャッシュ
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
