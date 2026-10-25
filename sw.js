/* sw.js — service worker: cache app shell + ไลบรารี CDN เพื่อให้เปิดแอปได้แม้ไม่มีเน็ต
 * (ภาพ tile ดาวเทียมยังต้องต่อเน็ต — ข้อมูลแปลงทั้งหมดอยู่ในเครื่องบันทึก/อ่านได้ต่อ)
 */
const VERSION = 'palmsplan-v2';
const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './js/geo.js', './js/grid.js', './js/storage.js', './js/io.js',
  './js/state.js', './js/mapui.js', './js/app.js',
  './icons/icon-192.png', './icons/icon-512.png'
];
const RUNTIME = [
  /^https:\/\/fonts\.googleapis\.com\//,
  /^https:\/\/fonts\.gstatic\.com\//,
  /^https:\/\/unpkg\.com\/leaflet@/
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  // navigate หน้าเว็บ: network-first (รับเวอร์ชันใหม่เสมอ) → offline ใช้ shell จาก cache
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put('./index.html', copy); }).catch(function () {});
        return res;
      }).catch(function () { return caches.match('./index.html'); })
    );
    return;
  }

  var local = url.origin === self.location.origin;
  var runtime = RUNTIME.some(function (re) { return re.test(url.href); });
  if (!local && !runtime) return; // tile/nominatim: ไม่แคช (ข้อมูลไม่ถูกเก็บค้าง)

  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && (res.status < 400 || res.type === 'opaque')) {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});
