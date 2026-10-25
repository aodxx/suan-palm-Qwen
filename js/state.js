/* state.js — โมเดลข้อมูลกลาง (ไม่พึ่ง Leaflet): project/plots, undo-redo แบบ op{prev,next}, summary, validation
 * ทุก op เก็บข้อมูลครบสำหรับ undo() / redo() โดย dispatch เดียวกัน
 */
(function (root, factory) {
  var deps = (typeof module !== 'undefined' && module.exports)
    ? { G: require('./geo.js'), Grid: require('./grid.js') }
    : { G: root.PalmGeo, Grid: root.PalmGrid };
  var api = factory(deps.G, deps.Grid);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PalmState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (G, Grid) {
  'use strict';

  var PALETTE = ['#22c55e', '#f59e0b', '#38bdf8', '#e879f9', '#fb7185', '#a3e635', '#2dd4bf', '#c084fc'];
  var GRID_DEFAULTS = { spacing: 9, angleDeg: 0, buffer: 0, includeBorder: false, along: 0, cross: 0, originLL: null };

  var S = {
    project: null,
    selectedPlotId: null,
    dirty: false,
    listeners: [],
    undoStack: [], redoStack: [],
    _treeSeq: 1,
    _suppressUndo: false // ขณะ apply undo/redo ไม่เก็บ op ใหม่
  };

  S.on = function (fn) { S.listeners.push(fn); };
  S.emit = function (what, data) { S.listeners.forEach(function (f) { try { f(what, data, S); } catch (e) { console.error(e); } }); };

  function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  function normPlot(p) {
    if (!p.id) p.id = uid('t');
    if (!p.name) p.name = 'แปลง ' + p.id.slice(1, 5);
    if (!p.color) p.color = PALETTE[0];
    p.grid = Object.assign({}, GRID_DEFAULTS, p.grid || {});
    p.holes = p.holes || [];
    p.points = p.points || [];
    p.visible = p.visible !== false;
    p.points.forEach(function (q, i) {
      if (q.id === undefined) q.id = i + 1;
      q.manual = !!q.manual;
      S._treeSeq = Math.max(S._treeSeq, q.id + 1);
    });
    return p;
  }

  S.newProject = function (name) {
    var proj = { id: uid('p'), name: name || 'สวนปาล์มใหม่', version: 1, createdAt: Date.now(), updatedAt: 0,
      view: { lat: 9.5, lng: 99.0, zoom: 10 }, plots: [] };
    S.loadProject(proj);
    S.dirty = true; S.emit('dirty');
    return proj;
  };
  S.loadProject = function (proj) {
    S.project = proj;
    if (!proj.view) proj.view = { lat: 9.5, lng: 99.0, zoom: 10 };
    (proj.plots || []).forEach(normPlot);
    if (!proj.plots) proj.plots = [];
    S.selectedPlotId = proj.plots.length ? proj.plots[0].id : null;
    S.undoStack = []; S.redoStack = [];
    S.dirty = false;
    S.emit('project'); S.emit('plots'); S.emit('select'); S.emit('dirty');
  };

  S.plot = function (id) {
    if (!S.project) return null;
    id = id || S.selectedPlotId;
    return S.project.plots.filter(function (p) { return p.id === id; })[0] || null;
  };
  S.selected = function () { return S.plot(S.selectedPlotId); };
  S.select = function (id) { S.selectedPlotId = id; S.emit('select'); };
  S.nextColor = function () { return PALETTE[S.project.plots.length % PALETTE.length]; };

  // ---------------- undo op engine ----------------
  function record(op) {
    if (S._suppressUndo) return;
    S.undoStack.push(op);
    if (S.undoStack.length > 150) S.undoStack.shift();
    S.redoStack.length = 0;
    S.emit('undoState');
  }
  function idxOf(list, pred) { for (var i = 0; i < list.length; i++) if (pred(list[i], i)) return i; return -1; }

  var dispatch = {
    addPlot:   { undo: function (o) { var i = idxOf(S.project.plots, function (p) { return p.id === o.plotId; }); if (i >= 0) o._backup = S.project.plots.splice(i, 1)[0]; },
                 redo: function (o) { if (idxOf(o._backup ? S.project.plots : [], function (p) { return p.id === o.plotId; }) < 0) S.project.plots.push(o._backup || o.plot); } },
    delPlot:   { undo: function (o) { S.project.plots.splice(o.index, 0, o.plot); },
                 redo: function (o) { var i = idxOf(S.project.plots, function (p) { return p.id === o.plotId; }); if (i >= 0) S.project.plots.splice(i, 1); } },
    setRing:   { undo: function (o) { var p = S.plot(o.plotId); if (p) p.ring = o.prev; },
                 redo: function (o) { var p = S.plot(o.plotId); if (p) p.ring = o.next; } },
    addHole:   { undo: function (o) { var p = S.plot(o.plotId); if (p && p.holes.indexOf(o.ring) >= 0) p.holes.splice(p.holes.indexOf(o.ring), 1); },
                 redo: function (o) { var p = S.plot(o.plotId); if (p) p.holes.push(o.ring); } },
    delHole:   { undo: function (o) { var p = S.plot(o.plotId); if (p && p.holes.indexOf(o.ring) < 0) p.holes.splice(o.index, 0, o.ring); },
                 redo: function (o) { var p = S.plot(o.plotId); if (p) { var i = p.holes.indexOf(o.ring); if (i >= 0) p.holes.splice(i, 1); } } },
    addPoint:  { undo: function (o) { var p = S.plot(o.plotId); if (p) { var i = idxOf(p.points, function (q) { return q.id === o.point.id; }); if (i >= 0) p.points.splice(i, 1); } },
                 redo: function (o) { var p = S.plot(o.plotId); if (p) p.points.push(o.point); } },
    delPoint:  { undo: function (o) { var p = S.plot(o.plotId); if (p) p.points.splice(Math.min(o.index, p.points.length), 0, o.point); },
                 redo: function (o) { var p = S.plot(o.plotId); if (p) { var i = idxOf(p.points, function (q) { return q.id === o.point.id; }); if (i >= 0) p.points.splice(i, 1); } } },
    movePoint: { undo: function (o) { var p = S.plot(o.plotId); if (p) { var t = p.points.filter(function (q) { return q.id === o.pid; })[0]; if (t) { t.lat = o.from.lat; t.lng = o.from.lng; t.manual = o.wasManual; } } },
                 redo: function (o) { var p = S.plot(o.plotId); if (p) { var t = p.points.filter(function (q) { return q.id === o.pid; })[0]; if (t) { t.lat = o.to.lat; t.lng = o.to.lng; t.manual = true; } } } },
    setPoints: { undo: function (o) { var p = S.plot(o.plotId); if (p) p.points = o.prev; },
                 redo: function (o) { var p = S.plot(o.plotId); if (p) p.points = o.next; } },
    editPlot:  { undo: function (o) { applyEdit(o.plotId, o.prev); }, redo: function (o) { applyEdit(o.plotId, o.next); } }
  };
  function applyEdit(plotId, snap) {
    var p = S.plot(plotId); if (!p || !snap) return;
    p.name = snap.name; p.ring = snap.ring; p.holes = snap.holes;
  }

  function applyDir(op, dir) {
    var d = dispatch[op.type];
    if (!d) { console.warn('unknown op', op.type); return; }
    d[dir](op);
    S.markDirty();
    S.emit('plots'); S.emit('plotGeom', { plotId: op.plotId });
    S.emit('points', { plotId: op.plotId || op.plot && op.plot.id });
  }
  S.undo = function () {
    var op = S.undoStack.pop(); if (!op) return null;
    S._suppressUndo = true; applyDir(op, 'undo'); S._suppressUndo = false;
    S.redoStack.push(op); S.emit('undoState');
    return op;
  };
  S.redo = function () {
    var op = S.redoStack.pop(); if (!op) return null;
    S._suppressUndo = true; applyDir(op, 'redo'); S._suppressUndo = false;
    S.undoStack.push(op); S.emit('undoState');
    return op;
  };

  // ---------------- mutations (forward ops — record undo data) ----------------
  function pointSnap(q) { return { lat: q.lat, lng: q.lng, id: q.id, manual: q.manual }; }

  S.addPlot = function (ring, name) {
    var p = normPlot({ id: uid('t'), name: name, ring: ring, color: S.nextColor(), points: [], holes: [] });
    S.project.plots.push(p);
    record({ type: 'addPlot', plotId: p.id, _backup: p });
    S.selectedPlotId = p.id;
    S.markDirty(); S.emit('plots'); S.emit('select');
    return p;
  };
  S.removePlot = function (id) {
    var i = idxOf(S.project.plots, function (p) { return p.id === id; });
    if (i < 0) return;
    var p = S.project.plots.splice(i, 1)[0];
    record({ type: 'delPlot', plotId: id, index: i, plot: p });
    if (S.selectedPlotId === id) S.selectedPlotId = S.project.plots.length ? S.project.plots[0].id : null;
    S.markDirty(); S.emit('plots'); S.emit('select');
  };
  S.renamePlot = function (id, name) {
    var p = S.plot(id); if (!p || p.name === name) return;
    record({ type: 'editPlot', plotId: id, prev: { name: p.name, ring: p.ring, holes: p.holes }, next: { name: name, ring: p.ring, holes: p.holes } });
    p.name = name; S.markDirty(); S.emit('plots');
  };
  S.copyPlot = function (id) {
    var src = S.plot(id); if (!src) return;
    var cp = normPlot(JSON.parse(JSON.stringify(src)));
    cp.id = uid('t'); cp.name = src.name + ' (คัดลอก)'; cp.color = S.nextColor();
    var dLat = 0.0004;
    cp.ring = cp.ring.map(function (pt) { return [pt[0] + dLat, pt[1]]; });
    cp.holes = cp.holes.map(function (r) { return r.map(function (pt) { return [pt[0] + dLat, pt[1]]; }); });
    cp.points.forEach(function (q) { q.lat += dLat; q.id = S._treeSeq++; });
    if (cp.grid.originLL) cp.grid.originLL = [cp.grid.originLL[0] + dLat, cp.grid.originLL[1]];
    S.project.plots.push(cp);
    record({ type: 'addPlot', plotId: cp.id, _backup: cp });
    S.selectedPlotId = cp.id;
    S.markDirty(); S.emit('plots'); S.emit('select');
    return cp;
  };
  S.setRing = function (plotId, ring) {
    var p = S.plot(plotId); if (!p) return;
    record({ type: 'setRing', plotId: p.id, prev: p.ring, next: ring });
    p.ring = ring;
    S.markDirty(); S.emit('plotGeom', { plotId: p.id }); S.emit('plots');
  };
  S.addHole = function (plotId, ring) {
    var p = S.plot(plotId); if (!p) return;
    record({ type: 'addHole', plotId: p.id, ring: ring });
    p.holes.push(ring);
    S.markDirty(); S.emit('plotGeom', { plotId: p.id }); S.emit('plots');
  };
  S.delHole = function (plotId, ring) {
    var p = S.plot(plotId); if (!p) return;
    var i = p.holes.indexOf(ring); if (i < 0) return;
    record({ type: 'delHole', plotId: p.id, ring: ring, index: i });
    p.holes.splice(i, 1);
    S.markDirty(); S.emit('plotGeom', { plotId: p.id }); S.emit('plots');
  };

  S.addPoint = function (plotId, lat, lng, manual) {
    var p = S.plot(plotId); if (!p) return null;
    var pt = { lat: lat, lng: lng, id: S._treeSeq++, manual: !!manual };
    p.points.push(pt);
    record({ type: 'addPoint', plotId: p.id, point: pt });
    S.markDirty(); S.emit('points', { plotId: p.id });
    return pt;
  };
  S.removePoint = function (plotId, pid) {
    var p = S.plot(plotId); if (!p) return;
    var i = idxOf(p.points, function (q) { return q.id === pid; });
    if (i < 0) return;
    var pt = p.points[i];
    record({ type: 'delPoint', plotId: p.id, index: i, point: pt });
    p.points.splice(i, 1);
    S.markDirty(); S.emit('points', { plotId: p.id });
  };
  S.movePoint = function (plotId, pid, lat, lng) {
    var p = S.plot(plotId); if (!p) return;
    var t = p.points.filter(function (q) { return q.id === pid; })[0]; if (!t) return;
    record({ type: 'movePoint', plotId: p.id, pid: pid, from: { lat: t.lat, lng: t.lng }, wasManual: t.manual,
      to: { lat: lat, lng: lng } });
    t.lat = lat; t.lng = lng; t.manual = true;
    S.markDirty(); S.emit('points', { plotId: p.id });
  };
  /** เขียนจุดทั้งชุด (grid regen / clearPoints) — เก็บ undo อัตโนมัติ */
  S.setPoints = function (plotId, nextArr) {
    var p = S.plot(plotId); if (!p) return;
    record({ type: 'setPoints', plotId: p.id, prev: p.points, next: nextArr.map(pointSnap) });
    p.points = nextArr.map(function (q) { return { lat: q.lat, lng: q.lng, id: q.id || S._treeSeq++, manual: !!q.manual }; });
    S.markDirty(); S.emit('points', { plotId: p.id });
  };
  S.updateGrid = function (plotId, patch) {
    var p = S.plot(plotId); if (!p) return;
    Object.keys(patch).forEach(function (k) { p.grid[k] = patch[k]; });
    S.markDirty(); S.emit('settings', { plotId: p.id });
  };

  S.canUndo = function () { return S.undoStack.length > 0; };
  S.canRedo = function () { return S.redoStack.length > 0; };

  // ---------------- validation & summary ----------------
  S.validatePlot = function (plotId) {
    var p = S.plot(plotId);
    if (!p) return [];
    if (!p._violDirty && p._viol) return p._viol;
    if (p.points.length < 2) { p._viol = []; p._violDirty = false; return p._viol; }
    var c = G.centroid(p.ring);
    var proj = G.makeProjection(c.lat, c.lng);
    var xy = p.points.map(function (q) { return proj.toXY(q.lat, q.lng); });
    var v = Grid.findViolations(xy, p.grid.spacing);
    var list = Object.keys(v).map(function (i) { return { pid: p.points[i].id, dist: v[i] }; });
    p._viol = list; p._violDirty = false;
    return list;
  };
  S.invalidateAll = function () { (S.project ? S.project.plots : []).forEach(function (p) { p._violDirty = true; }); };

  S.summary = function () {
    var pr = S.project; if (!pr) return null;
    var o = { plotCount: pr.plots.length, totalSqM: 0, plantSqM: 0, trees: 0, manual: 0, violations: 0, violByPlot: {} };
    pr.plots.forEach(function (p) {
      o.totalSqM += G.polygonAreaSqM([p.ring]);
      o.plantSqM += G.polygonAreaSqM([p.ring].concat(p.holes || []));
      o.trees += p.points.length;
      p.points.forEach(function (q) { if (q.manual) o.manual++; });
      var vl = S.validatePlot(p.id);
      o.violByPlot[p.id] = vl; o.violations += vl.length;
    });
    return o;
  };

  S.markDirty = function () {
    S.dirty = true;
    S.invalidateAll();
    S.emit('dirty');
  };

  return S;
});
