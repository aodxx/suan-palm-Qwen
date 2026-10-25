/* geo.js — คำนวณภูมิศาสตร์ (projection เมตร, พื้นที่ geodesic, หน่วยไทย)
 * ใช้งานทั้งในเบราว์เซอร์ (global PalmGeo) และ Node (module.exports) สำหรับทดสอบ
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PalmGeo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var R = 6371008.8; // รัศมีเฉลี่ยโลก (m) — ใช้สำหรับ haversine
  var D2R = Math.PI / 180;
  var WGS_A = 6378137.0, WGS_E2 = 0.00669437999014; // WGS84

  // ---- การแปลงละติจูด/ลองจิจูด → ระนาบเมตรเฉพาะที่ (WGS84 M/N rigorous พอสำหรับแปลงไร–พันไร) ----
  function metersPerDegLat(latDeg) {
    var f = latDeg * D2R, s2 = Math.sin(f) * Math.sin(f);
    var M = WGS_A * (1 - WGS_E2) / Math.pow(1 - WGS_E2 * s2, 1.5);
    return M * D2R;
  }
  function metersPerDegLon(latDeg) {
    var f = latDeg * D2R, s2 = Math.sin(f) * Math.sin(f);
    var N = WGS_A / Math.sqrt(1 - WGS_E2 * s2);
    return N * Math.cos(f) * D2R;
  }

  // สร้าง proj object: toXY(lat,lng)->{x,y(m)} / toLL(x,y)->{lat,lng}
  function makeProjection(lat0, lng0) {
    var mLat = metersPerDegLat(lat0);
    var mLon = metersPerDegLon(lat0);
    return {
      lat0: lat0, lng0: lng0,
      toXY: function (lat, lng) { return { x: (lng - lng0) * mLon, y: (lat - lat0) * mLat }; },
      toLL: function (x, y) { return { lat: lat0 + y / mLat, lng: lng0 + x / mLon }; }
    };
  }
  function centroid(ring) {
    var s = 0, t = 0;
    for (var i = 0; i < ring.length; i++) { s += ring[i][0]; t += ring[i][1]; }
    return { lat: s / ring.length, lng: t / ring.length };
  }

  // ---- ระยะทาง (haversine) ----
  function distanceM(a, b) {
    var f1 = a[0] * D2R, f2 = b[0] * D2R, df = (b[0] - a[0]) * D2R, dl = (b[1] - a[1]) * D2R;
    var h = Math.sin(df / 2) * Math.sin(df / 2) + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // ---- พื้นที่ polygon บนทรงกลม (สูตรผลรวมละติจูด-ลองจิจูด / spherical excess แบบที่ใช้ใน turf.area) ----
  function ringAreaGeodesic(ring) {
    if (ring.length < 3) return 0;
    var total = 0;
    for (var i = 0; i < ring.length; i++) {
      var p1 = ring[i], p2 = ring[(i + 1) % ring.length];
      total += (p2[1] - p1[1]) * D2R *
        (2 + Math.sin(p1[0] * D2R) + Math.sin(p2[0] * D2R));
    }
    return Math.abs(total * R * R / 2.0);
  }
  // พื้นที่รวม = ring นอก - holes โดยคำนวณบนระนาบเมตรเฉพาะที่ (consistent กับระยะปลูก/grid)
  function polygonAreaSqM(rings) {
    if (!rings || !rings.length || !rings[0] || rings[0].length < 3) return 0;
    var c = centroid(rings[0]);
    var proj = makeProjection(c.lat, c.lng);
    function planar(r) {
      var pts = r.map(function (p) { return proj.toXY(p[0], p[1]); });
      return Math.abs(signedAreaXY(pts));
    }
    var a = planar(rings[0]);
    for (var i = 1; i < rings.length; i++) a -= planar(rings[i]);
    return Math.max(0, a);
  }

  // ---- shoelace บนระนาบเมตร (ตรวจความสม่ำเสมอของรูปทรง) ----
  function signedAreaXY(pts) {
    var s = 0;
    for (var i = 0; i < pts.length; i++) {
      var p1 = pts[i], p2 = pts[(i + 1) % pts.length];
      s += p1.x * p2.y - p2.x * p1.y;
    }
    return s / 2;
  }

  // ---- ray casting point-in-ring (ระนาบเมตร) ----
  function pointInRingXY(pt, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i].x, yi = ring[i].y, xj = ring[j].x, yj = ring[j].y;
      if (((yi > pt.y) !== (yj > pt.y)) &&
        (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  // ringsXY = [outer, hole1, ...] จุดต้องอยู่ใน outer และไม่อยู่ใน hole ใด ๆ
  function pointInPolyXY(pt, ringsXY) {
    if (!pointInRingXY(pt, ringsXY[0])) return false;
    for (var i = 1; i < ringsXY.length; i++) {
      if (pointInRingXY(pt, ringsXY[i])) return false;
    }
    return true;
  }
  // ขอบ inclusive: อยู่บนเส้นขอบถือว่า "ใน" เมื่อ includeBorder=true (สำหรับ hole ยังกันไว้ตามเดิม)
  function pointInPolyXYOpt(pt, ringsXY, includeBorder) {
    function onRingEps(p, ring, eps) {
      for (var i = 0; i < ring.length; i++) {
        if (distPointSeg(p, ring[i], ring[(i + 1) % ring.length]) < eps) return true;
      }
      return false;
    }
    if (!includeBorder) return pointInPolyXY(pt, ringsXY);
    var eps = 1e-6;
    if (!(pointInRingXY(pt, ringsXY[0]) || onRingEps(pt, ringsXY[0], eps))) return false;
    for (var i = 1; i < ringsXY.length; i++) {
      if (pointInRingXY(pt, ringsXY[i])) return false;
    }
    return true;
  }

  // ---- ระยะจากจุดถึง segment / ถึง ring ----
  function distPointSeg(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var len2 = dx * dx + dy * dy;
    var t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    var cx = a.x + t * dx, cy = a.y + t * dy;
    return Math.hypot(p.x - cx, p.y - cy);
  }
  function distToRingXY(p, ring) {
    var min = Infinity;
    for (var i = 0; i < ring.length; i++) {
      var d = distPointSeg(p, ring[i], ring[(i + 1) % ring.length]);
      if (d < min) min = d;
    }
    return min;
  }

  // ---- check polygon ง่าย ๆ ก่อนคำนวณ (_SELF_INTERSECT / few points / tiny area) ----
  function validateRing(ring) {
    var issues = [];
    if (!ring || ring.length < 3) { issues.push('POLY_TOO_FEW_POINTS'); return issues; }
    // normalise: ตัดจุดปิดที่ซ้ำจุดแรก (ถ้ามี) แล้วตรวจทุก edge แบบ modulo
    var pts = ring.map(function (p) { return p.slice ? p : [p.lat, p.lng]; });
    var n = pts.length;
    if (n > 1 && pts[0][0] === pts[n - 1][0] && pts[0][1] === pts[n - 1][1]) pts = pts.slice(0, n - 1);
    n = pts.length;
    if (n < 3) { issues.push('POLY_TOO_FEW_POINTS'); return issues; }
    simple: for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        if (j === i + 1 || (i === 0 && j === n - 1)) continue; // ข้าม edge ที่ชนกัน
        if (segIntersect(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) { issues.push('POLY_SELF_INTERSECT'); break simple; }
      }
    }
    var crossSum = 0;
    for (var k = 0; k < n; k++) {
      var a = pts[k], b = pts[(k + 1) % n], c = pts[(k + 2) % n];
      var cr = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
      crossSum += Math.abs(cr) < 1e-9 ? 1 : 0;
    }
    if (crossSum / n > 0.6) issues.push('POLY_DEGENERATE');
    return issues;
  }
  function ccw(a, b, c) { return (c[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (c[0] - a[0]); }
  function segIntersect(a, b, c, d) {
    return ccw(a, c, d) * ccw(b, c, d) < 0 && ccw(a, b, c) * ccw(a, b, d) < 0;
  }

  // ---- หน่วยพื้นที่ไทย: 1 ไร่ = 1,600 ตร.ม. | 1 งาน = 400 | 1 ตร.ว. = 4 ----
  // แปลง ตร.ม. → { rai, ngan, sqW } (ตร.ว. อาจทศนิยม 1 ตำแหน่ง, ไม่ปัดเศษเกินจำเป็น)
  function toThaiArea(sqm) {
    var sqW = sqm / 4; // ตารางวาทั้งหมด
    var rai = Math.floor(sqW / 400);
    var rem = sqW - rai * 400;
    var ngan = Math.floor(rem / 100);
    var wa = rem - ngan * 100;
    wa = Math.round(wa * 10) / 10;
    if (wa >= 100) { ngan += 1; wa -= 100; }
    if (ngan >= 4) { rai += 1; ngan -= 4; }
    return { rai: rai, ngan: ngan, sqW: wa, sqm: sqm };
  }
  function formatThaiArea(sqm) {
    var t = toThaiArea(sqm);
    var parts = [];
    function waStr(v) { return (Math.round(v * 10) % 10 === 0) ? fmtInt(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1); }
    if (t.rai) parts.push(fmtInt(t.rai) + ' ไร่');
    if (t.ngan) parts.push(fmtInt(t.ngan) + ' งาน');
    if (t.sqW > 0 || !parts.length) parts.push(waStr(t.sqW) + ' ตร.ว.');
    return parts.join(' ');
  }
  function fmtInt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  // รูปแบบกระชับสำหรับชิปสรุป: 56.6 ไร่
  function formatRaiCompact(sqm) {
    var r = sqm / 1600;
    if (r >= 100) return fmtInt(Math.round(r)) + ' ไร่';
    return (Math.round(r * 10) / 10).toFixed(1) + ' ไร่';
  }

  function bbox(rings) {
    var minLa = 90, maxLa = -90, minLo = 180, maxLo = -180;
    rings[0].forEach(function (p) {
      if (p[0] < minLa) minLa = p[0]; if (p[0] > maxLa) maxLa = p[0];
      if (p[1] < minLo) minLo = p[1]; if (p[1] > maxLo) maxLo = p[1];
    });
    return [minLa, minLo, maxLa, maxLo];
  }

  return {
    R: R, D2R: D2R,
    makeProjection: makeProjection, centroid: centroid,
    metersPerDegLat: metersPerDegLat, metersPerDegLon: metersPerDegLon,
    distanceM: distanceM,
    ringAreaGeodesic: ringAreaGeodesic, polygonAreaSqM: polygonAreaSqM,
    signedAreaXY: signedAreaXY,
    pointInRingXY: pointInRingXY, pointInPolyXY: pointInPolyXY, pointInPolyXYOpt: pointInPolyXYOpt,
    distPointSeg: distPointSeg, distToRingXY: distToRingXY,
    validateRing: validateRing,
    toThaiArea: toThaiArea, formatThaiArea: formatThaiArea, formatRaiCompact: formatRaiCompact, fmtInt: fmtInt,
    bbox: bbox
  };
});
