var CACHE = 'golf-shot-mapper-v4';
var ASSETS = [
  './', './index.html', './css/style.css?v=4', './js/app.js?v=4', './js/osm.js?v=4',
  './manifest.json', './icons/icon.svg',
  './vendor/leaflet/leaflet.css', './vendor/leaflet/leaflet.js',
  './vendor/leaflet/images/marker-icon.png', './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png', './vendor/leaflet/images/layers.png', './vendor/leaflet/images/layers-2x.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      var fetchPromise = fetch(e.request).then(function (res) {
        caches.open(CACHE).then(function (c) { c.put(e.request, res.clone()); });
        return res;
      }).catch(function () { return cached; });
      return cached || fetchPromise;
    })
  );
});
