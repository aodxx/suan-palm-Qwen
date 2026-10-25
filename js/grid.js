/* grid.js — สร้างจุดปลูกสามเหลี่ยมด้านเท่า (staggered triangular grid) ในระนาบเมตร
 * - ระยะระหว่างต้นในแถว = s
 * - ระยะระหว่างแถว = s * sqrt(3) / 2  (≈ 7.7942286 m เมื่อ s = 9)
 * - แถวคี่เลื่อนแนวตั้งฉากครึ่งระยะ (4.5 m เมื่อ s = 9) → ทุกข้างของสามเหลี่ยมยาวเท่ากัน
 * - ห้ามคำนวณด้วยองศาละติจูด/ลองจิจูดโดยตรง → แปลงเป็นเมตรก่อนเสมอ (geo.makeProjection)
 */
(function (root, factory) {
  var deps = (typeof module !== 'undefined' && module.exports)
    ? require('./geo.js') : root.PalmGeo;
  var api = factory(deps);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PalmGrid = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (G) {
  'use strict';

  var SQRT3_2 = Math.sqrt(3) / 2; // 0.8660254...,  9*0.8660254 = 7.7942286 m

  function rowGap(spacing) { return spacing * SQRT3_2; }

  /**
   * opts = {
   *   rings: [[ [lat,lng], ...outer ], [ ...hole1 ], ...]   (อย่างน้อย 1 ring)
   *   spacing: number (เมตร, ระยะระหว่างต้น)
   *   angleDeg: number   ทิศแนวแถวแบบมุมเข็มทิศ (0° = เหนือ→ใต้ตามแกน y ของจอ, ทวนนาฬิกาเป็นบวก)
   *   originLL: [lat,lng] จุดอ้างอิงเริ่ม grid (ถ้าไม่มีใช้มุม bbox)
   *   along: number  เลื่อน grid ตามแนวแถว (ม.)
   *   cross: number  เลื่อน grid ตั้งฉากแนวแถว (ม.)
   *   buffer: number ระยะเว้นจากขอบแปลง (ม.) — ใช้กับขอบนอกและขอบด้านในของพื้นที่เว้นปลูก
   *   includeBorder: boolean  จุดบนขอบนับว่า valid
   *   maxPoints: number จำกัดจำนวนจุด (ป้องกันค้าง)
   * }
   * คืน { points: [{lat,lng}], tried, rowGap, spacing, error? }
   */
  function generate(opts) {
    var rings = opts.rings;
    if (!rings || !rings.length || rings[0].length < 3) return { points: [], tried: 0, error: 'NO_POLYGON' };
    var s = Number(opts.spacing) > 0 ? Number(opts.spacing) : 9;
    var angle = (Number(opts.angleDeg) || 0) * Math.PI / 180; // bearing ของแนวแถว
    var buffer = Math.max(0, Number(opts.buffer) || 0);
    var includeBorder = !!opts.includeBorder;
    var maxPoints = opts.maxPoints || 60000;

    // projected rings (เมตร) — origin ที่ centroid ของ ring นอก
    var c = G.centroid(rings[0]);
    var proj = G.makeProjection(c.lat, c.lng);
    var ringsXY = rings.map(function (r) {
      return r.map(function (p) { return proj.toXY(p[0], p[1]); });
    });

    // แกน u = ตามแนวแถว (bearing), v = ตั้งฉาก
    var sa = Math.sin(angle), ca = Math.cos(angle);
    function toUV(x, y) { return { u: x * sa + y * ca, v: x * ca - y * sa }; }
    function fromUV(u, v) { return { x: u * sa + v * ca, y: u * ca - v * sa }; }

    // origin ของ grid ในแกน uv
    var oUV = { u: 0, v: 0 };
    if (opts.originLL) {
      var o = proj.toXY(opts.originLL[0], opts.originLL[1]);
      oUV = toUV(o.x, o.y);
    }

    // bbox ของ outer ring ใน uv
    var uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    ringsXY[0].forEach(function (p) {
      var q = toUV(p.x, p.y);
      if (q.u < uMin) uMin = q.u; if (q.u > uMax) uMax = q.u;
      if (q.v < vMin) vMin = q.v; if (q.v > vMax) vMax = q.v;
    });

    var rowH = rowGap(s);
    var startU = oUV.u + (Number(opts.along) || 0);
    var startV = oUV.v + (Number(opts.cross) || 0);
    // จัดให้แถวแรกไม่เลย bbox โดยคงเฟสเดิม (ไม่เปลี่ยนระยะห่าง)
    var kFirst = Math.floor((vMin - startV) / rowH) - 1;
    var kLast = Math.ceil((vMax - startV) / rowH) + 1;
    var iFirst = Math.floor((uMin - startU) / s) - 2;

    var points = [], tried = 0;

    for (var k = kFirst; k <= kLast; k++) {
      var v = startV + k * rowH;
      // แถวสลับฟันปลา: แถวคี่เลื่อนไปครึ่งระยะ
      var uOff = (k & 1) ? s / 2 : 0;
      var i0 = iFirst + ((k & 1) ? 0 : 0);
      for (var i = i0; ; i++) {
        var u = startU + uOff + i * s;
        if (u > uMax + s) break;
        tried++;
        var xy = fromUV(u, v);
        var pt = { x: xy.x, y: xy.y };
        if (G.pointInPolyXYOpt(pt, ringsXY, includeBorder)) {
          var ok = true;
          if (buffer > 0) {
            // เว้นจากขอบนอกและขอบ hole
            if (G.distToRingXY(pt, ringsXY[0]) < buffer - 1e-9) ok = false;
            for (var h = 1; h < ringsXY.length && ok; h++) {
              if (G.distToRingXY(pt, ringsXY[h]) < buffer - 1e-9) ok = false;
            }
          }
          if (ok) {
            var ll = proj.toLL(xy.x, xy.y);
            points.push({ lat: ll.lat, lng: ll.lng });
            if (points.length >= maxPoints) {
              return { points: points, tried: tried, rowGap: rowH, spacing: s, error: 'MAX_POINTS', errorThai: 'จำนวนจุดเกินขีดจำกัด ' + maxPoints + ' จุด — ลดขนาดแปลงหรือเพิ่มระยะปลูก' };
            }
          }
        }
      }
    }
    return { points: points, tried: tried, rowGap: rowH, spacing: s };
  }

  // ---- ตรวจระยะห่างขั้นต่ำด้วย spatial hash (ประสิทธิภาพ O(n)) ----
  // คืนค่า map index→true ของจุดที่ห่างจากจุดอื่นน้อยกว่า min (ไม่นับจุดที่ถูก ignore)
  function findViolations(points, minDist) {
    var cell = Math.max(minDist, 1);
    var gridIdx = {}; // key "cx:cy" → [indices]
    function key(x, y) { return Math.floor(x / cell) + ':' + Math.floor(y / cell); }
    var viol = {};
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      var k = key(p.x, p.y);
      (gridIdx[k] = gridIdx[k] || []).push(i);
    }
    for (i = 0; i < points.length; i++) {
      var q = points[i];
      var cx = Math.floor(q.x / cell), cy = Math.floor(q.y / cell);
      outer:
      for (var gx = cx - 1; gx <= cx + 1; gx++) {
        for (var gy = cy - 1; gy <= cy + 1; gy++) {
          var list = gridIdx[gx + ':' + gy];
          if (!list) continue;
          for (var n = 0; n < list.length; n++) {
            var j = list[n];
            if (j === i) continue;
            var o = points[j];
            var d = Math.hypot(q.x - o.x, q.y - o.y);
            if (d < minDist - 5e-4) { // tolerance 5mm — แยก rounding ออกจากความคลาดจริง
              viol[i] = d;
              if (viol[j] === undefined) viol[j] = d;
              if (Object.keys(viol).length > points.length) break outer;
            }
          }
        }
      }
    }
    return viol;
  }

  return { generate: generate, rowGap: rowGap, findViolations: findViolations, SQRT3_2: SQRT3_2 };
});
