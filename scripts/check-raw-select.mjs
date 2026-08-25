#!/usr/bin/env node
// حارس اعتماد AppSelect — يمنع `<select>` HTML خامّاً جديداً في `client/src/pages/**`.
//
// السبب: `<select>` الأصليّ يظهر مقتطعاً في Chromium (تدقيق ٣١/٧/٢٦: القوائم المنسدلة تُقصّ
// أسفل الـviewport). البديل `AppSelect` من `@/components/ui/AppSelect`:
//   - عرض popup يطابق الـtrigger (بلا اقتصاص)
//   - حبس تركيز + تنقّل كامل بلوحة المفاتيح (Type-ahead)
//   - RTL-aware + حسّاس لـ`data-theme`
//   - نظام ألوان النظام (بدل style افتراضي المتصفّح المتباين)
//   - API قريب من `<select>`: `onValueChange={setX}` بدل `onChange={(e) => setX(e.target.value)}`
//
// النطاق: `client/src/pages/**/*.tsx`. المكوّنات المشتركة (`client/src/components/**`) خارج النطاق
// (بعض المكوّنات المخصّصة تلفّ `<select>` عمداً لسبب معيّن — تلك تُقيَّم فرديّاً).
//
// خطّ الأساس مجمَّد في `scripts/raw-select-baseline.json` — يُخفَّض بالترحيل إلى AppSelect.
// `--update-baseline` يعيد التوليد.

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(REPO_ROOT, "client", "src", "pages");
const BASELINE_PATH = path.join(__dirname, "raw-select-baseline.json");
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

// نطاق مطابقة: `<select` في بداية سطر (بعد whitespace فقط) — يمسك JSX الحقيقيّ.
// السطور بحرف قبل `<select` (مثلاً داخل نصّ/تعليق أو داخل props) لا تُعدّ انتهاكاً.
const SELECT_RE = /^\s*<select[\s>]/gm;

const current = new Map();
for (const file of walkTsx(SCAN_ROOT)) {
  const rel = relOf(file);
  const text = readFileSync(file, "utf8");
  // اقتطاع كل التعليقات المفردة (بدون سطر عدة استعمالات، لأنّ التعليق قد يذكر `<select>` نصّاً).
  const lines = text.split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    if (/^\s*<select[\s>]/.test(line)) count++;
  }
  if (count > 0) current.set(rel, count);
}

if (UPDATE) {
  const asObj = Object.fromEntries([...current.entries()].sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_PATH, JSON.stringify(asObj, null, 2) + "\n", "utf8");
  const total = [...current.values()].reduce((s, n) => s + n, 0);
  console.log(`✓ حُدِّث خطّ الأساس: ${current.size} ملفاً · ${total} <select> مجمَّداً.`);
  process.exit(0);
}

const findings = [];
for (const [file, count] of current) {
  const allowed = BASELINE[file] ?? 0;
  if (count > allowed) {
    findings.push({
      file,
      message: allowed === 0
        ? `${file}: ${count} <select> جديد (خطّ الأساس ٠) ⇒ استعمل AppSelect`
        : `${file}: ${count} <select> (الأساس ${allowed}، +${count - allowed})`,
    });
  }
}

const stale = Object.keys(BASELINE).filter((f) => !current.has(f));

if (findings.length === 0) {
  console.log(`✓ اعتماد AppSelect محفوظ — ${current.size} ملف ضمن خطّ الأساس.`);
  if (stale.length > 0) {
    console.log(`ℹ️  ${stale.length} ملف نظيف يمكن حذفه من الأساس:`);
    for (const f of stale) console.log(`   - ${f}`);
  }
  process.exit(0);
}

console.error(`✗ استعمال <select> جديد — ${findings.length} انتهاك:\n`);
for (const f of findings) console.error(`  ${f.message}`);
console.error(`
القاعدة: استعمل \`AppSelect\` من \`@/components/ui/AppSelect\`:

  import { AppSelect } from "@/components/ui/AppSelect";
  <AppSelect value={branchId} onValueChange={setBranchId} placeholder="اختر الفرع">
    {branches.map(b => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
  </AppSelect>

الفوائد: popup غير مقتطع + لوحة مفاتيح كاملة + RTL + dark mode + توكنز النظام.

للتحديث بعد الترحيل: node scripts/check-raw-select.mjs --update-baseline
`);
process.exit(1);
