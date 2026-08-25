#!/usr/bin/env node
// حارس اعتماد `printReportDoc` — يمنع `window.print()` مباشرة في `client/src/pages/**`.
//
// السبب: قوالب الطباعة المشتركة (`client/src/lib/printing/reportDoc.ts` وأخواتها) توحّد:
//   - هويّة الشركة في رأس المستند + فلاتر النشطة في headerExtra
//   - CSS طباعة A4 مع فواصل صفحات صحيحة (page-break)
//   - رسالة عربية موحّدة عند حجب النافذة المنبثقة (`notify.err` مركزيّ)
//   - إخفاء أزرار الأدوات (`data-page-header-actions`, `.list-toolbar-actions`)
//
// كلّ `window.print()` مباشرة في صفحة يفوّت واحداً أو أكثر من هذه الضمانات:
//   • قد يطبع رأس الصفحة والفلاتر والأزرار (تخطيط قذر على الورق)
//   • قد يفشل صامتاً حين يحجب المتصفّح popup (المستخدم يظنّ الطباعة تمّت)
//   • لا يحمل هوية الشركة على المستند
//
// النطاق: `client/src/pages/**/*.tsx` حصراً. المكوّنات المشتركة (`client/src/components/`) قد
// تحتوي على `window.print()` مشروع (نافذة معاينة قبل الطباعة، محرّرات، إلخ).
//
// خطّ أساسٍ مجمَّد في `scripts/window-print-baseline.json` — يفشل الحارس **فقط** عند الزيادة أو
// عند ملف جديد. يُخفَّض عبر الترحيل إلى `printReportDoc` وحذف السطر.
//
// لتحديث الأساس: `node scripts/check-window-print.mjs --update-baseline`.

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(REPO_ROOT, "client", "src", "pages");
const BASELINE_PATH = path.join(__dirname, "window-print-baseline.json");
const UPDATE = process.argv.includes("--update-baseline");

const BASELINE = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : {};

function* walkTsx(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name === "_legacy" || entry.name === "dist") continue;
      yield* walkTsx(full);
    } else if (entry.isFile() && /\.tsx$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      yield full;
    }
  }
}

const relOf = (full) => path.relative(REPO_ROOT, full).replace(/\\/g, "/");

// نطاق مطابقة: `window.print()` مباشرة، بأيّ سياق (JSX/JS/template string).
// نتجاهل استعمال داخل تعليق ككلمة مفتاحية.
const PRINT_RE = /window\.print\(\)/g;

const current = new Map();
for (const file of walkTsx(SCAN_ROOT)) {
  const rel = relOf(file);
  const text = readFileSync(file, "utf8");
  // نستبعد تعليقات // ملغية بالسطر — نمسح كل سطر أوّلاً، ونتجاوز أسطر التعليق الكاملة.
  const lines = text.split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    const m = line.match(PRINT_RE);
    if (m) count += m.length;
  }
  if (count > 0) current.set(rel, count);
}

if (UPDATE) {
  const asObj = Object.fromEntries([...current.entries()].sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_PATH, JSON.stringify(asObj, null, 2) + "\n", "utf8");
  const total = [...current.values()].reduce((s, n) => s + n, 0);
  console.log(`✓ حُدِّث خطّ الأساس: ${current.size} ملفاً · ${total} استعمالاً مجمَّداً.`);
  process.exit(0);
}

const findings = [];
for (const [file, count] of current) {
  const allowed = BASELINE[file] ?? 0;
  if (count > allowed) {
    findings.push({
      file,
      message: allowed === 0
        ? `${file}: ${count} استعمال جديد لـwindow.print() (خطّ الأساس ٠) ⇒ استعمل printReportDoc`
        : `${file}: ${count} (الأساس ${allowed}، +${count - allowed})`,
    });
  }
}

const staleBaseline = Object.keys(BASELINE).filter((f) => !current.has(f));

if (findings.length === 0) {
  console.log(`✓ اعتماد printReportDoc محفوظ — ${current.size} ملف ضمن خطّ الأساس.`);
  if (staleBaseline.length > 0) {
    console.log(`ℹ️  ${staleBaseline.length} ملف نظيف يمكن حذفه من الأساس:`);
    for (const f of staleBaseline) console.log(`   - ${f}`);
  }
  process.exit(0);
}

console.error(`✗ استعمال window.print() جديد — ${findings.length} انتهاك:\n`);
for (const f of findings) console.error(`  ${f.message}`);
console.error(`
القاعدة: استعمل \`printReportDoc\` من \`@/lib/printing/reportDoc\` بدل \`window.print()\` مباشرة:

  import { printReportDoc } from "@/lib/printing/reportDoc";
  printReportDoc({
    title: "تقرير المبيعات",
    headerExtra: [{ label: "الفرع", value: "الرئيسي" }, { label: "الفترة", value: "2026-06" }],
    columns: [{ key: "num", label: "الرقم" }, { key: "total", label: "الإجمالي", align: "left" }],
    rows: filteredData,
    summary: [{ label: "الإجمالي", value: totalStr, large: true, bold: true }],
  });

يوحّد هويّة المستند + رسالة عربية عند حجب popup + إخفاء أزرار الأدوات على الورق.

للتحديث بعد الترحيل: node scripts/check-window-print.mjs --update-baseline
`);
process.exit(1);
