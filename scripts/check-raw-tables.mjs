#!/usr/bin/env node
// حارس اعتماد DataTable — يمنع إضافة `<table>` خامّة جديدة في `client/src/pages/**`.
//
// السبب: DataTable المشترك (`client/src/components/data-table/DataTable.tsx`) يوحّد:
//   - الترقيم (محلّيّ/خادميّ) بلا فقدٍ صامتٍ للصفوف بعد سقف limit
//   - البحث (محلّيّ/خادميّ) مع منع الجمع بين ترقيمٍ خادميٍّ وبحثٍ محلّي
//   - حالات التحميل/الخطأ/الفارغ بأنماط ثابتة (TableSkeleton/ErrorState/EmptyState)
//   - التمييز الصريح NO_ROWS_YET vs NO_MATCH_FILTER (المصدر: shared/emptyStateMessages.ts)
//   - إمكانية الوصول: role, aria-*, hover، وضع فرز خادميّ آمن
//   - نسخ TSV للحافظة، حفظ إعدادات الأعمدة، MobileDataCard للجوّال
//
// كلّ `<table>` خامّة تُعيد كتابة جزءٍ من هذا يدوياً ⇒ انحرافٌ بصريّ وسلوكيّ.
//
// النطاق: `client/src/pages/**/*.tsx` حصراً (المكوّنات المشتركة قد تحتاج جدولاً بسيطاً بنيوياً).
//
// خطّ أساسٍ مجمَّد لكل ملف — يفشل الحارس **فقط** عند الزيادة (ملف جديد أو زيادة عدد `<table>`).
// يُخفَّض دفعةً دفعة عبر الترحيل إلى DataTable.
//
// استثناءات مشروعة:
//   - `<table>` داخل template string لطباعة/معاينة (نافذة `window.open`) — تُكتَشَف بأنّها ليست JSX.
//     نستثنيها بكشف بسيط: السطر ينتهي بـ`\` أو ضمن template literal مفتوح (` `` `).

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(REPO_ROOT, "client", "src", "pages");
const BASELINE_PATH = path.join(__dirname, "raw-tables-baseline.json");
const UPDATE = process.argv.includes("--update-baseline");

/**
 * خطّ أساسٍ مجمَّد يُقرأ من `scripts/raw-tables-baseline.json` — عدد `<table>` الخامّة
 * في كل ملف عند تفعيل الحارس (٢٥/٨/٢٦: ١٢٤ ملف). الحارس يفشل فقط عند **الزيادة** أو
 * عند ظهور ملف **جديد**. يُخفَّض عبر الترحيل إلى DataTable وحذف السطر من الملف.
 *
 * لتحديث الأساس بعد ترحيل ملف (`node scripts/check-raw-tables.mjs --update-baseline`):
 * يُعاد توليده كاملاً من الواقع. يُدفَع في PR الترحيل نفسه.
 */
const RAW_TABLE_BASELINE = existsSync(BASELINE_PATH)
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

// نطاق مطابقة: `<table` (مع فراغ أو `>` بعده) — يمسك JSX وHTML template معاً.
// لا نُفرّق: خطّ الأساس يعكس الواقع (بما فيه template)، فأيّ زيادة تُرَى.
const TABLE_RE = /<table[\s>]/g;

const current = new Map();
for (const file of walkTsx(SCAN_ROOT)) {
  const rel = relOf(file);
  const text = readFileSync(file, "utf8");
  const matches = text.match(TABLE_RE);
  if (matches && matches.length > 0) current.set(rel, matches.length);
}

if (UPDATE) {
  const asObj = Object.fromEntries([...current.entries()].sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_PATH, JSON.stringify(asObj, null, 2) + "\n", "utf8");
  const total = [...current.values()].reduce((s, n) => s + n, 0);
  console.log(`✓ حُدِّث خطّ الأساس: ${current.size} ملفاً · ${total} <table> مجمَّداً.`);
  process.exit(0);
}

const findings = [];
for (const [file, count] of current) {
  const allowed = RAW_TABLE_BASELINE[file] ?? 0;
  if (count > allowed) {
    findings.push({
      file,
      message: allowed === 0
        ? `${file}: ${count} <table> جديد (خطّ الأساس ٠) ⇒ استعمل DataTable`
        : `${file}: ${count} <table> (الأساس ${allowed}، +${count - allowed})`,
    });
  }
}

// إبلاغ عن الملفات النظيفة التي كانت في الأساس (للمساعدة على تخفيضه بعد الترحيل)
const staleBaseline = Object.keys(RAW_TABLE_BASELINE).filter((f) => !current.has(f));

if (findings.length === 0) {
  console.log(`✓ اعتماد DataTable محفوظ — ${current.size} ملف ضمن خطّ الأساس.`);
  if (staleBaseline.length > 0) {
    console.log(`ℹ️  ${staleBaseline.length} ملف نظيف يمكن حذفه من خطّ الأساس في scripts/check-raw-tables.mjs:`);
    for (const f of staleBaseline) console.log(`   - ${f}`);
  }
  process.exit(0);
}

console.error(`✗ اعتماد DataTable مكسور — ${findings.length} انتهاك:\n`);
for (const f of findings) {
  console.error(`  ${f.message}`);
}
console.error(`
القاعدة: استعمل \`<DataTable>\` من \`@/components/data-table/DataTable\` بدل \`<table>\` خامّة:

  <DataTable
    columns={cols}
    data={rows}
    resourceKey="invoices"        // للتمييز الصريح NO_ROWS_YET vs NO_MATCH_FILTER
    errorState={{ isError: q.isError, onRetry: q.refetch }}
    loading={q.isLoading}
    serverPagination={{ page, onPageChange: setPage, pageSize: PAGE_SIZE, total }}
    serverSearch={{ value: q, onChange: setQ }}
  />

للحالات التي تحتاج جدولاً بنيوياً بسيطاً (لا قائمة قابلة للترقيم): استعمل مكوّنات \`@/components/ui/table\`
(Table/TableHeader/TableBody) + \`tableStyles\` (TABLE_HEAD_CLS/TABLE_ROW_HOVER_CLS/TABLE_TFOOT_CLS).

خطّ الأساس يُخفَّض دفعةً دفعة في: scripts/check-raw-tables.mjs
`);
process.exit(1);
