/* mapui.js — ชั้นแผนที่ Leaflet: layers, แปลง, จุดปลูก, เครื่องมือวาด/แก้ไข/วัด
 * ทุก function ทำงานจริงกับ state (PalmState) — ไม่มีปุ่มจำลอง
 */
(function (root) {
  'use strict';
  if (typeof L === 'undefined') { console.error('Leaflet ยังไม่โหลด'); return; }
  var G = root.PalmGeo, Grid = root.PalmGrid, S = root.PalmState;

  var M = {};
  var map, canvasRenderer;
  var plotLayer, treeLayer, drawLayer, handleLayer, measureLayer, originLayer;
  var tileErrorCount = 0;
  M.onTileError = null; // callback ให้ app.js แสดง banner

  var LAYERS = {
    sat: null, road: null, active: 'sat'
  };

  // ============ INIT ============
  M.init = function (el) {
    map = new L.Map(el, { zoomControl: false, attributionControl: true, tap: true, minZoom: 3, maxZoom: 20 });
    canvasRenderer = L.canvas({ padding: 0.5, tolerance: 6 });
    LAYERS.sat = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'ภาพถ่ายดาวเทียม &copy; Esri, Maxar, Earthstar Geographics' });
    LAYERS.road = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' });
    LAYERS.sat.addTo(map);

    plotLayer = L.layerGroup().addTo(map);
    drawLayer = L.layerGroup().addTo(map);
    handleLayer = L.layerGroup().addTo(map);
    originLayer = L.layerGroup();
    treeLayer = L.layerGroup({ renderer: canvasRenderer }).addTo(map);
    measureLayer = L.layerGroup().addTo(map);

    LAYERS.sat.on('tileerror', function () { tileErrorCount++; if (tileErrorCount === 3 && M.onTileError) M.onTileError(); });
    LAYERS.sat.on('tileload', function () { if (tileErrorCount > 0) tileErrorCount = 0; });

    map.on('moveend zoomend', function () {
      if (S.project) { S.project.view = { lat: map.getCenter().lat, lng: map.getCenter().lng, zoom: map.getZoom() }; }
    });
    return map;
  };
  M.map = function () { return map; };
  M.center = function () { var c = map.getCenter(); return [c.lat, c.lng]; };
  M.setView = function (ll, z) { map.setView(ll, z == null ? map.getZoom() : z); };

  M.toggleLayer = function () {
    if (LAYERS.active === 'sat') { map.removeLayer(LAYERS.sat); LAYERS.road.addTo(map); LAYERS.active = 'road'; }
    else { map.removeLayer(LAYERS.road); LAYERS.sat.addTo(map); LAYERS.active = 'sat'; }
    return LAYERS.active;
  };

  // ============ RENDER แปลง + ต้น ============
  var plotShapes = {}; // plotId → {poly, label, trees:[{marker, pid}]}

  function ringToLatLngs(ring) { return ring.map(function (pt) { return [pt[0], pt[1]]; }); }

  M.refreshPlot = function (plotId, onlyPoints) {
    var p = S.plot(plotId); if (!p) { M.removePlotShape(plotId); return; }
    var sh = plotShapes[plotId];

    if (!onlyPoints && sh) { sh.poly.setLatLngs(plotLatLngs(p)); }
    if (!sh || !onlyPoints && !plotShapes[plotId]) { M.removePlotShape(plotId); sh = buildShape(p); }

    // trees
    sh.trees.forEach(function (t) { treeLayer.removeLayer(t.marker); });
    sh.trees = [];
    var violByPid = {};
    S.validatePlot(p.id).forEach(function (v) { violByPid[v.pid] = v.dist; });
    var selectedTree = M.selectedTreeId && M.selectedTreePlot === p.id ? M.selectedTreeId : null;
    p.points.forEach(function (q, i) {
      var isViol = violByPid[q.id] !== undefined;
      var isSel = q.id === selectedTree;
      var m = L.circleMarker([q.lat, q.lng], {
        renderer: canvasRenderer,
        radius: isSel ? 7 : (isViol ? 5.5 : 4),
        color: isSel ? '#1d4ed8' : (isViol ? '#7f1d1d' : '#14532d'),
        weight: isSel || isViol ? 2.2 : 1,
        fillColor: isSel ? '#3b82f6' : (isViol ? '#dc2626' : (q.manual ? '#2563eb' : '#22c55e')),
        fillOpacity: 0.95, className: 'tree-m'
      });
      m.__pid = q.id; m.__plotId = p.id; m.__ll = [q.lat, q.lng];
      m.on('click', function (e) {
        var app = root.PalmApp;
        var tl = app ? app.tool : 'select';
        // consume เฉพาะโหมดจัดการต้นตรงตัว; ที่เหลือปล่อย bubbling ให้ map hub
        var consume = (tl === 'select' || tl === 'delTree' || (tl === 'moveTree' && app.moveArmed && !app.moveArmed()));
        if (!consume) return; // addTree, pickOrigin, moveTree(armed), ขณะวาด → raw latlng ถึง map
        if (M.onTreeClick) {
          L.DomEvent.stopPropagation(e);
          M.onTreeClick(p.id, q.id, [q.lat, q.lng]);
        }
      });
      m.bindTooltip('ต้น #' + (i + 1) + (q.manual ? ' (ปรับมือ)' : '') +
        (isViol ? '<br><b style="color:#fecaca">ห่างต้นข้างเคียง ' + violByPid[q.id].toFixed(2) + ' ม. < ' + p.grid.spacing + ' ม.</b>' : ''),
        { direction: 'top', className: 'edge-label' });
      treeLayer.addLayer(m);
      sh.trees.push({ marker: m, pid: q.id });
    });
    refreshAreaLabel(p, sh);
  };
  function plotLatLngs(p) {
    var arr = [ringToLatLngs(p.ring)];
    p.holes.forEach(function (h) { arr.push(ringToLatLngs(h)); });
    return arr;
  }
  function buildShape(p) {
    var poly = L.polygon(plotLatLngs(p), {
      color: p.color, weight: 2.5, opacity: p.visible ? 1 : 0,
      fillColor: p.color, fillOpacity: 0.13, interactive: true, className: 'plot-poly'
    });
    poly.__plotId = p.id;
    poly.on('click', function (e) {
      var app = root.PalmApp;
      var tl = app ? app.tool : 'select';
      //single source of truth: โหมดชี้ตำแหน่ง/ขณะวาด → bubbling ขึ้น map hub (latlng ดิบ)
      if (['addTree', 'pickOrigin', 'moveTree'].indexOf(tl) >= 0) return;
      if (app && app.isDrawingPt && app.isDrawingPt()) return;
      if (M.onMapPolyClick) M.onMapPolyClick(p.id, [e.latlng.lat, e.latlng.lng], e);
    });
    plotLayer.addLayer(poly);
    var sh = { poly: poly, trees: [], label: null };
    plotShapes[p.id] = sh;
    return sh;
  }
  function refreshAreaLabel(p, sh) {
    if (sh.label) { plotLayer.removeLayer(sh.label); sh.label = null; }
    if (!p.visible) return;
    var areaM = G.polygonAreaSqM([p.ring]);
    var plantM = G.polygonAreaSqM([p.ring].concat(p.holes || []));
    var c = L.polygon(plantLatLngsForCentroid(p)).getBounds().getCenter();
    sh.label = L.marker(c, {
      interactive: false, icon: L.divIcon({ className: 'area-label',
        html: G.formatThaiArea(areaM) + '<small>ปลูกได้ ' + G.formatThaiArea(plantM) + ' · ' + G.fmtInt(p.points.length) + ' ต้น</small>' })
    });
    plotLayer.addLayer(sh.label);
  }
  function plantLatLngsForCentroid(p) {
    var pts = p.ring.filter(function (pt, i, arr) {
      var n = arr[(i + 1) % arr.length];
      return !(pt[0] === n[0] && pt[1] === n[1]);
    });
    return pts.map(function (q) { return [q[0], q[1]]; });
  }
  M.removePlotShape = function (plotId) {
    var sh = plotShapes[plotId]; if (!sh) return;
    plotLayer.removeLayer(sh.poly);
    if (sh.label) plotLayer.removeLayer(sh.label);
    sh.trees.forEach(function (t) { treeLayer.removeLayer(t.marker); });
    delete plotShapes[plotId];
  };
  M.refreshAll = function () {
    plotLayer.clearLayers(); treeLayer.clearLayers(); drawLayer.clearLayers(); handleLayer.clearLayers();
    Object.keys(plotShapes).forEach(function (k) { delete plotShapes[k]; });
    (S.project ? S.project.plots : []).forEach(function (p) { M.refreshPlot(p.id); setPlotVis(p.id, p.visible !== false); });
    M.refreshSelection();
  };
  function setPlotVis(plotId, vis) {
    var sh = plotShapes[plotId]; if (!sh) return;
    sh.poly.setStyle({ opacity: vis ? 1 : 0, fillOpacity: vis ? 0.13 : 0 });
    if (sh.label) { if (vis && !plotLayer.hasLayer(sh.label)) plotLayer.addLayer(sh.label); else if (!vis) plotLayer.removeLayer(sh.label); }
    sh.trees.forEach(function (t) { if (vis) { if (!treeLayer.hasLayer(t.marker)) treeLayer.addLayer(t.marker); } else treeLayer.removeLayer(t.marker); });
  }
  M.setPlotVisible = function (plotId, vis) {
    var p = S.plot(plotId); if (p) p.visible = vis;
    setPlotVis(plotId, vis); markSel(plotId);
  };

  // selection ring (เส้นหนาขึ้น + พุ่งชื่อ)
  var selTag = null;
  function markSel(plotId) {
    Object.keys(plotShapes).forEach(function (id) {
      var p = S.plot(id); if (!p) return;
      plotShapes[id].poly.setStyle({ weight: id === plotId ? 4 : 2.5, color: id === plotId ? '#f97316' : p.color });
    });
    if (selTag) { plotLayer.removeLayer(selTag); selTag = null; }
    var p = S.plot(plotId);
    if (p && p.visible) {
      var c = L.polygon(plantLatLngsForCentroid(p)).getBounds().getNorthWest();
      selTag = L.marker(c, { interactive: false, icon: L.divIcon({ className: 'plot-name-tag', html: p.name }) });
      plotLayer.addLayer(selTag);
    }
  }
  M.refreshSelection = function () { if (S.selectedPlotId) markSel(S.selectedPlotId); };

  M.fitPlot = function (plotId) {
    var p = S.plot(plotId); if (!p) return;
    map.fitBounds(L.polygon(plantLatLngsForCentroid(p)).getBounds(), { padding: [40, 40] });
  };
  M.fitAll = function () {
    var any = (S.project && S.project.plots.length) || plotLayer.getLayers().length;
    var b = null;
    (S.project ? S.project.plots : []).forEach(function (p) {
      var pb = L.polygon(plantLatLngsForCentroid(p)).getBounds();
      b = b ? b.extend(pb) : pb;
    });
    if (b) map.fitBounds(b, { padding: [50, 50] }); else map.setView([9.5, 99.0], 6);
  };

  // ============ DRAW POLYGON (วาดแปลง / hole) ============
  var draw = null; // {mode:'plot'|'hole', pts:[], live:layer refs}
  M.isDrawing = function () { return !!draw; };
  M.startDraw = function (mode) {
    M.cancelDraw();
    draw = { mode: mode, pts: [] };
    drawLayer.clearLayers();
    draw.shape = L.polygon([[]], { color: '#f97316', weight: 2, dashArray: '6 4', fillOpacity: 0.06 }).addTo(drawLayer);
    draw.line = L.polyline([], { color: '#f97316', weight: 2, dashArray: '6 4' }).addTo(drawLayer);
    draw.labels = L.layerGroup().addTo(drawLayer);
    if (mode === 'hole') draw.shape.setStyle({ color: '#dc2626', dashArray: '4 4' });
    map.getContainer().classList.add('drawing');
    map.on('click', onDrawClick);
    map.on('mousemove', onDrawMove);
  };
  function vertexIcon(n) { return L.divIcon({ className: 'vertex-badge', html: String(n + 1), iconSize: [22, 22], iconAnchor: [11, 11] }); }
  function onDrawClick(e) {
    draw.pts.push([e.latlng.lat, e.latlng.lng]);
    L.marker(e.latlng, { icon: vertexIcon(draw.pts.length - 1), interactive: false }).addTo(draw.labels);
    redrawDraw();
  }
  function onDrawMove(e) {
    if (!draw || !draw.pts.length) return;
    draw.shape.setLatLngs([ringWithCurrent(e.latlng)]);
    draw.line.setLatLngs(draw.pts.map(function (p) { return [p[0], p[1]]; }).concat([[e.latlng.lat, e.latlng.lng]]));
    edgeLabels(e.latlng);
  }
  function ringWithCurrent(ll) {
    return draw.pts.map(function (p) { return [p[0], p[1]]; }).concat([[ll.lat, ll.lng]]);
  }
  function edgeLabels(curLL) {
    draw.labels.eachLayer(function (l) { if (l.__edge) draw.labels.removeLayer(l); });
    var pts = ringWithCurrent(curLL).concat([ringWithCurrent(curLL)[0]]);
    for (var i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1];
      var mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      var d = G.distanceM(a, b);
      var m = L.marker(mid, { interactive: false, icon: L.divIcon({ className: 'edge-label', html: d.toFixed(2) + ' ม.' }) });
      m.__edge = true; m.addTo(draw.labels);
    }
  }
  function redrawDraw() {
    if (draw.pts.length >= 2) draw.line.setLatLngs(draw.pts.map(function (p) { return [p[0], p[1]]; }));
    if (draw.pts.length >= 3) draw.shape.setLatLngs(draw.pts.concat([draw.pts[0]]).map(function (p) { return [p[0], p[1]]; }));
  }
  M.drawCount = function () { return draw ? draw.pts.length : 0 };
  M.undoVertex = function () {
    if (!draw || !draw.pts.length) return false;
    draw.pts.pop();
    rebuildBeads();
    redrawDraw();
    return true;
  };
  function rebuildBeads() {
    draw.labels.eachLayer(function (l) { if (!l.__edge) draw.labels.removeLayer(l); });
    draw.pts.forEach(function (p, i) {
      L.marker([p[0], p[1]], { icon: vertexIcon(i), interactive: false }).addTo(draw.labels);
    });
  }
  M.finishDraw = function () {
    if (!draw || draw.pts.length < 3) return null;
    var ring = draw.pts.slice();
    // ปิด ring (ตัดจุดซ้ำ)
    var issues = G.validateRing(ring);
    var res = { mode: draw.mode, ring: ring, issues: issues };
    M.cancelDraw();
    return res;
  };
  M.cancelDraw = function () {
    if (!draw) return;
    map.off('click', onDrawClick); map.off('mousemove', onDrawMove);
    map.getContainer().classList.remove('drawing');
    draw = null;
    drawLayer.clearLayers();
  };

  // ============ EDIT VERTICES (แก้ไขขอบเขตแปลง/holes) ============
  var editHandles = [];
  M.enterVertexEdit = function (plotId) {
    M.exitVertexEdit();
    var p = S.plot(plotId); if (!p) return;
    function makeHandles(ring, isHole, hIdx) {
      ring.forEach(function (pt, i) {
        var h = L.marker([pt[0], pt[1]], {
          draggable: true, icon: L.divIcon({ className: 'vertex-handle' + (isHole ? ' hole-h' : ''), iconSize: [16, 16], iconAnchor: [8, 8] })
        });
        h.__ring = ring; h.__i = i;
        h.__hole = isHole;
        h.on('drag', function () {
          var ll = h.getLatLng(); ring[i] = [ll.lat, ll.lng];
          M.onRingLive({ plotId: plotId });
        });
        h.on('dragend', function () {
          var ll = h.getLatLng();
          ring[i] = [ll.lat, ll.lng];
          if (isHole) M.onHoleChanged(plotId);
          else M.onRingCommit(plotId, ring.slice());
        });
        editHandles.push(h); h.addTo(handleLayer);
      });
    }
    makeHandles(p.ring, false, -1);
    p.holes.forEach(function (hRing, hi) { makeHandles(hRing, true, hi); });
    M.selectedTreeId = null;
  };
  M.exitVertexEdit = function () {
    handleLayer.clearLayers(); editHandles = [];
  };
  M.onRingCommit = null; M.onRingLive = null; M.onHoleChanged = null; // app.js ต่อ

  // เพิ่ม vertex: double-click บนเส้น
  M.enableEdgeInsert = function (plotId) {
    var sh = plotShapes[plotId]; if (!sh) return;
    sh.poly.on('dblclick', onDblInsert);
    function onDblInsert(e) {
      var p = S.plot(plotId); if (!p) return;
      var ll = e.latlng;
      // หา edge ที่ใกล้ที่สุด
      var best = null;
      var ring = p.ring;
      var proj = G.makeProjection(ll.lat, ll.lng);
      for (var i = 0; i < ring.length; i++) {
        var a = ring[i], b = ring[(i + 1) % ring.length];
        var pa = proj.toXY(a[0], a[1]), pb = proj.toXY(b[0], b[1]), pt = { x: 0, y: 0 };
        var d = G.distPointSeg(pt, pa, pb);
        if (!best || d < best.d) best = { i: i, d: d };
      }
      if (best && best.d < 300) {
        var nr = p.ring.slice();
        nr.splice(best.i + 1, 0, [ll.lat, ll.lng]);
        M.exitVertexEdit();
        if (M.onRingCommit) M.onRingCommit(plotId, nr);
      }
    }
  };

  // ============ GRID ORIGIN PICKER ============
  M.showOriginHandle = function (plotId, ll) {
    originLayer.clearLayers();
    if (!ll) { if (map.hasLayer(originLayer)) map.removeLayer(originLayer); return; }
    var h = L.marker(ll, {
      draggable: true, icon: L.divIcon({ className: 'vertex-handle origin-handle', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 900
    });
    h.bindTooltip('จุดเริ่ม Grid — ลากเพื่อย้าย', { direction: 'top', className: 'edge-label' });
    h.on('dragend', function () {
      var L2 = h.getLatLng();
      if (M.onOriginMoved) M.onOriginMoved(plotId, [L2.lat, L2.lng]);
    });
    originLayer.addLayer(h); originLayer.addTo(map);
  };
  M.onOriginMoved = null;

  // ============ MEASURE TOOLS ============
  var measure = null; // {type:'dist'|'area', pts, live}
  M.startMeasure = function (type) {
    M.stopMeasure();
    measure = { type: type, pts: [] };
    var line = L.polyline([], { color: '#0ea5e9', weight: 3, dashArray: type === 'area' ? '' : '5 5' }).addTo(measureLayer);
    measure.line = line;
    measure.shape = type === 'area' ? L.polygon([[]], { color: '#0ea5e9', fillOpacity: 0.08, dashArray: '4 4' }).addTo(measureLayer) : null;
    measure.labels = L.layerGroup().addTo(measureLayer);
    map.on('click', onMeasureClick);
    map.getContainer().classList.add('drawing');
    updateModeHint();
    return measure;
  };
  function onMeasureClick(e) {
    if (!measure) return;
    measure.pts.push([e.latlng.lat, e.latlng.lng]);
    L.circleMarker(e.latlng, { radius: 4, color: '#0ea5e9', fillOpacity: 1, weight: 0 }).addTo(measure.labels);
    var latlngs = measure.pts.map(function (p) { return [p[0], p[1]]; });
    measure.line.setLatLngs(measure.type === 'area' ? latlngs.concat([latlngs[0]]) : latlngs);
    if (measure.shape && latlngs.length >= 3) measure.shape.setLatLngs(latlngs);
    var info;
    if (measure.type === 'dist') {
      var tot = 0;
      for (var i = 0; i < measure.pts.length - 1; i++) tot += G.distanceM(measure.pts[i], measure.pts[i + 1]);
      info = 'ระยะรวม ' + tot.toFixed(2) + ' ม.';
    } else {
      info = measure.pts.length >= 3 ? 'พื้นที่ ' + G.formatThaiArea(G.polygonAreaSqM([measure.pts])) : '';
    }
    measure.labels.eachLayer(function (l) { if (l.__info) measure.labels.removeLayer(l); });
    if (info) {
      var last = measure.pts[measure.pts.length - 1];
      var t = L.marker(last, { interactive: false, icon: L.divIcon({ className: 'edge-label', html: info }) });
      t.__info = true; t.addTo(measure.labels);
    }
  }
  M.stopMeasure = function () {
    map.off('click', onMeasureClick);
    map.getContainer().classList.remove('drawing');
    measure = null;
    updateModeHint();
  };
  M.clearMeasure = function () { M.stopMeasure(); measureLayer.clearLayers(); };
  function updateModeHint() {
    if (!M.onHint) return;
    if (!measure) M.onHint(null);
    else M.onHint(measure.type === 'dist' ? 'แตะจุดบนแผนที่เพื่อวัดระยะ · กด “เสร็จ” เพื่อจบ' : 'แตะจุดมุมเป็นลำดับ · กด “เสร็จ” เพื่อจบการวัดพื้นที่');
  }
  M.finishMeasure = function () { M.stopMeasure(); };
  M.isMeasureActive = function () { return !!measure; };

  root.PalmMapUI = M;
})(window);
