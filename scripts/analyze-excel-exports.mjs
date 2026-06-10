// تحليل بنية ملفات تصدير النظام القديم — أعمدة + عيّنات + إحصاءات
// يُشغَّل يدوياً: node scripts/analyze-excel-exports.mjs > excel-analysis.json
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";

const dir = "D:\\مراجعات اكسل";
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".xlsx"));
const out = {};

for (const f of files) {
  const wb = XLSX.read(readFileSync(join(dir, f)), { type: "buffer", cellDates: true });
  const fileInfo = { sheets: {} };
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
    if (!rows.length) {
      fileInfo.sheets[sheetName] = { empty: true };
      continue;
    }
    // ابحث عن صف الرؤوس: أول صف فيه أكثر من خلية نصية غير فارغة
    let headerIdx = 0;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const nonEmpty = (rows[i] || []).filter((c) => c !== null && String(c).trim() !== "");
      if (nonEmpty.length >= 3) { headerIdx = i; break; }
    }
    const headers = (rows[headerIdx] || []).map((h) => (h === null ? "(فارغ)" : String(h).trim()));
    const dataRows = rows.slice(headerIdx + 1).filter((r) => (r || []).some((c) => c !== null && String(c).trim() !== ""));
    // إحصاءات لكل عمود: نسبة الامتلاء + أمثلة قيم فريدة
    const colStats = headers.map((h, ci) => {
      const vals = dataRows.map((r) => (r || [])[ci]).filter((v) => v !== null && String(v).trim() !== "");
      const uniq = [...new Set(vals.map(String))];
      return {
        header: h,
        filled: vals.length,
        fillPct: dataRows.length ? Math.round((vals.length / dataRows.length) * 100) : 0,
        uniqueCount: uniq.length,
        samples: uniq.slice(0, 6),
        maxLen: vals.reduce((m, v) => Math.max(m, String(v).length), 0),
      };
    });
    fileInfo.sheets[sheetName] = {
      headerRowIndex: headerIdx,
      preHeaderRows: rows.slice(0, headerIdx).map((r) => (r || []).filter((c) => c !== null)),
      totalDataRows: dataRows.length,
      columns: colStats,
      sampleRows: dataRows.slice(0, 3),
    };
  }
  out[f] = fileInfo;
}

writeFileSync("excel-analysis.json", JSON.stringify(out, null, 1), "utf8");
console.log("تم: excel-analysis.json — ملفات:", files.length);
