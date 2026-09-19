// 서비스 워커: 앱 껍데기를 저장해 두고, 인터넷이 되면 항상 최신 파일을 먼저 가져옴
const CACHE = 'etutor-v1';
const FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(FILES.map(f => c.add(f).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 같은 사이트 파일만 처리 (AI 호출 등 다른 주소는 건드리지 않음)
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(r, { cache: 'no-cache' })  // 브라우저 임시 저장본이 아니라 서버의 최신본 확인
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)); }
        return res;
      })
      .catch(() => caches.match(r, { ignoreSearch: true }).then(m => m || caches.match('./index.html')))
  );
});
