/* storage.js — เก็บโครงการใน IndexedDB (fallback → localStorage เมื่อ IndexedDB ใช้ไม่ได้)
 * schema: DB "palm-planner" v1, store "projects" keyPath "id"
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PalmStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DB_NAME = 'palm-planner', STORE = 'projects', VER = 1;
  var db = null, useIDB = true;

  function open() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') { useIDB = false; return resolve(null); }
      var req = indexedDB.open(DB_NAME, VER);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(STORE)) {
          var st = d.createObjectStore(STORE, { keyPath: 'id' });
          st.createIndex('updatedAt', 'updatedAt');
        }
      };
      req.onsuccess = function () { db = req.result; resolve(db); };
      req.onerror = function () { useIDB = false; resolve(null); }; // fallback เงียบ ๆ
    });
  }

  function tx(mode, fn) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(STORE, mode);
      var st = t.objectStore(STORE);
      var r = fn(st);
      t.oncomplete = function () { resolve(r && r.result); };
      t.onerror = t.onabort = function () { reject(t.error || new Error('IDB error')); };
    });
  }

  // ---- localStorage fallback helpers ----
  function lsKey(id) { return 'palm-project:' + id; }
  function lsList() {
    var out = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf('palm-project:') === 0) {
        try { out.push(JSON.parse(localStorage.getItem(k))); } catch (e) { }
      }
    }
    return out;
  }

  function put(project) {
    project.updatedAt = Date.now();
    if (useIDB && db) return tx('readwrite', function (st) { return st.put(project); }).then(function () { return project; });
    localStorage.setItem(lsKey(project.id), JSON.stringify(project));
    return Promise.resolve(project);
  }
  function get(id) {
    if (useIDB && db) return new Promise(function (resolve, reject) {
      var t = db.transaction(STORE, 'readonly');
      var r = t.objectStore(STORE).get(id);
      r.onsuccess = function () { resolve(r.result || null); };
      r.onerror = function () { reject(r.error); };
    });
    var raw = localStorage.getItem(lsKey(id));
    return Promise.resolve(raw ? JSON.parse(raw) : null);
  }
  function list() {
    if (useIDB && db) return new Promise(function (resolve, reject) {
      var t = db.transaction(STORE, 'readonly');
      var r = t.objectStore(STORE).getAll();
      r.onsuccess = function () {
        var arr = r.result || [];
        arr.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
        resolve(arr.map(function (p) {
          return { id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, plotCount: (p.plots || []).length };
        }));
      };
      r.onerror = function () { reject(r.error); };
    });
    return Promise.resolve(lsList().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }).map(function (p) {
      return { id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, plotCount: (p.plots || []).length };
    }));
  }
  function remove(id) {
    if (useIDB && db) return tx('readwrite', function (st) { return st.delete(id); });
    localStorage.removeItem(lsKey(id));
    return Promise.resolve();
  }

  function uid() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  return { open: open, put: put, get: get, list: list, remove: remove, uid: uid,
    backend: function () { return (useIDB && db) ? 'IndexedDB' : 'localStorage'; } };
});
