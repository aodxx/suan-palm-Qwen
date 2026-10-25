/* io.js — นำเข้า/ส่งออก: JSON สำรอง, GeoJSON, CSV, วางข้อความพิกัด
 * ทุก function ตรวจสอบข้อมูลก่อนใช้ และไม่แก้ข้อมูลเดิมหากนำเข้าผิด
 */
(function (root, factory) {
  var deps = (typeof module !== 'undefined' && module.exports)
    ? { G: require('./geo.js') } : { G: root.PalmGeo };
  var api = factory(deps.G);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PalmIO = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (G) {
  'use strict';

  var SCHEMA_VERSION = 1;

  function download(filename, text, mime) {
    var blob = new Blob(['\ufeff' + text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function readFileText(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).replace(/^\ufeff/, '')); };
      r.onerror = function () { reject(new Error('อ่านไฟล์ไม่สำเร็จ')); };
      r.readAsText(file, 'utf-8');
    });
  }

  // ---------- ตรวจโครงสร้างโครงการ ----------
  function isLL(a) { return Array.isArray(a) && a.length === 2 && isNum(a[0]) && isNum(a[1]) && Math.abs(a[0]) <= 90 && Math.abs(a[1]) <= 180; }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  function isRing(a) { return Array.isArray(a) && a.length >= 3 && a.every(isLL); }

  function validateProject(obj) {
    var errs = [];
    if (!obj || typeof obj !== 'object') return ['โครงสร้างข้อมูลไม่ถูกต้อง (ไม่ใช่ object)'];
    if (typeof obj.name !== 'string' || !obj.name) errs.push('ไม่มีชื่อโครงการ');
    if (!Array.isArray(obj.plots)) errs.push('ไม่มีรายการแปลง (plots)');
    (obj.plots || []).forEach(function (p, i) {
      var tag = 'แปลง#' + (i + 1) + (p && p.name ? ' "' + p.name + '"' : '');
      if (!p || !isRing(p.ring)) errs.push(tag + ': ขอบแปลงไม่ถูกต้อง (ต้องเป็น array ของ [lat,lng] ≥ 3 จุด)');
      if (p && p.holes && !Array.isArray(p.holes)) errs.push(tag + ': holes ต้องเป็น array');
      if (p && p.holes) p.holes.forEach(function (h, j) { if (!isRing(h)) errs.push(tag + ': พื้นที่เว้นปลูก#' + (j + 1) + ' ไม่ถูกต้อง'); });
      if (p && p.points) {
        var bad = 0;
        p.points.forEach(function (q) { if (!isLL([q.lat, q.lng])) bad++; });
        if (bad) errs.push(tag + ': จุดปลูก ' + bad + ' จุดไม่ถูกต้อง');
      }
    });
    return errs;
  }

  function normalizeProject(obj) {
    var now = Date.now();
    if (!obj.id) obj.id = 'p' + now.toString(36) + Math.random().toString(36).slice(2, 8);
    obj.version = SCHEMA_VERSION;
    if (!obj.createdAt) obj.createdAt = now;
    obj.plots.forEach(function (p) {
      if (!p.id) p.id = 't' + Math.random().toString(36).slice(2, 9);
      if (!p.name) p.name = 'แปลง ' + p.id.slice(1, 5);
      if (!p.grid) p.grid = {};
      p.grid.spacing = isNum(p.grid.spacing) ? p.grid.spacing : 9;
      p.grid.angleDeg = isNum(p.grid.angleDeg) ? p.grid.angleDeg : 0;
      p.grid.buffer = isNum(p.grid.buffer) ? p.grid.buffer : 0;
      p.holes = p.holes || [];
      p.points = p.points || [];
      p.points.forEach(function (q, idx) { if (q.id === undefined) q.id = idx + 1; q.manual = !!q.manual; });
    });
    return obj;
  }

  // ---------- JSON ----------
  function exportProjectJSON(project) {
    return JSON.stringify({ version: SCHEMA_VERSION, exportedAt: new Date().toISOString(), project: project }, null, 2);
  }
  function importProjectJSON(text) {
    var obj;
    try { obj = JSON.parse(text); } catch (e) { throw new Error('ไฟล์ JSON เสีย: ' + e.message); }
    var proj = obj.project || obj; // รองรับทั้ง {project:{...}} และตรง ๆ
    var errs = validateProject(proj);
    if (errs.length) throw new Error('ไฟล์ไม่ผ่านตรวจ: ' + errs.slice(0, 5).join(' | '));
    return normalizeProject(proj);
  }

  // ---------- GeoJSON ----------
  function ringLatLngToGeo(ring) { return ring.map(function (p) { return [p[1], p[0]]; }); } // → [lng,lat]
  function ringGeoToLatLng(coords) { return coords.map(function (p) { return [Number(p[1]), Number(p[0])]; }); }

  function exportGeoJSON(project) {
    var feats = [];
    (project.plots || []).forEach(function (p) {
      var rings = [ringLatLngToGeo(p.ring)].concat((p.holes || []).map(ringLatLngToGeo));
      feats.push({
        type: 'Feature',
        properties: { plot_id: p.id, plot_name: p.name, kind: 'plot',
          area_m2: Math.round(G.polygonAreaSqM([p.ring].concat(p.holes || [])) * 100) / 100 },
        geometry: { type: 'Polygon', coordinates: rings }
      });
      (p.points || []).forEach(function (q, i) {
        feats.push({
          type: 'Feature',
          properties: { plot_id: p.id, plot_name: p.name, kind: 'tree', tree_no: q.id || (i + 1), manual: !!q.manual },
          geometry: { type: 'Point', coordinates: [Number(q.lng), Number(q.lat)] }
        });
      });
    });
    return JSON.stringify({ type: 'FeatureCollection', name: project.name, crs: 'WGS84', features: feats }, null, 2);
  }
  function importGeoJSON(text) {
    var obj;
    try { obj = JSON.parse(text); } catch (e) { throw new Error('ไฟล์ GeoJSON เสีย: ' + e.message); }
    if (!obj || obj.type !== 'FeatureCollection' || !Array.isArray(obj.features)) {
      if (obj && obj.type === 'Feature') obj = { type: 'FeatureCollection', features: [obj] };
      else if (obj && obj.type && obj.coordinates) obj = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: obj }] };
      else throw new Error('ไม่พบ FeatureCollection ในไฟล์');
    }
    var plots = [], points = [];
    obj.features.forEach(function (f) {
      if (!f || !f.geometry) return;
      var g = f.geometry, pr = f.properties || {};
      if (g.type === 'Polygon' && Array.isArray(g.coordinates) && g.coordinates.length) {
        plots.push({ name: pr.plot_name || pr.name || ('แปลงจาก GeoJSON ' + (plots.length + 1)),
          ring: ringGeoToLatLng(g.coordinates[0]),
          holes: g.coordinates.slice(1).map(ringGeoToLatLng) });
      } else if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) {
        g.coordinates.forEach(function (poly) {
          plots.push({ name: (pr.plot_name || 'แปลง') + ' ' + (plots.length + 1), ring: ringGeoToLatLng(poly[0]), holes: poly.slice(1).map(ringGeoToLatLng) });
        });
      } else if (g.type === 'Point' && Array.isArray(g.coordinates)) {
        var lat = Number(g.coordinates[1]), lng = Number(g.coordinates[0]);
        if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
          points.push({ lat: lat, lng: lng, plotName: pr.plot_name || '' });
        }
      }
    });
    if (!plots.length && !points.length) throw new Error('ไม่พบ Polygon/Point ที่ใช้ได้ในไฟล์');
    return { plots: plots, points: points };
  }

  // ---------- CSV ----------
  // export รายการจุดปลูก: plot_name,point_id,latitude,longitude
  function exportPointsCSV(project) {
    var lines = ['plot_name,point_id,latitude,longitude'];
    (project.plots || []).forEach(function (p) {
      (p.points || []).forEach(function (q, i) {
        lines.push([csvCell(p.name), q.id || (i + 1), Number(q.lat).toFixed(8), Number(q.lng).toFixed(8)].join(','));
      });
    });
    return lines.join('\n');
  }
  function csvCell(s) { s = String(s == null ? '' : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

  function parseCSVRows(text) {
    var rows = [], row = [], cell = '', inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
        else cell += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c === '\r') { /* skip */ }
      else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.length && !(r.length === 1 && !r[0].trim()); });
  }

  // นำเข้า CSV: ต้องมีหัวคอลัมน์ lat/latitude + lng/lon/longitude (point_id, plot_name เทใจถ้ามี)
  function importPointsCSV(text) {
    var rows = parseCSVRows(text);
    if (!rows.length) throw new Error('ไฟล์ว่างเปล่า');
    var head = rows[0].map(function (h) { return h.trim().toLowerCase(); });
    var iLat = head.indexOf('latitude') >= 0 ? head.indexOf('latitude') : head.indexOf('lat');
    var iLng = head.indexOf('longitude') >= 0 ? head.indexOf('longitude') : (head.indexOf('lng') >= 0 ? head.indexOf('lng') : head.indexOf('lon'));
    var iName = head.indexOf('plot_name') >= 0 ? head.indexOf('plot_name') : head.indexOf('plot');
    var iPid = head.indexOf('point_id') >= 0 ? head.indexOf('point_id') : head.indexOf('id');
    if (iLat < 0 || iLng < 0) throw new Error('ไม่พบคอลัมน์ latitude/longitude ในหัวตาราง (ต้องมี: plot_name,point_id,latitude,longitude)');
    var out = [], errors = [];
    for (var r = 1; r < rows.length; r++) {
      var lat = parseFloat(rows[r][iLat]), lng = parseFloat(rows[r][iLng]);
      if (!isFinite(lat) || !isFinite(lng)) { errors.push('แถว ' + (r + 1) + ': ค่าไม่ใช่ตัวเลข'); continue; }
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) { errors.push('แถว ' + (r + 1) + ': พิกัดอยู่นอกช่วง (' + lat + ', ' + lng + ') — อาจสลับ lat/lng'); continue; }
      out.push({ lat: lat, lng: lng, plotName: iName >= 0 ? (rows[r][iName] || '').trim() : '', pointId: iPid >= 0 ? (rows[r][iPid] || '') : '' });
    }
    if (!out.length) throw new Error('ไม่พบแถวข้อมูลที่ถูกต้อง' + (errors.length ? ': ' + errors[0] : ''));
    return { points: out, errors: errors };
  }

  // ---------- วางข้อความพิกัด ("14.123,100.456" ต่อไลน์, คั่น , หรือ เว้นวรรค หรือ tab) ----------
  function parsePastedCoords(text) {
    var lines = String(text).split(/\r?\n/);
    var out = [], errors = [];
    lines.forEach(function (ln, i) {
      ln = ln.trim();
      if (!ln || ln.indexOf('#') === 0) return;
      var t = ln.split(/[\s,;\t]+/).filter(Boolean);
      if (t.length < 2) { errors.push('บรรทัด ' + (i + 1) + ': มีค่าน้อยกว่า 2'); return; }
      var a = parseFloat(t[0]), b = parseFloat(t[1]);
      if (!isFinite(a) || !isFinite(b)) { errors.push('บรรทัด ' + (i + 1) + ': ไม่ใช่ตัวเลข'); return; }
      var lat, lng;
      if (Math.abs(a) <= 90 && Math.abs(b) <= 180 && Math.abs(b) > 90) { lat = a; lng = b; }          // lat,lng ชัดเจน
      else if (Math.abs(b) <= 90 && Math.abs(a) <= 180 && Math.abs(a) > 90) { lat = b; lng = a; }      // lng,lat สลับกัน
      else if (Math.abs(a) <= 90 && Math.abs(b) <= 90) { lat = a; lng = b; }                           // ช่วงไทย: lat<90, lng 98-106 → จัดตามลำดับ
      else { errors.push('บรรทัด ' + (i + 1) + ': พิกัดอยู่นอกช่วง'); return; }
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) { errors.push('บรรทัด ' + (i + 1) + ': พิกัดไม่ถูกต้อง'); return; }
      out.push({ lat: lat, lng: lng, label: t.slice(2).join(' ') });
    });
    if (!out.length) throw new Error('ไม่พบพิกัดที่ถูกต้อง' + (errors.length ? ' —ตัวอย่าง: ' + errors[0] : ''));
    return { points: out, errors: errors };
  }

  // ---------- สรุปผล ----------
  function exportSummaryCSV(project, calc) {
    var lines = ['รายการ,ค่า'];
    lines.push('ชื่อโครงการ,' + csvCell(project.name));
    var totalArea = 0, totalPlant = 0, totalTrees = 0, totalViol = 0, totalManual = 0;
    project.plots.forEach(function (p) {
      totalArea += G.polygonAreaSqM([p.ring].concat(p.holes || []));
      var plant = G.polygonAreaSqM([p.ring].concat(p.holes || [])); // พื้นที่ปลูกได้ (ลบ holes แล้ว)
      totalPlant += plant; totalTrees += (p.points || []).length;
      totalManual += (p.points || []).filter(function (q) { return q.manual; }).length;
    });
    var n = 1;
    project.plots.forEach(function (p) {
      lines.push('แปลง ' + (n++) + ' (' + csvCell(p.name) + '),พื้นที่ ' + G.formatThaiArea(G.polygonAreaSqM([p.ring])) + ',จำนวนต้น ' + (p.points || []).length + ',ระยะปลูก ' + p.grid.spacing + ' ม.,มุมแถว ' + p.grid.angleDeg + '°');
    });
    lines.push('รวม,' + G.formatThaiArea(totalArea) + ',จำนวนต้นรวม ' + totalTrees);
    return lines.join('\n');
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    download: download, readFileText: readFileText,
    validateProject: validateProject, normalizeProject: normalizeProject,
    exportProjectJSON: exportProjectJSON, importProjectJSON: importProjectJSON,
    exportGeoJSON: exportGeoJSON, importGeoJSON: importGeoJSON,
    exportPointsCSV: exportPointsCSV, importPointsCSV: importPointsCSV,
    parsePastedCoords: parsePastedCoords, exportSummaryCSV: exportSummaryCSV,
    parseCSVRows: parseCSVRows
  };
});
