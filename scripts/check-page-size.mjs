#!/usr/bin/env node
/**
 * حارس حجم الصفحة — يمنع تراكم الصفحات العملاقة في `client/src/pages/**\/*.tsx`.
 *
 * السبب (برنامج v2 §١١ + مقياس الاحتكاك D4): الصفحةُ فوق ١٢٠٠ سطر عملاقةٌ بنيوياً —
 * تتجاوز حدود الفهم البشريّ ومساحة انتباه أدواتِ التحرير، وتُنجب دوالَّ من مئات الأسطر
 * وعشرات مفاتيح `useState`. الشاشة الأسوأ اليوم: ٣٣٢٦ سطر (`Storefront.tsx`)، ودالّةٌ
 * واحدةٌ فيها بـ١٩٧٩ سطراً و٥٥ `useState` (رصدُ خطة v2). كسرُها ليس تجميلاً؛ إنّه استعادة
 * الحدّ الأدنى للقابلية على القراءة والاختبار والنقل إلى المكوّنات المشتركة.
 *
 * ⭐ ما يقيسه بدقّة:
 *   - عدد الأسطر **غير الفارغة وغير التعليقات** لكلّ ملفّ `.tsx` في `client/src/pages/`.
 *   - يستثني `__tests__/**` و`_legacy/**` و`dist/**` والملفّات المُنتهيةَ بـ`.test.tsx`.
 *   - العتبة: **١٢٠٠ سطر** — الملفّ فوقها يدخل خطّ الأساس بعدّه الحاليّ.
 *
 * ⚠️ ما **لا** يقيسه — وحارسٌ يدّعي أكثر ممّا يفعل أسوأ من متواضعٍ صادق:
 *   ١) **تعقيدَ** الدالّة (طولها · عدد `useState` · عدد الأخطّاف): ثلاثتُها في خطة v2 D4
 *      لكنها بصماتٌ مختلفة تحتاج AST — والحارس النصّيّ الذي يظنّ أنّه يقيسها يمرّ بأخطاءَ
 *      كاذبة. تُبنى في حارسٍ منفصل (فجوةٌ مفتوحة أدناه).
 *   ٢) **جودةَ** التقسيم: ملفٌّ ٥٠٠ سطر بدالّةٍ واحدة عملاقة يمرّ هنا؛ الحارس يقيس **الحجم
 *      الإجماليّ للصفحة** لا التوزيعَ داخلها.
 *   ٣) المكوّناتِ الوسيطة في `client/src/components/**`: النطاق هنا `pages/` عمداً —
 *      المكوّناتُ الوسيطة قد تحتاج تجميعاً حقيقياً، وشاشةٌ تفوّض لمكوّنٍ ٤٠٠ سطر أفضلُ من
 *      شاشةٍ ١٢٠٠ سطر تكتب كلَّ شيءٍ يدوياً.
 *
 * المِسنَنة **تنازلية** (scripts/ratchet-core.mjs): الأساس يُخفَّض أو يبقى، ولا يُرفَع أبداً.
 * فرعٌ يُدخِل ملفاً جديداً فوق العتبة، أو يرفع سطورَ ملفٍّ قائمٍ فيه، أو يرفع الأساس ليمرّر
 * الزيادةَ ⇒ يفشل.
 *
 * الاختبار الذاتيّ (--selftest): يُجرّب على ملفَّين مركَّبَين (٥٠٠ يمرّ · ١٥٠٠ يفشل) قبل
 * تشغيل الحارس الحيّ. سلوكُ العدّاد يُثبَت قبل الاعتماد عليه.
 *
 * التحديث بعد الترحيل: node scripts/check-page-size.mjs --update-baseline
 * التقرير وحده (بلا حجب): node scripts/check-page-size.mjs --report
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertMonotonicDescent } from "./ratchet-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(REPO_ROOT, "client", "src", "pages");
const BASELINE_PATH = path.join(__dirname, "page-size-baseline.json");
const BASELINE_REL = "scripts/page-size-baseline.json";

const UPDATE = process.argv.includes("--update-baseline");
const SELFTEST_ONLY = process.argv.includes("--selftest");
const REPORT_ONLY = process.argv.includes("--report");

/** العتبة الحاكمة — من خطة v2 §١١ ومقياس الاحتكاك D4. */
export const PAGE_SIZE_THRESHOLD = 1200;

/**
 * يجرّد التعليقات (سطرية/كتلية/JSX) قبل العدّ. بسيطٌ عمداً على نمط `check-friction.mjs`:
 * لا يحلّل السلاسل النصّية — لو ابتلع تعليقاً داخل نصّ فالاتجاه آمنٌ (تقليلُ الإنذار
 * الكاذب) لا العكس.
 */
export function stripComments(source) {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** يعدّ الأسطر غير الفارغة بعد تجريد التعليقات. */
export function countCodeLines(source) {
  const stripped = stripComments(source);
  let n = 0;
  for (const line of stripped.split(/\r?\n/)) {
    if (line.trim().length > 0) n++;
  }
  return n;
}

const SKIP_DIRS = new Set(["__tests__", "node_modules", "_legacy", "dist", ".git", "coverage"]);

function* walkTsx(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkTsx(full);
    } else if (
      entry.isFile() &&
      /\.tsx$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      yield full;
    }
  }
}

const relOf = (full) => path.relative(REPO_ROOT, full).replace(/\\/g, "/");

// ───────────────────────────── الاختبار الذاتيّ ─────────────────────────────

function runSelfTest({ quiet }) {
  const fails = [];
  const eq = (name, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      fails.push(`${name}: توقّعنا ${JSON.stringify(want)} فجاء ${JSON.stringify(got)}`);
    }
  };

  // (١) ملفّ ٥٠٠ سطر يمرّ العتبة.
  const smallSrc = Array.from({ length: 500 }, (_, i) => `const x${i} = ${i};`).join("\n");
  const smallCount = countCodeLines(smallSrc);
  eq("عدّ ملفّ ٥٠٠ سطر = ٥٠٠", smallCount, 500);
  eq("ملفّ ٥٠٠ سطر تحت العتبة", smallCount > PAGE_SIZE_THRESHOLD, false);

  // (٢) ملفّ ١٥٠٠ سطر يفشل العتبة.
  const largeSrc = Array.from({ length: 1500 }, (_, i) => `const y${i} = ${i};`).join("\n");
  const largeCount = countCodeLines(largeSrc);
  eq("عدّ ملفّ ١٥٠٠ سطر = ١٥٠٠", largeCount, 1500);
  eq("ملفّ ١٥٠٠ سطر فوق العتبة", largeCount > PAGE_SIZE_THRESHOLD, true);

  // (٣) الأسطر الفارغة لا تُعدّ.
  eq("سطران فارغان لا يُعدّان", countCodeLines("a\n\n\nb"), 2);

  // (٤) التعليقات السطرية والكتلية تُطرح.
  eq("التعليق السطريّ يُجرَّد", countCodeLines("const a = 1;\n// عدّاد\nconst b = 2;"), 2);
  eq(
    "التعليق الكتليّ يُجرَّد",
    countCodeLines("const a = 1;\n/* شرح\n متعدّد الأسطر */\nconst b = 2;"),
    2,
  );

  // (٥) `assertMonotonicDescent` قابلٌ للاستدعاء وموقَّعٌ صحيحاً.
  eq("assertMonotonicDescent دالّة", typeof assertMonotonicDescent, "function");

  if (fails.length > 0) {
    console.error("✗ الاختبار الذاتيّ لحارس حجم الصفحة فشل:\n");
    for (const f of fails) console.error(`  ${f}`);
    process.exit(1);
  }
  if (!quiet) console.log("✓ الاختبار الذاتيّ لحارس حجم الصفحة: كلّ الحالات سليمة.");
}

// ───────────────────────────── التنفيذ ─────────────────────────────

runSelfTest({ quiet: !SELFTEST_ONLY });
if (SELFTEST_ONLY) process.exit(0);

const baseline = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : {};

/** خريطة `{ path: lineCount }` لكلّ ملفّ **فوق العتبة** اليوم. */
const current = {};
const allSizes = new Map();
for (const file of walkTsx(SCAN_ROOT)) {
  const rel = relOf(file);
  const n = countCodeLines(readFileSync(file, "utf8"));
  allSizes.set(rel, n);
  if (n > PAGE_SIZE_THRESHOLD) current[rel] = n;
}

const sortedCurrent = Object.fromEntries(
  Object.entries(current).sort(([a], [b]) => a.localeCompare(b)),
);

if (UPDATE) {
  writeFileSync(BASELINE_PATH, JSON.stringify(sortedCurrent, null, 2) + "\n", "utf8");
  const total = Object.values(sortedCurrent).reduce((s, n) => s + n, 0);
  console.log(
    `✓ حُدِّث خطّ الأساس: ${Object.keys(sortedCurrent).length} صفحة فوق ${PAGE_SIZE_THRESHOLD} سطر · مجموع ${total}.`,
  );
  process.exit(0);
}

if (REPORT_ONLY) {
  console.log(
    `تقرير حجم الصفحة (العتبة ${PAGE_SIZE_THRESHOLD}) — ${Object.keys(current).length} صفحة فوق العتبة:\n`,
  );
  const rows = Object.entries(current).sort((a, b) => b[1] - a[1]);
  for (const [file, n] of rows) {
    console.log(`  ${String(n).padStart(5)}  ${file}`);
  }
  process.exit(0);
}

// (١) رصد الانتهاكات: ملفّ جديد فوق العتبة، أو ملفّ قائم ارتفع عن أساسه.
const findings = [];
for (const [file, n] of Object.entries(current)) {
  const allowed = baseline[file];
  if (allowed === undefined) {
    findings.push({
      file,
      message: `${file}: ${n} سطر (جديد فوق العتبة ${PAGE_SIZE_THRESHOLD}) — قسّم الصفحة`,
    });
  } else if (n > allowed) {
    findings.push({
      file,
      message: `${file}: ${n} سطر (الأساس ${allowed}، +${n - allowed}) — الصفحةُ تكبر لا تصغر`,
    });
  }
}

// (٢) المِسنَنة التنازلية: خطّ الأساس المُلتزَم لا يرتفع عن `origin/main`.
const descent = assertMonotonicDescent({
  baselinePath: BASELINE_REL,
  baseline: sortedCurrent,
  label: "حجم الصفحة",
});
if (!descent.ok) {
  console.error(descent.message);
  process.exit(1);
}

// (٣) بلاغ عن الملفّات التي هبطت تحت العتبة (يمكن حذفها من الأساس).
const staleBaseline = Object.keys(baseline).filter((f) => !(f in current));

if (findings.length === 0) {
  console.log(
    `✓ حجم الصفحة محفوظ — ${Object.keys(current).length} صفحة ضمن خطّ الأساس (العتبة ${PAGE_SIZE_THRESHOLD}).`,
  );
  if (!descent.skipped) console.log(descent.message);
  if (staleBaseline.length > 0) {
    console.log(
      `ℹ️  ${staleBaseline.length} صفحة هبطت تحت العتبة — احذفها من خطّ الأساس بـ:`,
    );
    console.log(`   node scripts/check-page-size.mjs --update-baseline`);
    for (const f of staleBaseline) console.log(`   - ${f}`);
  }
  process.exit(0);
}

console.error(`✗ حجم الصفحة — ${findings.length} انتهاك (العتبة ${PAGE_SIZE_THRESHOLD}):\n`);
for (const f of findings) console.error(`  ${f.message}`);
console.error(`
القاعدة: الصفحة فوق ${PAGE_SIZE_THRESHOLD} سطر عملاقةٌ بنيوياً — قسّمها إلى مكوّنات في:
  - client/src/components/<domain>/  (مكوّناتٌ خاصّةٌ بالنطاق)
  - client/src/components/ui/         (مكوّناتٌ مشتركة)

الصفحةُ تُنجب دوالَّ من مئات الأسطر وعشرات \`useState\`، تتجاوز حدود الفهم البشريّ وأدوات
التحرير. برنامج v2 §١١ يُوجّه نحو التقسيم دفعةً دفعة.

إن كان الانتهاك قائماً في origin/main ولم يُدخِله فرعك: التحديث بعد الترحيل فقط:
  node scripts/check-page-size.mjs --update-baseline
`);
process.exit(1);
