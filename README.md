# PalmsPlan — แอปวางแผนปลูกปาล์มน้ำมัน (Single-Page Web App)

สร้างตามสเปก `PROJECT MASTER PROMPT: Palm Plantation Planner` — ใช้งานได้จริง ไม่มีปุ่มจำลอง

## วิธีเปิดใช้งาน
- เปิดผ่านเว็บเซิร์ฟเวอร์ static ใดๆ เช่น `python3 -m http.server 8000` then `http://localhost:8000/palm-planner/`
- หรือแค่ unzip แล้วเปิด `index.html` ผ่านเว็บเซิร์ฟเวอร์ (อย่าเปิดเป็น file:// เพราะข้อจำกัด CDN/tiles)
- ต้องต่ออินเทอร์เน็ตสำหรับภาพดาวเทียม (Esri World Imagery) และค้นหา (Nominatim)
- ข้อมูลแปลง/จุดปลูก/โครงการทั้งหมดเก็บในเครื่อง (IndexedDB) — ไม่มี backend, ไม่มีบัญชีผู้ใช้ ตามสเปก

## ไฟล์
| ไฟล์ | หน้าที่ |
|---|---|
| index.html / styles.css | shell (mobile bottom-sheet / desktop sidebar) |
| js/geo.js | projection WGS84→เมตร, พื้นที่, หน่วยไร่/งาน/ตร.ว., point-in-polygon |
| js/grid.js | จุดปลูกสามเหลี่ยมด้านเท่า (ระยะแถว s×√3/2), stagger, buffer/holes, spatial hash |
| js/state.js | โมเดลข้อมูล + undo/redo (op prev/next) + validation + summary |
| js/mapui.js | Leaflet: วาด/แก้ polygon, ต้น, ต้นวัดระยะ/พื้นที่, origin grid |
| js/io.js | JSON backup, GeoJSON, CSV export/import, วางพิกัดข้อความ |
| js/storage.js | IndexedDB (+localStorage fallback) |

## ผลการทดสอบจริง (ทำใน session นี้)
- **Node unit 20/20**: A1–A6 (ระยะต้น 9.0000 ม. / แถว 7.79423 ม. / stagger 4.5 ม. เทียบเกณฑ์ 1e-2), B1–B5 (polygon ทุกทรง, holes, buffer, self-intersect), C (1 ไร่=1,600 m²; 2,500 m² = 1 ไร่ 2 งาน 25 ตร.ว.), D (spatial index), E1–E6 (JSON/CSV/GeoJSON roundtrip + ไฟล์ผิดถูกปฏิเสธโดยไม่ทำลายข้อมูลเดิม)
- **Browser E2E 20/20** (Chromium headless): วาดแปลงด้วยเมาส์จริง → พื้นที่ 20,379 m² ตรงจริง · คำนวณ 275 ต้น ผ่าน UI → min gap วัดใหม่ = 9.00 ม. · เพิ่ม/ลบ/undo จุดมือ · ตรวจผิดระยะห่าง (<9 m → แดง + ตัวนับสรุป) · พื้นที่เว้นปลูกตัด 400 m² พอดี · บันทึก→รีเฟรช→โหลดกลับจาก IndexedDB · measure tool · console errors = 0 · layout มือถือ 390px ทำงาน

## ข้อจำกัดที่เหลือ (ตามจริง)
- ต้องต่อเน็ตสำหรับ tile/ค้นหา (ระบุชัดตามสเปกข้อ 15) — ข้อมูลในเครื่องยังอยู่/บันทึกได้แม้เน็ตหลุด
- PDF map สำหรับพิมพ์ = ฟังก์ชันเสริม ยังไม่ทำ (สเปกอนุญาต)
- KML = ส่วนเสริม ยังไม่ทำ
- หน่วยพื้นที่ไทยปัดเศษ ทศนิยมเฉพาะตร.ว. (≤0.05 ตร.ว.)
- ทดสอบบน Chromium/Android emulation ใน sandbox — แนะนำลอง Safari/iOS จริงก่อนใช้ภาคสนาม
