#!/usr/bin/env node
// حارس قاعدة «الأرقام لاتينية دائماً» — قرار المالك ٢٥/٨/٢٦.
//
// كل رقم يعرضه النظام (شاشات/تقارير/طباعة/تصدير) لاتينيّ بفواصل غربية `123,456.78` لا
// هندية `١٢٣٬٤٥٦٫٧٨`. القاعدة **مطلقة** بقرار المالك:
//   - الموظفون يقرؤون الأرقام العربية-الهندية بصعوبة
//   - التصدير إلى Excel/PDF يصير مقروءاً أفضل باللاتيني
//   - مطابقة كشوف البنوك والفواتير المطبوعة تلزم اللاتيني
//
// النمط الوحيد المسموح:
//   - `toLocaleString("ar-IQ-u-nu-latn", …)` — locale عربي + خانة أرقام لاتينية
//   - `Intl.NumberFormat("ar-IQ-u-nu-latn", …)` — نفس الشيء
//   - `toLocaleString("en-US", …)` — لاتيني بالكامل (مقبول للأرقام البحتة)
//
// ⛔ مرفوض:
//   - `toLocaleString("ar-IQ")` بلا `-u-nu-latn` — يُنتج هندية.
//   - `toLocaleString("ar-EG"|"ar-SA"|…)` بلا `-u-nu-latn`.
//   - `Intl.NumberFormat("ar-…")` بلا `-u-nu-latn`.
//
// النطاق: `client/**/*.tsx?` + `server/**/*.ts` (طباعة/تصدير) + `shared/**/*.ts`.
// نستثني `_legacy/` و`node_modules/` و`dist/`.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOTS = [
  path.join(REPO_ROOT, "client", "src"),
  path.join(REPO_ROOT, "server"),
  path.join(REPO_ROOT, "shared"),
];

// أنماط رفض — تُمسك locales عربية بلا `-u-nu-latn`.
// `ar-IQ`, `ar-EG`, `ar-SA`, `ar-AR`, `ar` وحدها كلها تُنتج أرقاماً هندية.
const BAD_TO_LOCALE = /\.toLocaleString\(\s*["'](ar(?:-[A-Z]{2})?)["']/g;
const BAD_NUMBER_FORMAT = /\bIntl\.NumberFormat\(\s*["'](ar(?:-[A-Z]{2})?)["']/g;

// نتغاضى عن التعليقات المفردة والوثائق (JSDoc).
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function* walkCode(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "_legacy" || entry.name === "dist" || entry.name === "__tests__") continue;
      yield* walkCode(full);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      yield full;
    }
  }
}

const relOf = (full) => path.relative(REPO_ROOT, full).replace(/\\/g, "/");

const findings = [];

for (const root of SCAN_ROOTS) {
  for (const file of walkCode(root)) {
    const rel = relOf(file);
    // نستثني الحارس نفسه (قد يذكر ar-IQ نصّاً في رسائله).
    if (rel === "scripts/check-locale-numbers.mjs") continue;
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentLine(line)) continue;
      // اقتطاع كل نصٍّ بعد `//` في السطر — تعليقٌ خلفيّ قد يذكر `ar-IQ` نصّاً.
      const codeOnly = line.split("//")[0];
      BAD_TO_LOCALE.lastIndex = 0;
      BAD_NUMBER_FORMAT.lastIndex = 0;
      let m;
      while ((m = BAD_TO_LOCALE.exec(codeOnly)) !== null) {
        findings.push({ file: rel, line: i + 1, snippet: line.trim().slice(0, 160), locale: m[1] });
      }
      while ((m = BAD_NUMBER_FORMAT.exec(codeOnly)) !== null) {
        findings.push({ file: rel, line: i + 1, snippet: line.trim().slice(0, 160), locale: m[1] });
      }
    }
  }
}

if (findings.length === 0) {
  console.log(`✓ قاعدة الأرقام اللاتينية محفوظة — لا locale عربي بلا -u-nu-latn.`);
  process.exit(0);
}

console.error(`✗ قاعدة الأرقام اللاتينية مكسورة — ${findings.length} انتهاك:\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  locale="${f.locale}" ⇒ يُنتج أرقاماً هندية`);
  console.error(`    ${f.snippet}`);
}
console.error(`
القاعدة (قرار المالك ٢٥/٨/٢٦): كل رقم يعرضه النظام لاتينيّ.

استعمل:
  toLocaleString("ar-IQ-u-nu-latn", { …})    // ⭐ الموحّد: locale عربيّ + رقم لاتينيّ
  new Intl.NumberFormat("ar-IQ-u-nu-latn", { …})
  toLocaleString("en-US", { …})              // مقبول للأرقام البحتة

⛔ ممنوع:
  toLocaleString("ar-IQ")                    // بلا -u-nu-latn ⇒ ١٢٣٬٤٥٦
  new Intl.NumberFormat("ar-EG", …)          // نفس المشكلة

مساعدون مركزيّون في client/src/lib/money.ts:
  - fmt(v)     ⇒ en-US بفواصل غربية
  - fmtAr(v)   ⇒ ar-IQ-u-nu-latn (locale عربي + رقم لاتيني)
  - fmtInt(v)  ⇒ ar-IQ-u-nu-latn عدد صحيح
  - formatIqd(v) ⇒ fmtAr + " د.ع"
`);
process.exit(1);
