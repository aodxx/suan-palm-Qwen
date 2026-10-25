/* app.js — เชื่อม UI ↔ เครื่องมือ ↔ state ทั้งหมด (ปุ่มทุกตัวทำงานจริง) */
(function (root) {
  'use strict';
  var G = root.PalmGeo, Grid = root.PalmGrid, S = root.PalmState, M = root.PalmMapUI, IO = root.PalmIO, Store = root.PalmStore;
  var $ = function (id) { return document.getElementById(id); };
  var A = {}; // namespace app
  root.PP_BUILD = 'v3.4';
  var EMAP = { 'select': 'select', add: 'addTree', move: 'moveTree', del: 'delTree' };

  // ---------------- toast / input helpers ----------------
  A.toast = function (msg, kind, ms) {
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.innerHTML = msg;
    $('toasts').appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 320); }, ms || 2600);
  };
  function askInput(title, value, cb) {
    var dlg = $('dlgInput');
    $('dlgInputTitle').textContent = title;
    $('dlgInputValue').value = value || '';
    dlg.returnValue = '';
    dlg.showModal();
    var input = $('dlgInputValue');
    setTimeout(function () { input.focus(); input.select(); }, 30);
    input.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); $('dlgInputOk').click(); } };
    // สำคัญ: method=dialog ตั้ง returnValue *หลัง* submit event → ต้องอ่านจาก e.submitter (bug ผู้ใช้จริง: OK ไม่ทำงาน)
    var form = $('dlgInput').querySelector('form');
    form.onsubmit = function (e) {
      var sub = (e && e.submitter && e.submitter.value) || dlg.returnValue;
      if (sub === 'ok' && input.value.trim()) { cb(input.value.trim()); }
      dlg.close();
    };
  }
  function confirmBox(title, msg, cb) {
    var d = $('dlgConfirm');
    $('dlgConfirmTitle').textContent = title;
    $('dlgConfirmMsg').innerHTML = msg;
    d.showModal();
    $('dlgConfirmYes').onclick = function () { d.close(); cb(true); };
    $('dlgConfirmNo').onclick = function () { d.close(); cb(false); };
  }
  A.confirmBox = confirmBox;

  // ---------------- save / autosave ----------------
  var saveTimer = null;
  function setSaveState(cls, text) {
    var chip = $('saveChip');
    chip.className = 'save-chip' + (cls ? ' ' + cls : '');
    $('saveState').textContent = text;
  }
  function scheduleSave() {
    if (saveTimer) return;
    setSaveState('pending', 'ค้างอยู่…');
    saveTimer = setTimeout(function () { saveTimer = null; A.saveNow(true); }, 900);
  }
  A.saveNow = function (silent) {
    if (!S.project) return Promise.reject();
    var pr = serialize();
    return Store.put(pr).then(function () {
      S.dirty = false;
      var t = new Date();
      setSaveState('saved', 'บันทึกแล้ว ' + pad(t.getHours()) + ':' + pad(t.getMinutes()));
      if (!silent) A.toast('💾 บันทึกเรียบร้อย', 'ok');
    }).catch(function (e) {
      console.error(e);
      setSaveState('error', 'บันทึกไม่สำเร็จ');
      if (!silent) A.toast('บันทึกไม่สำเร็จ — ลองใหม่อีกครั้ง', 'warn');
      throw e;
    });
  };
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function r8(v) { var n = Number(v); return isFinite(n) ? Math.round(n * 1e8) / 1e8 : 0; }
  function serialize() {
    var pr = JSON.parse(JSON.stringify(S.project));
    pr.plots.forEach(function (p) { delete p._viol; delete p._violDirty; if (p.grid.originLL) p.grid.originLL = [r8(p.grid.originLL[0]), r8(p.grid.originLL[1])]; });
    pr.plots.forEach(function (p) {
      p.ring = (p.ring || []).map(function (q) { return [r8(q[0]), r8(q[1])]; });
      p.holes = (p.holes || []).map(function (r) { return r.map(function (q) { return [r8(q[0]), r8(q[1])]; }); });
      p.points = (p.points || []).map(function (q) { return { lat: r8(q.lat), lng: r8(q.lng), id: q.id, manual: q.manual }; });
    });
    return pr;
  }
  S.on(function (what) {
    if (what === 'dirty') scheduleSave();
    if (what === 'plots' || what === 'plotGeom' || what === 'points' || what === 'select' || what === 'settings') { A.updateSummary(); A.renderPlotList(); }
    if (what === 'undoState') A.updateUndoButtons();
    if (what === 'project') setSaveState('', S.dirty ? 'ยังไม่บันทึก' : 'พร้อมใช้งาน');
  });

  // ---------------- tool state machine ----------------
  // tools: select | drawPlot | drawHole | pickOrigin | editVertex | addTree | moveTree | delTree | measure(dist/area) | coord
  A.tool = 'select';
  var pendingMovePid = null;

  function banner(text, extraBtnLabel, extraBtnFn) {
    var b = $('modeBanner');
    if (!text) { b.hidden = true; return; }
    b.hidden = false;
    $('modeText').textContent = text;
  }
  A.cancelTool = function () {
    M.cancelDraw();
    M.exitVertexEdit();
    M.stopMeasure();
    $('btnPickOrigin').classList.remove('on');
    A.originPicking = false;
    pendingMovePid = null;
    if (A.tool !== 'select') A.setTool('select');
    banner(null);
  };
  A.setTool = function (t) {
    A.tool = t;
    A.originPicking = (t === 'pickOrigin');
    document.querySelectorAll('[data-emode]').forEach(function (b) { b.classList.toggle('active', EMAP[b.dataset.emode] === t); });
    $('fabDraw').classList.toggle('on', t === 'drawPlot');
    $('btnPickOrigin').classList.toggle('on', A.originPicking);
    document.querySelectorAll('.chip').forEach(function (c) { c.classList.toggle('on', c.dataset.chip === ('measure-dist') && t === 'measureDist' || c.dataset.chip === 'measure-area' && t === 'measureArea' || c.dataset.chip === 'coord' && t === 'coord'); });
    var hints = {
      select: null, drawPlot: 'แตะวางจุดมุมแปลง · กด “ปิดแปลง” เมื่อครบ · ⟲ ถอยจุด',
      drawHole: 'วาดพื้นที่เว้นปลูกในแปลง (ถนน/บ่อ) · กด “ปิดรูป” เมื่อครบ',
      editVertex: 'ลากจุดมุมเพื่อปรับขอบเขต · แตะ 2 ครั้งบนเส้นเพื่อเพิ่มจุดมุม',
      pickOrigin: 'แตะตำแหน่งเริ่มต้น Grid บนแผนที่', addTree: 'แตะแผนที่เพื่อเพิ่มต้นในแปลงที่เลือก',
      moveTree: pendingMovePid ? 'แตะตำแหน่ง جدیدเพื่อ ย้ายต้น #' + pendingMovePid : 'แตะต้นที่ต้องการย้ายก่อน',
      delTree: 'แตะต้นเพื่อลบ', measureDist: 'แตะจุดเพื่อวัดระยะ (กด “เสร็จ” เมื่อบันทึก)', measureArea: 'แตะจุดมุมพื้นที่ชั่วคราว · “เสร็จ” เพื่อจบ',
      coord: 'เลื่อนเมาส์/แตะเพื่อดูพิกัด'
    };
    banner(hints[t] || null);
    A.updateSummary();
  };

  // ---------------- map interactions ----------------
  function mapClickLatlng(e) { return [e.latlng.lat, e.latlng.lng]; }

  M.onMapPolyClick = function (plotId, ll, e) {
    if (['addTree', 'moveTree', 'delTree', 'pickOrigin'].indexOf(A.tool) >= 0 && e) L.DomEvent.stop(e);
    switch (A.tool) {
      case 'select': S.select(plotId); break;
      case 'addTree': addTreeAt(ll, plotId); break;
      case 'delTree': /* handled at marker level */ break;
      case 'moveTree': if (pendingMovePid) moveTreeTo(ll); break;
      case 'editVertex': S.select(plotId); break;
      default: S.select(plotId);
    }
  };
  M.onTreeClick = function (plotId, pid, ll) {
    if (A.tool === 'pickOrigin' && ll) { // ชี้จุดเริ่ม grid ทับตำแหน่งต้น: ใช้พิกัดนั้น
      var p0 = S.selected();
      if (p0) { p0.grid.originLL = ll; S.markDirty(); M.showOriginHandle(p0.id, ll); A.refreshGridPanel();
        A.setTool('select'); A.toast('ตั้งจุดเริ่ม Grid แล้ว — กดคำนวณใหม่เพื่อดูผล', 'ok'); return; }
    }
    if (A.tool === 'addTree' && ll) { addTreeAt(ll, plotId); return; }
    if (A.tool === 'delTree') {}
    switch (A.tool) {
      case 'select': case 'edit:select': S.select(plotId); focusTree(plotId, pid); break;
      case 'delTree': S.select(plotId); S.removePoint(plotId, pid); afterPointEdit(plotId, 'ลบต้น #' + pid); break;
      case 'moveTree':
        S.select(plotId);
        if (pendingMovePid && pendingMovePid === pid) {
          // แตะต้นเดิมซ้ำ = ยกเลิก
          pendingMovePid = null; A.setTool('moveTree'); banner('แตะตำแหน่งใหม่บนแผนที่เพื่อย้ายต้น');
        } else if (pendingMovePid && ll) {
          // มีต้นจับไว้แล้ว แตะตรงไหน也算จุดหมาย (แปลงหนาแน่น: แตะโดนต้นอื่นบ่อย — ต้องย้ายได้ ไม่ใช่สลับเป้าหมาย)
          if (typeof q_lat === 'undefined') {} // no-op
          moveTreeTo([ll[0] + 0.0000001, ll[1] + 0.0000001]); // เลื่อน 1 ซม. กันระยะเท่า 0
          pendingMovePid = null;
          A.setTool('moveTree');
        } else if (!pendingMovePid && pid) {
          pendingMovePid = pid; focusTree(plotId, pid); banner('แตะตำแหน่งใหม่เพื่อย้ายต้น #' + pid);
        }
        break;
      default: S.select(plotId); focusTree(plotId, pid);
    }
  };
  function addTreeAt(ll, plotId) {
    var target = S.plot(plotId);
    var p = S.selected();
    if (!target || S.tool === 'addTree') target = p;
    if (!target) { A.toast('เลือกแปลงก่อน (แท็บ แปลง)', 'warn'); return; }
    var ringsXY = projRings(target);
    var ptXY = ringsXY.proj.toXY(ll[0], ll[1]);
    if (!G.pointInPolyXYOpt(ptXY, ringsXY.rings, false)) {
      A.toast('จุดอยู่นอกแปลง/ในพื้นที่เว้นปลูก — ไม่เพิ่ม', 'warn'); return;
    }
    var q = S.addPoint(target.id, ll[0], ll[1], true);
    afterPointEdit(target.id, q ? 'เพิ่มต้น #' + q.id : '');
  }
  function moveTreeTo(ll) {
    if (!ll || ll.lat == null) return;
    var p = S.selected(); if (!p || !pendingMovePid) return;
    S.movePoint(p.id, pendingMovePid, ll[0], ll[1]);
    afterPointEdit(p.id, 'ย้ายต้น #' + pendingMovePid);
    pendingMovePid = null;
  }
  function projRings(p) {
    var c = G.centroid(p.ring);
    var proj = G.makeProjection(c.lat, c.lng);
    return { proj: proj, rings: [p.ring].concat(p.holes || []).map(function (r) { return r.map(function (q) { return proj.toXY(q[0], q[1]); }); }) };
  }
  function afterPointEdit(plotId, msg) {
    var viol = S.validatePlot(plotId);
    M.refreshPlot(plotId, true);
    A.updateSummary(); A.refreshGridPanel();
    if (msg) A.toast(msg);
    var v = viol.filter(function (x) { return true; });
    if (v.length) setTimeout(function () { A.toast('⚠ มี ' + v.length + ' จุดที่ห่างกันน้อยกว่าระยะที่กำหนด (สีแดง)', 'warn', 3800); }, 260);
  }
  function focusTree(plotId, pid) {
    var p = S.plot(plotId); if (!p) return;
    var q = p.points.filter(function (x) { return x.id === pid; })[0]; if (!q) return;
    M.selectedTreeId = pid; M.selectedTreePlot = plotId;
    // ข้อมูลเชิงลึก: ระยะใกล้สุด + ห่างขอบ
    var pr = projRings(p);
    var me = pr.proj.toXY(q.lat, q.lng);
    var minD = Infinity;
    p.points.forEach(function (o) {
      if (o.id === pid) return;
      var d = (function () { var oo = pr.proj.toXY(o.lat, o.lng); return Math.hypot(me.x - oo.x, me.y - oo.y); })();
      if (d < minD) minD = d;
    });
    var dEdge = G.distToRingXY(me, pr.rings[0]);
    var box = $('treeInfo');
    var idx = p.points.indexOf(q) + 1;
    box.hidden = false;
    box.innerHTML = '🌴 <b>แปลง ' + esc(p.name) + ' — ต้นที่ ' + idx + '</b> (' + (q.manual ? 'เพิ่ม/ปรับด้วยมือ' : 'จาก Grid') + ')<br>' +
      'พิกัด: ' + q.lat.toFixed(6) + ', ' + q.lng.toFixed(6) + '<br>' +
      (minD === Infinity ? '' : 'ห่างต้นใกล้สุด: <span class="' + (minD < p.grid.spacing ? 'bad' : 'good') + '">' + minD.toFixed(2) + ' ม.</span> (=require ≥ ' + p.grid.spacing + ' ม.)<br>') +
      'ห่างขอบแปลง: ' + dEdge.toFixed(2) + ' ม.';
    M.refreshPlot(plotId, true);
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  A.focusTree = focusTree;

  // ---------------- grid calc wiring ----------------
  A.calcGridForPlot = function (plotId, opts) {
    var p = S.plot(plotId); if (!p) return;
    opts = opts || {};
    var spacing = Number($('inSpacing').value);
    if (!(spacing >= 4 && spacing <= 20)) { A.toast('ระยะระหว่างต้นต้องอยู่ระหว่าง 4–20 เมตร', 'warn'); return; }
    var rings = [p.ring].concat(p.holes || []);
    var issues = [];
    rings.forEach(function (r, i) {
      G.validateRing(r).forEach(function (m) { issues.push((i ? 'พื้นที่เว้น#' + i : 'ขอบนอก') + ': ' + m); });
    });
    if (issues.length) { A.toast('รูปทรงผิดปกติ: ' + issues[0], 'warn', 4200); return; }

    var res = Grid.generate({
      rings: rings,
      spacing: spacing,
      angleDeg: Number(p.grid.angleDeg) || 0,
      originLL: p.grid.originLL || null,
      along: Number(p.grid.along) || 0,
      cross: Number(p.grid.cross) || 0,
      buffer: Number(p.grid.buffer) || 0,
      includeBorder: !!p.grid.includeBorder
    });
    if (res.error === 'MAX_POINTS') A.toast(res.errorThai, 'warn', 5000);

    // จุดที่คำนวณใหม่ + คงจุด manual เดิมไว้ (สเปก: ห้ามลบจุดที่ผู้ใช้แก้เองโดยอัตโนมัติ)
    var prevCount = p.points.length;
    var next = res.points.map(function (q) { return { lat: q.lat, lng: q.lng, manual: false }; });
    if (!opts.dropManual) {
      p.points.forEach(function (q) { if (q.manual) next.push({ lat: q.lat, lng: q.lng, manual: true }); });
    }
    S.setPoints(plotId, next);
    M.refreshPlot(plotId); A.updateSummary();
    var nTrees = S.plot(plotId).points.length;
    var delta = nTrees - prevCount;
    var note = $('recalcNote');
    note.hidden = false;
    if (opts.prevCount !== undefined) {
      note.innerHTML = 'จำนวนต้น: ' + G.fmtInt(opts.prevCount) + ' → <b>' + G.fmtInt(nTrees) + '</b> (' + (delta >= 0 ? '+' : '') + delta + ')';
    } else {
      note.innerHTML = 'วางแล้ว <b>' + G.fmtInt(res.points.length) + '</b> ตำแหน่งใหม่ · ระยะห่างระหว่างแถว ' + res.rowGap.toFixed(4) + ' ม. · ระบบตรวจ ' + G.fmtInt(res.tried) + ' ตำแหน่ง';
    }
    if (!res.points.length) A.toast('ไม่พบตำแหน่งปลูกที่ผ่านเงื่อนไข — ลองลดระยะเว้นขอบ หรือหมุนแนวแถว', 'warn', 4200);
    else A.toast('🌴 คำนวณแล้ว ' + G.fmtInt(res.points.length) + ' จุด' + (opts.dropManual ? '' : ' (+คงจุดมือ ' + (nTrees - res.points.length) + ')'));
  };

  // ---------------- summary strip (3.3 — อัปเดตทันทีทุกการกระทำ) ----------------
  A.updateSummary = function () {
    var sm = S.summary(); if (!sm) return;
    $('sumPlots').textContent = sm.plotCount;
    $('sumArea').textContent = G.formatRaiCompact(sm.totalSqM);
    $('sumArea').title = G.formatThaiArea(sm.totalSqM);
    $('sumPlant').textContent = G.formatRaiCompact(sm.plantSqM);
    $('sumPlant').title = G.formatThaiArea(sm.plantSqM);
    $('sumTrees').title = G.fmtInt(sm.trees) + ' ต้น (ปรับด้วยมือ ' + sm.manual + ')';
    $('sumTrees').textContent = G.fmtInt(sm.trees);
    $('sumManual').textContent = G.fmtInt(sm.manual);
    var vw = $('sumViolWrap');
    vw.hidden = sm.violations === 0;
    $('sumViol').textContent = G.fmtInt(sm.violations);
    var vp = $('violCountPill');
    vp.hidden = sm.violations === 0;
    vp.textContent = sm.violations + ' จุด';
  };

  // ---------------- plot list ----------------
  A.renderPlotList = function () {
    var box = $('plotList'); if (!box) return;
    box.innerHTML = '';
    if (!S.project || !S.project.plots.length) {
      box.innerHTML = '<div class="empty">ยังไม่มีแปลง — กด “วาดแปลงใหม่” แล้วแตะแผนที่เป็นจุดมุม</div>';
      $('plotActions').hidden = true;
      return;
    }
    S.project.plots.forEach(function (p) {
      var area = G.polygonAreaSqM([p.ring]);
      var card = document.createElement('div');
      card.className = 'plot-card' + (p.id === S.selectedPlotId ? ' sel' : '');
      var dot = document.createElement('span'); dot.className = 'cdot'; dot.style.background = p.color;
      var meta = document.createElement('div'); meta.className = 'meta';
      var b = document.createElement('b'); b.textContent = p.name;
      var sm = document.createElement('small');
      sm.textContent = G.formatThaiArea(area) + ' · ' + G.fmtInt(p.points.length) + ' ต้น · ระยะ ' + p.grid.spacing + ' ม.';
      meta.appendChild(b); meta.appendChild(sm);
      var eye = document.createElement('button');
      eye.className = 'eye'; eye.textContent = p.visible ? '👁' : '🚫'; eye.title = 'แสดง/ซ่อนแปลง';
      eye.onclick = function (e) {
        e.stopPropagation();
        p.visible = !p.visible;
        S.markDirty();
        M.setPlotVisible(p.id, p.visible);
        A.renderPlotList();
      };
      card.appendChild(dot); card.appendChild(meta); card.appendChild(eye);
      card.onclick = function () { S.select(p.id); M.fitPlot(p.id); };
      box.appendChild(card);
    });
    $('plotActions').hidden = !S.selectedPlotId;
  };

  // ---------------- grid panel sync ----------------
  A.refreshGridPanel = function () {
    var p = S.selected();
    $('gridNoPlot').hidden = !!p;
    $('gridForm').hidden = !p;
    if (!p) return;
    $('inSpacing').value = p.grid.spacing;
    $('inAngle').value = p.grid.angleDeg;
    $('angleRead').textContent = Math.round(p.grid.angleDeg) + '°';
    $('inBuffer').value = p.grid.buffer;
    $('chkBorder').checked = !!p.grid.includeBorder;
    $('alongVal').textContent = fmt1(p.grid.along);
    $('crossVal').textContent = fmt1(p.grid.cross);
    $('rowGapOut').textContent = (p.grid.spacing * Grid.SQRT3_2).toFixed(4) + ' ม. (= s×√3/2)';
    $('originState').textContent = p.grid.originLL ? ('กำหนดแล้ว: ' + p.grid.originLL[0].toFixed(5) + ',' + p.grid.originLL[1].toFixed(5)) : 'มุมแปลงอัตโนมัติ';
    if (p.grid.originLL && A.tool === 'pickOrigin') M.showOriginHandle(p.id, p.grid.originLL);
  };
  function fmt1(n) { n = Number(n) || 0; return (n % 1 ? n.toFixed(2) : String(n)); }

  A.updateUndoButtons = function () {
    $('btnUndo').disabled = !S.canUndo();
    $('btnRedo').disabled = !S.canRedo();
    $('fabUndo').disabled = !S.canUndo();
    var op = S.undoStack[S.undoStack.length - 1];
    $('btnUndo').textContent = '⟲ ถอยกลับ' + (op ? ' (' + opLabel(op) + ')' : '');
  };
  function opLabel(op) {
    return { addPlot: 'แปลงใหม่', delPlot: 'ลบแปลง', setRing: 'ขอบเขต', addHole: 'เว้นปลูก', delHole: 'เว้นปลูก',
      addPoint: 'เพิ่มต้น', delPoint: 'ลบต้น', movePoint: 'ย้ายต้น', setPoints: 'คำนวณ grid', editPlot: 'แก้ชื่อ' }[op.type] || op.type;
  }

  // ---------------- projects ----------------
  function guardUnsavedThen(fn) {
    if (S.dirty) {
      confirmBox('ยังมีการแก้ไข', 'เปิดโครงการอื่น/เริ่มใหม่ — บันทึกปัจจุบันก่อนหรือไม่?', function (yes) {
        var go = function () { fn(); };
        if (yes) A.saveNow(true).then(go, go); else go();
      });
    } else fn();
  }
  A.openProjectList = function () {
    Store.list().then(function (rows) {
      var box = $('projectList');
      box.innerHTML = '';
      if (!rows.length) box.innerHTML = '<div class="empty">ยังไม่มีโครงการที่บันทึก</div>';
      rows.forEach(function (r) {
        var el = document.createElement('div');
        el.className = 'proj-item' + (S.project && S.project.id === r.id ? ' cur' : '');
        el.innerHTML = '<div class="meta"><b>' + esc(r.name) + '</b><small>' + r.plotCount + ' แปลง · แก้ไข ' + fmtDate(r.updatedAt) + '</small></div>';
        var open = btn('เปิด', 'btn-small'); open.onclick = function () {
          guardUnsavedThen(function () {
            Store.get(r.id).then(function (proj) {
              if (!proj) { A.toast('ไม่พบโครงการ', 'warn'); return; }
              S.loadProject(proj);
              M.map().setView([proj.view.lat, proj.view.lng], proj.view.zoom);
              M.refreshAll(); A.refreshAll();
              $('dlgProjects').close();
            });
          });
        };
        var ren = btn('เปลี่ยนชื่อ', 'btn-small'); ren.onclick = function () {
          askInput('เปลี่ยนชื่อโครงการ', r.name, function (name) {
            Store.get(r.id).then(function (proj) { proj.name = name; Store.put(proj).then(function () { A.refreshAll(); A.openProjectList(); if (S.project.id === r.id) $('projName').textContent = name; }); });
          });
        };
        var dup = btn('คัดลอก', 'btn-small'); dup.onclick = function () {
          Store.get(r.id).then(function (proj) {
            proj.id = Store.uid(); proj.name = proj.name + ' (สำเนา)'; proj.createdAt = Date.now();
            Store.put(proj).then(function () { A.toast('คัดลอกแล้ว', 'ok'); A.openProjectList(); });
          });
        };
        var del = btn('ลบ', 'btn-small danger'); del.onclick = function () {
          confirmBox('ลบโครงการ', 'ลบ <b>' + esc(r.name) + '</b> อย่างถาวร? ไม่สามารถกู้คืนได้ถ้าไม่ได้ส่งออกสำรองไว้', function (yes) {
            if (!yes) return;
            Store.remove(r.id).then(function () { A.openProjectList(); if (S.project.id === r.id) { A.newProject(); } });
          });
        };
        el.appendChild(open); el.appendChild(ren); el.appendChild(dup); el.appendChild(del);
        box.appendChild(el);
      });
      $('dlgProjects').showModal();
    });
  };
  function btn(txt, cls) { var b = document.createElement('button'); b.className = 'btn ' + (cls || ''); b.textContent = txt; return b; }
  function fmtDate(ts) { if (!ts) return '—'; var d = new Date(ts); return d.toLocaleDateString('th-TH') + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  A.newProject = function () {
    guardUnsavedThen(function () {
      askInput('ชื่อโครงการใหม่', 'สวนปาล์ม ' + new Date().toLocaleDateString('th-TH'), function (name) {
        S.newProject(name);
        $('projName').textContent = name;
        M.refreshAll(); A.refreshAll();
        A.toast('สร้างโครงการ “' + esc(name) + '” แล้ว', 'ok');
      });
    });
  };

  // ---------------- import / export ----------------
  A.exportProject = function () {
    A.saveNow(true).then(function () {
      IO.download(slug(S.project.name) + '-backup.json', IO.exportProjectJSON(serialize()), 'application/json');
      A.toast('⬇ ดาวน์โหลด JSON สำรองแล้ว');
    }).catch(function () { A.toast('บันทึกก่อนส่งออกไม่สำเร็จ', 'warn'); });
  };
  function slug(s) { return String(s).replace(/[^\w\u0E00-\u0E7F-]+/g, '_').slice(0, 40); }
  A.exportCSV = function () {
    if (!S.project.plots.length) { A.toast('ยังไม่มีแปลง', 'warn'); return; }
    IO.download(slug(S.project.name) + '-trees.csv', IO.exportPointsCSV(S.project), 'text/csv');
    A.toast('⬇ CSV จุดปลูกแล้ว (' + S.summary().trees + ' จุด)');
  };
  A.exportGeoJSON = function () {
    if (!S.project.plots.length) { A.toast('ยังไม่มีแปลง', 'warn'); return; }
    IO.download(slug(S.project.name) + '.geojson', IO.exportGeoJSON(S.project), 'application/geo+json');
    A.toast('⬇ GeoJSON แล้ว');
  };
  A.exportSummary = function () {
    IO.download(slug(S.project.name) + '-summary.csv', IO.exportSummaryCSV(S.project, S.summary()), 'text/csv');
    A.toast('⬇ รายงานสรุป CSV แล้ว');
  };
  A.importProject = function (file) {
    IO.readFileText(file).then(function (text) {
      try {
        var proj = IO.importProjectJSON(text);
        confirmBox('แทนที่โครงการปัจจุบัน?', 'นำเข้าจะแทนที่งานปัจจุบัน (ข้อมูลเดิมยังอยู่ใน machine จนกว่าจะบันทึกทับ — แนะนำให้กดส่งออกสำรองก่อนถ้า unsure)', function (yes) {
          if (!yes) return;
          S.loadProject(proj);
          $('projName').textContent = proj.name;
          M.map().setView(G.centroid(proj.plots[0] ? proj.plots[0].ring[0] && proj.plots.length ? [proj.plots[0].ring[0][0], proj.plots[0].ring[0][1]] : [9.5, 99] : [9.5, 99]), 14);
          M.refreshAll(); A.refreshAll(); A.saveNow(true);
          A.toast('นำเข้าโครงการ “' + esc(proj.name) + '” สำเร็จ', 'ok');
        });
      } catch (e) {
        A.toast('❌ ' + e.message + ' — ข้อมูลเดิมไม่ถูกแก้', 'warn', 5200);
      }
    });
  };
  A.importCSV = function (file) {
    IO.readFileText(file).then(function (text) {
      try {
        var r = IO.importPointsCSV(text);
        var p = S.selected();
        if (r.errors.length) A.toast('ข้ามแถวผิด ' + r.errors.length + ' แถว (เช่น ' + esc(r.errors[0]) + ')', 'warn', 4400);
        importPointsAsTrees(r.points.map(function (q) { return { lat: q.lat, lng: q.lng, label: q.plotName }; }), p && p.name);
        if (r.points.length === 0) A.toast('ไม่มีแถวที่ถูกต้องในไฟล์', 'warn');
        else A.toast('นำเข้า CSV แล้ว ' + r.points.length + ' จุด', 'ok');
      } catch (e) { A.toast('❌ ' + e.message, 'warn', 5200); }
    });
  };
  A.importGeoJSONFile = function (file) {
    IO.readFileText(file).then(function (text) {
      try {
        var r = IO.importGeoJSON(text);
        r.plots.forEach(function (pl) { S.addPlot(pl.ring, pl.name); if (r.plots.indexOf(pl) === 0) S.plot(S.selectedPlotId).holes = pl.holes || []; });
        if (r.points.length) importPointsAsTrees(r.points);
        A.refreshAll();
        A.toast('GeoJSON: ' + r.plots.length + ' แปลง' + (r.points.length ? ' + ' + r.points.length + ' จุด' : ''), 'ok');
      } catch (e) { A.toast('❌ ' + e.message, 'warn', 5200); }
    });
  };
  A.importKMLFile = function (file) {
    IO.readFileText(file).then(function (text) {
      try {
        var r = IO.importKML(text);
        r.plots.forEach(function (pl, idx) {
          var np = S.addPlot(pl.ring, pl.name || ('แปลง KML ' + (S.project.plots.length + 1)));
          (pl.holes || []).forEach(function (h) { S.addHole(np.id, h); });
        });
        if (r.points.length) importPointsAsTrees(r.points);
        A.refreshAll();
        A.toast('KML: ' + r.plots.length + ' แปลง' + (r.points.length ? ' + ' + r.points.length + ' จุด' : ''), 'ok');
      } catch (e) { A.toast('❌ ' + e.message, 'warn', 5200); }
    });
  };
  function importPointsAsTrees(pts, defPlot) {
    var byName = {};
    pts.forEach(function (q) { var k = q.plotName || q.label || defPlot || ''; (byName[k] = byName[k] || []).push(q); });
    Object.keys(byName).forEach(function (name) {
      if (!name) {
        byName[name].forEach(function (q) { S.addPoint(S.selectedPlotId || (S.project.plots[0] && S.project.plots[0].id), q.lat, q.lng, true); });
        return;
      }
      var target = S.project.plots.filter(function (p) { return p.name === name; })[0] || S.addPlot(hullOf(byName[name]), name);
      byName[name].forEach(function (q) { S.addPoint(target.id, q.lat, q.lng, true); });
    });
    (S.project.plots || []).forEach(function (p) { M.refreshPlot(p.id); });
  }
  function hullOf(pts) {
    // convex hull (Andrew monotone chain) สำหรับนำเข้าแบบไม่มี polygon
    var P = pts.map(function (p) { return [p.lng, p.lat]; }).sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    if (P.length < 3) { pad2(P); }
    var lower = [];
    P.forEach(function (p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); });
    var upper = [];
    P.slice().reverse().forEach(function (p) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); });
    lower.pop(); upper.pop();
    var h = lower.concat(upper).map(function (q) { return [q[1], q[0]]; }); // [lat,lng]
    return padRing(h);
  }
  function pad2(P) { while (P.length < 3) P.push(P[0] ? [P[0][0] + 0.00001 * (P.length + 1), P[0][1] ? P[0][1] + 0.00001 * (P.length + 1) : 0] : [9.5, 99]); }
  function padRing(h) {
    if (h.length === 1) { var c = h[0]; return [[c[0] - 2e-5, c[1] - 2e-5], [c[0] - 2e-5, c[1] + 2e-5], [c[0] + 2e-5, c[1] + 2e-5], [c[0] + 2e-5, c[1] - 2e-5]]; }
    if (h.length === 2) {
      var a = h[0], b = h[1];
      var mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      var w = 2e-5;
      return [[a[0] - w, a[1] - w], [b[0] + w * -1, b[1] - w], [b[0], b[1]], [a[0], a[1]]].map(function (q) { return [q[0] + (Math.random() - .5) * 0, q[1]]; });
    }
    return h;
  }

  // ---------------- paste dialog ----------------
  function bindPasteDialog() {
    $('btnPasteCoords').onclick = function () { $('pasteArea').value = ''; $('dlgPaste').showModal(); };
    $('dlgPasteCancel').onclick = function () { $('dlgPaste').close(); };
    $('dlgPasteOk').onclick = function () {
      try {
        var r = IO.parsePastedCoords($('pasteArea').value);
        $('dlgPaste').close();
        var pts = r.points;
        if ($('chkPasteNewPlot').checked) {
          var ring = padRing(hullOf(pts));
          var p = S.addPlot(ring, 'แปลงจากพิกัด ' + (S.project.plots.length + 1));
          pts.forEach(function (q) { S.addPoint(p.id, q.lat, q.lng, true); });
          A.refreshAll();
          M.fitPlot(p.id);
        } else {
          importPointsAsTrees(pts);
          A.refreshAll();
        }
        A.toast('นำเข้า ' + pts.length + ' จุด' + (r.errors.length ? ' (ข้าม ' + r.errors.length + ' บรรทัดผิด)' : ''), 'ok');
      } catch (e) { A.toast('❌ ' + e.message, 'warn', 5200); }
    };
  }

  // ---------------- report ----------------
  A.renderReport = function () {
    var box = $('reportBox');
    var sm = S.summary ? S.summary() : null;
    if (!S.project || !S.project.plots.length) { box.innerHTML = '<div class="empty">ยังไม่มีข้อมูล — เพิ่มแปลงก่อน</div>'; return; }
    var rows = S.project.plots.map(function (p) {
      var a = G.polygonAreaSqM([p.ring]), pl = G.polygonAreaSqM([p.ring].concat(p.holes || []));
      var viol = S.validatePlot(p.id).length;
      var man = p.points.filter(function (q) { return q.manual; }).length;
      return '<tr><td><a href="#" data-jump="' + p.id + '">' + esc(p.name) + '</a></td>' +
        '<td class="num">' + G.formatThaiArea(a) + '</td><td class="num">' + G.formatThaiArea(pl) + '</td>' +
        '<td class="num">' + G.fmtInt(p.points.length) + '</td><td class="num">' + p.grid.spacing + ' ม.</td>' +
        '<td class="num">' + Math.round(p.grid.angleDeg) + '°</td><td class="num">' + man + '</td><td class="num">' + (viol || '') + '</td></tr>';
    });
    box.innerHTML = '<table class="rep"><tr><th>แปลง</th><th class="num">พื้นที่</th><th class="num">ปลูกได้</th><th class="num">ต้น</th><th class="num">ระยะ</th><th class="num">มุมแถว</th><th class="num">ปรับมือ</th><th class="num">ผิดระยะ</th></tr>' +
      rows.join('') + '<tr><th>รวม</th><th class="num">' + G.formatThaiArea(sm.totalSqM) + '</th><th class="num">' + G.formatThaiArea(sm.plantSqM) + '</th><th class="num" colspan="5">' + G.fmtInt(sm.trees) + ' ต้น (' + sm.violations + ' ผิดระยะ)</th></tr></table>' +
      '<p class="tiny-note">ตัวเลขทุกตัวคำนวณจากข้อมูลจริงของโครงการ — แตะชื่อแปลงเพื่อกระโดดไปแผนที่</p>';
    box.querySelectorAll('[data-jump]').forEach(function (a) {
      a.onclick = function (e) { e.preventDefault(); S.select(a.dataset.jump); M.fitPlot(a.dataset.jump); A.setTab('plots'); };
    });
  };

  // ---------------- search (Nominatim) ----------------
  function bindSearch() {
    var inp = $('searchInput'), box = $('searchResults'), timer = null;
    inp.addEventListener('input', function () { clearTimeout(timer); box.hidden = true; });
    inp.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var q = inp.value.trim(); if (!q) return;
      box.hidden = false; box.innerHTML = '<div class="sr-loading">กำลังค้นหา…</div>';
      var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=th&q=' + encodeURIComponent(q);
      fetch(url, { headers: { 'X-Preferred-Results': 'th' } })
        .then(function (r) { return r.json(); })
        .then(function (rows) {
          if (!rows.length) { box.innerHTML = '<div class="sr-loading">ไม่พบสถานที่ — ลองคำค้นอื่น หรือพิมพ์พิกัด เช่น 9.9571, 99.0966</div>'; tryCoord(); return; }
          box.innerHTML = '';
          rows.forEach(function (r) {
            var it = document.createElement('div');
            it.className = 'sr-item';
            it.innerHTML = '<b>' + esc(r.display_name).split(',').slice(0, 2).join(',') + '</b><small>' + esc(r.display_name) + '</small>';
            it.onclick = function () {
              box.hidden = true;
              M.map().setView([+r.lat, +r.lon], 17);
            };
            box.appendChild(it);
          });
        })
        .catch(function () { box.innerHTML = '<div class="sr-loading">ค้นหาไม่ได้ — ต้องต่อเน็ต (ลองพิมพ์พิกัดตรง เช่น 9.9571, 99.0966)</div>'; tryOnly(); });
      function tryCoord() { try { var c = IO.parsePastedCoords(q); M.map().setView([c.points[0].lat, c.points[0].lng], 17); box.hidden = true; } catch (e) { } }
      function tryOnly() {
        try {
          var r = IO.parsePastedCoords(q);
          M.map().setView([r.points[0].lat, r.points[0].lng], 17);
          box.hidden = true;
        } catch (e) { }
      }
    });
    $('searchClearBtn').onclick = function () { inp.value = ''; box.hidden = true; };
  }

  // ---------------- report render on tab switch ----------------
  A.setTab = function (name) {
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
    document.querySelectorAll('.tab-pane').forEach(function (pn) { pn.classList.toggle('active', pn.id === 'tab-' + name); });
    if (name === 'report') A.renderReport();
    if (name === 'plots') A.renderPlotList();
    if (name === 'grid') A.refreshGridPanel();
  };

  A.refreshAll = function () {
    A.renderPlotList(); A.refreshGridPanel(); A.updateSummary(); A.updateUndoButtons();
    $('projName').textContent = S.project ? S.project.name : '—';
  };

  // ---------------- drawing finish/cancel bar (เพิ่ม dynamic buttons ใน banner) ----------------
  function ensureDrawBtns() {
    var b = $('modeBanner');
    if (document.getElementById('drawFinish')) return;
    var wrap = document.createElement('span');
    wrap.style.cssText = 'display:flex;gap:6px;align-items:center';
    wrap.innerHTML = '<button class="btn btn-tiny" id="drawUndoV">⟲ ถอยจุด</button>' +
      '<button class="btn btn-tiny btn-primary" id="drawFinish" style="background:var(--accent);color:#fff;border-color:var(--accent)">✔ ปิดแปลง</button>';
    b.insertBefore(wrap, $('modeCancel'));
    $('drawUndoV').onclick = function () { if (!M.undoVertex()) A.toast('ไม่มีจุดให้ถอย'); };
    $('drawFinish').onclick = function () { commitDraw(); };
    var mb = document.createElement('span');
    mb.id = 'measureFinishWrap';
    mb.innerHTML = '<button class="btn btn-tiny" id="measureFinish" style="background:var(--accent);color:#fff;border:0">✔ เสร็จ</button>';
    b.insertBefore(mb, $('modeCancel'));
    $('measureFinish').onclick = function () { M.finishMeasure(); A.setTool('select'); };
    $('modeBanner').addEventListener('click', function (e) { if (e.target === this || e.target === $('modeCancel')) A.cancelTool(); });
  }
  function commitDraw() {
    var res = M.finishDraw();
    if (!res) { A.toast('ต้องมีอย่างน้อย 3 จุดมุม', 'warn'); return; }
    if (res.issues.length) { A.toast('⚠ ' + res.issues[0] + ' — รูปทรงนี้อาจทำให้การคำนวณคลาดเคลื่อน', 'warn', 5200); }
    var ring = res.ring;
    if (res.mode === 'plot') {
      var p = S.addPlot(ring);
      A.refreshAll();
      A.toast('สร้าง “' + esc(p.name) + '” — ' + G.formatThaiArea(G.polygonAreaSqM([p.ring])), 'ok');
      var cw = $('coach'); if (cw) cw.hidden = true;
      $('fabCalc').classList.add('pulse');
      setTimeout(function () { $('fabCalc').classList.remove('pulse'); }, 4200);
      A.enterDrawDone(ring);
    } else if (res.mode === 'hole') {
      var sel = S.selected();
      if (!sel) { A.toast('เลือกแปลงก่อน', 'warn'); return; }
      // hole ต้องอยู่ภายใน outer จริง (check ทุกจุด)
      var c = G.centroid(sel.ring);
      var proj = G.makeProjection(c.lat, c.lng);
      var outerXY = sel.ring.map(function (q) { return proj.toXY(q[0], q[1]); });
      var out = ring.map(function (q) { return proj.toXY(q[0], q[1]); });
      var allIn = out.every(function (q) { return G.pointInRingXY(q, outerXY); });
      if (!allIn) { A.toast('พื้นที่เว้นปลูกต้องอยู่ภายในแปลงทั้งหมด', 'warn', 4200); return; }
      S.addHole(sel.id, ring);
      M.refreshPlot(sel.id);
      A.toast('เพิ่มพื้นที่เว้นปลูกแล้ว', 'ok');
    }
    A.setTool('select');
    A.cancelTool();
  }
  A.enterDrawDone = function () { /* hook เผื่อส่วนอื่นต่อ */ };
  $('btnGoPlots') && ($('btnGoPlots').onclick = function () { A.setTab('plots'); });

  // ---------------- wiring ทั้งหมด ----------------
  function wire() {
    ensureDrawBtns();
    // tabs
    $('tabs').addEventListener('click', function (e) {
      var t = e.target.closest('.tab'); if (t) A.setTab(t.dataset.tab);
    });
    // panel states
    $('panelGrab').onclick = function () {
      var pn = $('panel');
      if (pn.classList.contains('collapsed')) { pn.classList.remove('collapsed'); pn.classList.add('expanded'); }
      else if (pn.classList.contains('expanded')) pn.classList.remove('expanded');
      else pn.classList.add('collapsed');
      setTimeout(function () { M.map().invalidateSize(); }, 280);
    };
    $('btnMenu').onclick = function () { $('panel').classList.toggle('collapsed'); setTimeout(function () { M.map().invalidateSize(); }, 280); };

    // map buttons
    $('saveChip').onclick = function () { A.saveNow(false).catch(function () {}); };
    $('btnLayers').onclick = function () {
      var a = M.toggleLayer();
      $('layerLabel').textContent = a === 'sat' ? 'ดาว' : 'ถนน';
    };
    $('btnFit').onclick = function () { M.fitAll(); };
    $('btnZoomIn').onclick = function () { M.map().zoomIn(); };
    $('btnZoomOut').onclick = function () { M.map().zoomOut(); };
    $('btnLocate').onclick = function () {
      if (!navigator.geolocation) { A.toast('เครื่องนี้ไม่รองรับ GPS', 'warn'); return; }
      A.toast('หาตำแหน่ง… (ต้องอนุญาตการใช้-location)');
      navigator.geolocation.getCurrentPosition(function (pos) {
        M.map().setView([pos.coords.latitude, pos.coords.longitude], 17);
        A.toast('พบตำแหน่งปัจจุบัน (±' + Math.round(pos.coords.accuracy) + ' ม.)', 'ok');
      }, function (err) { A.toast('หาตำแหน่งไม่ได้: ' + (err.code === 1 ? 'ไม่ได้อนุญาต location' : 'สัญญาณ/GPS ไม่พร้อม'), 'warn', 3800); });
    };

    // FABs
    $('fabDraw').onclick = function () {
      if (M.isDrawing()) { commitDraw(); return; }
      A.setTool(A.tool === 'drawPlot' ? 'select' : 'drawPlot');
      if (A.tool === 'drawPlot') { M.startDraw('plot'); A.setTool('drawPlot'); }
    };
    $('btnDrawPlot').onclick = $('fabDraw').onclick;
    $('fabUndo').onclick = $('btnUndo').onclick = function () {
      var op = S.undo();
      if (!op) { A.toast('ไม่มีอะไรให้ถอยกลับ'); return; }
      A.toast('กลับคืน: ' + opLabel(op));
      M.refreshAll(); A.refreshAll();
    };
    $('btnRedo').onclick = function () {
      var op = S.redo();
      if (!op) return;
      A.toast('ทำซ้ำ: ' + opLabel(op));
      M.refreshAll(); A.refreshAll();
    };
    $('fabCalc').onclick = function () {
      var p = S.selected();
      if (!p) { A.setTab('plots'); A.toast('เลือก/วาดแปลงก่อน แล้วค่อยคำนวณ', 'warn'); return; }
      $('fabCalc').classList.remove('pulse');
      A.setTab('grid'); A.calcGridForPlot(p.id, { prevCount: undefined });
    };

    // plot actions
    $('paRename').onclick = function () {
      var p = S.selected(); if (!p) return;
      askInput('เปลี่ยนชื่อแปลง', p.name, function (n) { S.renamePlot(p.id, n); M.refreshPlot(p.id); });
    };
    $('paCopy').onclick = function () { var p = S.selected(); if (p) { S.copyPlot(p.id); M.refreshAll(); } };
    $('paDelete').onclick = function () {
      var p = S.selected(); if (!p) return;
      confirmBox('ลบแปลง', 'ลบ “' + esc(p.name) + '” และจุดปลูก ' + p.points.length + ' จุด? (กด ⟲ ถอยกลับได้)', function (yes) {
        if (!yes) return;
        M.removePlotShape(p.id); S.removePlot(p.id); M.refreshAll(); A.refreshAll();
      });
    };
    $('paHole').onclick = function () {
      if (!S.selected()) { A.toast('เลือกแปลงก่อน', 'warn'); return; }
      if (M.isDrawing()) { commitDraw(); return; }
      A.setTool('drawHole'); M.startDraw('hole'); A.setTool('drawHole');
    };
    $('paFit').onclick = function () { if (S.selected()) M.fitPlot(S.selectedPlotId); };

    // edit modes
    document.querySelectorAll('[data-emode]').forEach(function (b) {
      b.onclick = function () { var m = EMAP[b.dataset.emode]; A.setTool(m); if (m === 'moveTree') pendingMovePid = null; };
    });
    $('btnJumpViol').onclick = function () {
      var p = S.selected(); if (!p) { A.setTab('plots'); A.toast('เลือกแปลงก่อน', 'warn'); return; }
      var v = S.validatePlot(p.id);
      if (!v.length) { A.toast('✓ ไม่พบจุดผิดระยะในแปลงนี้', 'ok'); return; }
      var q = p.points.filter(function (x) { return x.id === v[0].pid; })[0];
      if (q) { M.map().setView([q.lat, q.lng], Math.max(M.map().getZoom(), 19)); focusTree(p.id, q.id); A.toast('พาไปต้นผิดระยะ (ห่าง ' + v[0].dist.toFixed(2) + ' ม.)'); }
      this.scrollIntoView({ block: 'nearest' });
    };
    $('btnClearPoints').onclick = function () {
      var p = S.selected(); if (!p || !p.points.length) { A.toast('แปลงนี้ยังไม่มีจุดปลูก', 'warn'); return; }
      confirmBox('ลบจุดปลูกทั้งหมด', 'ลบ ' + p.points.length + ' จุดของ “' + esc(p.name) + '”? รวมจุดที่ปรับด้วยมือ — ถอยกลับได้ด้วย ⟲', function (yes) {
        if (!yes) return;
        S.setPoints(p.id, []); M.refreshPlot(p.id); A.refreshAll();
      });
    };

    // grid form
    $('inSpacing').onchange = function () {
      var p = S.selected(); if (!p) return;
      var v = Number(this.value);
      if (!(v >= 4 && v <= 20)) { A.toast('ระยะต้องอยู่ระหว่าง 4–20 เมตร — คืนค่าเดิม', 'warn'); this.value = p.grid.spacing; return; }
      S.updateGrid(p.id, { spacing: v });
      A.refreshGridPanel();
      $('rowGapOut').textContent = (v * Grid.SQRT3_2).toFixed(4) + ' ม. (= s×√3/2)';
    };
    $('inAngle').oninput = function () { $('angleRead').textContent = this.value + '°'; };
    $('inAngle').onchange = function () {
      var p = S.selected(); if (!p) return;
      var prev = p.points.length;
      S.updateGrid(p.id, { angleDeg: Number(this.value) });
      if (prev && $('chkAutoRecalc') && $('chkAutoRecalc').checked) A.calcGridForPlot(p.id, { prevCount: prev });
    };
    document.querySelectorAll('[data-angle-step]').forEach(function (b) {
      b.onclick = function () {
        var p = S.selected(); if (!p) { A.toast('เลือกแปลงก่อน'); return; }
        var next = ((Number(p.grid.angleDeg) + Number(b.dataset.angleStep)) % 360 + 360) % 360;
        var prev = p.points.length;
        S.updateGrid(p.id, { angleDeg: next });
        A.refreshGridPanel();
        if (prev) A.calcGridForPlot(p.id, { prevCount: prev });
      };
    });
    document.querySelectorAll('[data-off]').forEach(function (b) {
      b.onclick = function () {
        var p = S.selected(); if (!p) { A.toast('เลือกแปลงก่อน'); return; }
        var key = b.dataset.off === 'along' ? 'along' : 'cross';
        var v = (Number(p.grid[key]) || 0) + Number(b.dataset.step);
        var prev = p.points.length;
        S.updateGrid(p.id, (function () { var o = {}; o[key] = Math.round(v * 100) / 100; return o; })());
        A.refreshGridPanel();
        if (prev) A.calcGridForPlot(p.id, { prevCount: prev });
      };
    });
    $('inBuffer').onchange = function () {
      var v = Math.max(0, Math.min(30, Number(this.value) || 0));
      var p = S.selected(); if (!p) return;
      this.value = v;
      S.updateGrid(p.id, { buffer: v });
    };
    $('chkBorder').onchange = function () { var p = S.selected(); if (p) S.updateGrid(p.id, { includeBorder: this.checked }); };
    $('btnCalcGrid').onclick = function () {
      var p = S.selected(); if (!p) { A.setTab('plots'); A.toast('เลือก/วาดแปลงก่อน แล้วค่อยคำนวณ', 'warn'); return; }
      $('fabCalc').classList.remove('pulse');
      A.calcGridForPlot(p.id);
    };  $('fabCalc').onclick = function () {
      var p = S.selected();
      if (!p) { A.setTab('plots'); A.toast('เลือก/วาดแปลงก่อน แล้วค่อยคำนวณ', 'warn'); return; }
      $('fabCalc').classList.remove('pulse');
      A.setTab('grid'); A.calcGridForPlot(p.id, { prevCount: undefined });
    };
    $('btnPickOrigin').onclick = function () {
      if (!S.selected()) { A.toast('เลือกแปลงก่อน', 'warn'); return; }
      if (A.originPicking) { A.setTool('select'); return; }
      A.setTool('pickOrigin');
    };
    $('btnClearOrigin').onclick = function () {
      var p = S.selected(); if (!p) return;
      S.updateGrid(p.id, { originLL: null, along: 0, cross: 0 });
      M.showOriginHandle(p.id, null);
      A.refreshGridPanel();
    };

    // map global clicks by tool
    M.map().on('click', function (e) {
      var ll = [e.latlng.lat, e.latlng.lng];
      switch (A.tool) {
        case 'pickOrigin': {
          var p = S.selected(); if (!p) return;
          S.updateGrid(p.id, { originLL: ll });
          A.originPicking = false;
          M.showOriginHandle(p.id, ll);
          A.setTool('select');
          A.refreshGridPanel();
          A.toast('ตั้งจุดเริ่ม Grid แล้ว — กดคำนวณใหม่เพื่อดูผล', 'ok');
          break;
        }
        case 'addTree': addTreeAt(ll, null); break;
        case 'moveTree': if (pendingMovePid) moveTreeTo(ll); break;
        case 'select': M.selectedTreeId = null; break;
      }
    });
    M.map().on('mousemove', function (e) {
      if (A.tool === 'coord' || true) {
        var cp = $('coordPill');
        cp.hidden = !(A.tool === 'coord' || A.originPicking);
        if (!cp.hidden) cp.textContent = e.latlng.lat.toFixed(6) + ', ' + e.latlng.lng.toFixed(6);
      }
    });

    // measure chips
    document.querySelectorAll('.chip').forEach(function (c) {
      c.onclick = function () {
        var k = c.dataset.chip;
        if (k === 'clearmeasure') { M.clearMeasure(); A.setTool('select'); return; }
        if (k === 'coord') { A.setTool(A.tool === 'coord' ? 'select' : 'coord'); return; }
        if (k === 'measure-dist' && A.tool !== 'measureDist') { M.startMeasure('dist'); A.setTool('measureDist'); }
        else if (k === 'measure-area' && A.tool !== 'measureArea') { M.startMeasure('area'); A.setTool('measureArea'); }
        else A.setTool('select');
        if (A.tool.indexOf('measure') === 0) { banner(A.tool === 'measureDist' ? 'แตะจุดเพื่อวัดระยะ · ✔ เสร็จเพื่อจบ' : 'แตะจุดมุมพื้นที่ · ✔ เสร็จเพื่อจบ'); }
      };
    });
    M.onHint = function () {};

    // data tab buttons
    $('btnSaveNow').onclick = function () { A.saveNow(false).catch(function () { }); };
    $('btnNewProject').onclick = function () { A.newProject(); };
    $('btnProjectList').onclick = $('projChip').onclick = function () { A.openProjectList(); };
    $('dlgProjectsClose').onclick = function () { $('dlgProjects').close(); };
    $('btnExportProject').onclick = A.exportProject;
    $('btnExportCSV').onclick = A.exportCSV;
    $('btnExportGeoJSON').onclick = A.exportGeoJSON;
    $('btnExportSummary').onclick = A.exportSummary;
    bindPasteDialog();
    bindSearch();

    // file picker flow
    var pendingFileKind = null;
    function pick(kind, accept) {
      pendingFileKind = kind;
      var fp = $('filePicker');
      fp.accept = accept;
      fp.value = '';
      fp.click();
    }
    $('btnImportProject').onclick = function () { pick('project', '.json'); };
    $('btnImportCSV').onclick = function () { pick('csv', '.csv,.txt'); };
    $('btnImportGeoJSON').onclick = function () { pick('geojson', '.geojson,.json'); };
    $('btnImportKML').onclick = function () { pick('kml', '.kml'); };
    $('filePicker').onchange = function () {
      var f = this.files && this.files[0]; if (!f) return;
      if (pendingFileKind === 'project') A.importProject(f);
      else if (pendingFileKind === 'csv') A.importCSV(f);
      else if (pendingFileKind === 'kml') A.importKMLFile(f);
      else A.importGeoJSONFile(f);
    };

    // keyboard shortcuts (desktop)
    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); $('btnUndo').click(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); $('btnRedo').click(); }
      if (e.key === 'Escape') A.cancelTool();
      if (e.key === 'Enter' && M.isDrawing()) commitDraw();
    });

    // state change → map refresh (กัน loop: ใช้เฉพาะ external events)
    S.on(function (what, data) {
      if (A._silentRefresh) return;
      if (what === 'plots') { (S.project.plots || []).forEach(function (p) { if (!M.map().hasLayer) {} }); }
      if (what === 'plotGeom' && data) { M.refreshPlot(data.plotId); }
      if (what === 'ringChanged' && data) { M.refreshPlot(data.plotId); }
    });

    // vertex commit callbacks
    M.onRingCommit = function (plotId, newRing) {
      var p = S.plot(plotId);
      var prevCount = p.points.length;
      S.setRing(plotId, newRing);
      M.exitVertexEdit();
      M.enterVertexEdit(plotId);
      if (prevCount) {
        confirmBox('ขอบเขตเปลี่ยน', 'แปลงนี้มีจุดปลูก ' + prevCount + ' จุดที่อาจไม่ตรงกับขอบเขตใหม่ — ให้คำนวณใหม่?', function (yes) {
          if (yes) { S.updateGrid(plotId, {}); A.calcGridForPlot(plotId, { prevCount: prevCount }); }
        });
      }
    };
    M.onRingLive = function (o) {
      var p = S.plot(o.plotId);
      var sh = M.plotShapeRef ? null : null;
      // วาดใหม่แบบเบ็ดเสร็จ (แปลงขนาดปกติ เร็วพอ)
      A._silentRefresh = true; M.refreshPlot(o.plotId); A._silentRefresh = false;
    };
    M.onHoleChanged = function (plotId) { M.refreshPlot(plotId); A.updateSummary(); };
    M.onOriginMoved = function (plotId, ll) {
      var p = S.plot(plotId);
      var prev = p.points.length;
      p.grid.originLL = ll; S.markDirty();
      A.refreshGridPanel();
      if (prev) A.calcGridForPlot(plotId, { prevCount: prev });
      else A.toast('จุดเริ่มใหม่ตั้งค่าแล้ว');
    };

    // edit tab quick entry
    document.querySelector('[data-emode="select"]').onclick;
  }

  // ---------------- offline / service worker ----------------
  function netAware() {
    function show() { var b = $('netBanner'); if (b) { b.hidden = false; b.textContent = window.__offlineMode ? '✈️โหมดออฟไลน์: ตัวแอป+ข้อมูลใช้งานได้ปกติ · ภาพดาวเทียมอาจเป็นภาพเก่า/ไม่โหลดจนกว่าจะกลับออนไลน์' : '⚠ โหลดภาพดาวเทียมไม่ได้ — เชื่อมต่อเน็ตแล้วกด “ลองใหม่” (ข้อมูลแปลงของคุณปลอดภัย)'; } }
    window.addEventListener('offline', function () { window.__offlineMode = true; A.toast('หลุดออนไลน์ — โหมดออฟไลน์: บันทึก/คำนวณ/แก้ไขทำได้ต่อ', 'warn', 3600); show(); });
    window.addEventListener('online', function () { window.__offlineMode = false; $('netBanner').hidden = true; A.toast('กลับออนไลน์แล้ว'); });
    if (!navigator.onLine) { window.__offlineMode = true; show(); }
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('./sw.js').catch(function () { /* ไม่fatal */ });
    }
  }

  // ---------------- boot ----------------
  function boot() {
    netAware();
    M.init($('map'));
    M.map().setView([9.5, 99.0], 10); // ฐาน-view: แรกเปิดห้าม แผนที่ไม่มี center
    M.onTileError = function () { $('netBanner').hidden = false; };
    $('netBanner').onclick = function () { location.reload(); };
    ensureDrawBtns();
    wire();

    var coachEl = $('coach');
    try {
      if (!localStorage.getItem('pp-coach') && coachEl) coachEl.hidden = false;
      $('coachX').onclick = function () { coachEl.hidden = true; try { localStorage.setItem('pp-coach', '1'); } catch (e) {} };
    } catch (e) {}
    Store.open().then(function () {
      $('storageBackend').textContent = Store.backend() + (Store.backend() === 'IndexedDB' ? '' : ' (fallback)');
      return Store.list();
    }).then(function (rows) {
      if (rows.length) {
        return Store.get(rows[0].id).then(function (proj) {
          S.loadProject(proj);
          M.map().setView([proj.view.lat, proj.view.lng], proj.view.zoom);
          $('projName').textContent = proj.name;
          setSaveState('saved', 'โหลดจากเครื่องแล้ว');
        });
      }
      S.newProject();
      setSaveState('', 'พร้อมใช้งาน');
      try { if (!localStorage.getItem('pp-coach') && coachEl) coachEl.hidden = false; } catch (e) {}
    }).catch(function () {
      S.newProject();
      try { if (!localStorage.getItem('pp-coach') && coachEl) coachEl.hidden = true ? false : false; } catch (e) {}
    }).then(function () {
      M.refreshAll();
      A.refreshAll();
      A.setTool('select');
      // ค้าง modeBanner ตอนแรกซ่อน
      $('modeBanner').hidden = true;
    });
  }

  root.PalmApp = A;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
