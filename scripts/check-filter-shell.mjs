#!/usr/bin/env node
/**
 * حارس اعتماد `FilterShell` — يمنع بناء «مساحة الفلاتر» يدوياً في `client/src/pages/**`.
 *
 * السبب (بلاغ المالك ١/٩/٢٦): «مساحة الفلاتر ليست بمكوّن واحد ولا تصميمها وترتيبها بمكوّن
 * واحد ولا مطبَّق على الجميع». المسح أثبته: ٨١ صفحة فيها منطقة فلترة، و**٤٣ توقيع شبكة
 * مختلفاً** لمفهومٍ واحد، وثلاث صياغات لزرّ التصفير نفسه.
 *
 * ما يُمسَك هنا: **مفردات الفلاتر المكتوبة يدوياً** — وهي البصمة الوحيدة التي لا تُنتج
 * إنذاراً كاذباً. الشاشة التي تكتب «مسح الفلاتر» بنفسها هي بالضرورة شاشةٌ تبني غلافها
 * ورأسها وزرّها يدوياً؛ والشاشة التي تعتمد `FilterShell` تأخذ النصّ من `FILTER_LABELS`
 * فلا تكتبه أصلاً. ⇒ إخراج ملفٍّ من خطّ الأساس **يستلزم** تبنّي المكوّن.
 *
 * ⚠️ التعليقات تُجرَّد قبل المطابقة: النثر العربيّ في هذا المستودع يذكر «مسح الفلاتر»
 * توثيقياً في ٦ مواضع على الأقلّ. حارسٌ يُنذر على تعليقٍ يُتجاوَز فيصير مسرحياً
 * (الدرس مسجَّل في CLAUDE.md §٤-ج).
 *
 * المِسنَنة **تنازلية** (scripts/ratchet-core.mjs): الأساس يُخفَّض أو يبقى، ولا يُرفَع.
 * التحديث بعد الترحيل: node scripts/check-filter-shell.mjs --update-baseline
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertMonotonicDescent } from "./ratchet-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(REPO_ROOT, "client", "src", "pages");
const BASELINE_PATH = path.join(__dirname, "filter-shell-baseline.json");
const BASELINE_REL = "scripts/filter-shell-baseline.json";
const UPDATE = process.argv.includes("--update-baseline");

const BASELINE = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : {};

/**
 * شاشاتٌ **خارج نطاق نظام مكوّنات الإدارة عمداً** — لا تُعدّ ديناً ولا تُنتظَر هجرتها.
 *
 * `Storefront.tsx` واجهةُ زبونٍ عامّة: هويّةٌ بصريّة مستقلّة (ألوانٌ ثابتة لا توكنز)، و**عقدُ
 * تخزينٍ مسبق للعمل دون اتصال** يفرضه `verify-storefront-pwa-build.mjs`. سحبُ مكوّنات
 * الإدارة إليها (Radix Select ومعه uiContracts) أسقط بناءَ الإنتاج فعلياً على PR #931
 * بـ`STOREFRONT_PRECACHE_STATIC_IMPORT_MISSING`، وكان سيُثقل حزمةَ الزبون دون اتصال
 * بلا مقابل: منتقياتُها الأصلية تعمل وتطابق تصميمها.
 */
const OUT_OF_SCOPE = new Set(["client/src/pages/Storefront.tsx"]);

/** مفردات الفلاتر التي يجب أن تأتي من `FILTER_LABELS` لا من الشاشة. */
const FILTER_VOCAB = [
  "مسح الفلاتر",
  "مسح كل الفلاتر",
  "مسح الفلترة",
  "تصفير الفلاتر",
  "إعادة تعيين الفلاتر",
];

/**
 * يجرّد التعليقات (سطرية/كتلية/JSX) قبل المطابقة.
 * بسيطٌ عمداً: لا يحلّل السلاسل النصّية — ولو ابتلع تعليقاً داخل نصّ، فالاتجاه آمن
 * (تقليل الإنذار الكاذب) لا العكس.
 */
function stripComments(source) {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ") // {/* ... */}
    .replace(/\/\*[\s\S]*?\*\//g, " ") // /* ... */
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 "); // // ...  (يتجنّب https://)
}

function* walkTsx(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["__tests__", "node_modules", "_legacy", "dist"].includes(entry.name)) continue;
      yield* walkTsx(full);
    } else if (entry.isFile() && /\.tsx$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      yield full;
    }
  }
}

const relOf = (full) => path.relative(REPO_ROOT, full).replace(/\\/g, "/");

const current = new Map();
for (const file of walkTsx(SCAN_ROOT)) {
  const rel = relOf(file);
  const code = stripComments(readFileSync(file, "utf8"));
  /*
   * إعفاءان — والعقد الحقيقيّ هو **ألّا تُكتب المفردة يدوياً**، لا «تبنَّ مكوّناً بعينه»:
   *   ١) **استعمال** `<FilterShell>` فعلياً (يأخذ نصّه من القاموس داخلياً). القياس على
   *      الاستعمال لا الاستيراد: برميل `@/components/list` يُصدّر أيضاً `ListToolbar`
   *      و`RowActions`، فإعفاءٌ بالاستيراد كان يُعفي `WorkOrders.tsx` بلا وجه حقّ.
   *   ٢) قراءة `FILTER_LABELS` مباشرةً — وهي الحالة المشروعة لزرّ تصفيرٍ خارج بطاقة
   *      الفلاتر، مثل زرّ «مسح الفلاتر» داخل **حالة الفراغ** (`Suppliers.tsx`).
   *      إلزامُ تلك الحالة بـFilterShell كان سيكون خطأً: لا بطاقةَ فلاتر هناك أصلاً.
   */
  if (
    OUT_OF_SCOPE.has(rel) ||
    /<FilterShell[\s/>]/.test(code) ||
    /FILTER_LABELS/.test(code)
  ) continue;
  let hits = 0;
  for (const phrase of FILTER_VOCAB) {
    hits += (code.match(new RegExp(phrase, "g")) ?? []).length;
  }
  if (hits > 0) current.set(rel, hits);
}

if (UPDATE) {
  const asObj = Object.fromEntries([...current.entries()].sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_PATH, JSON.stringify(asObj, null, 2) + "\n", "utf8");
  const total = [...current.values()].reduce((s, n) => s + n, 0);
  console.log(`✓ حُدِّث خطّ أساس FilterShell: ${current.size} ملفاً · ${total} استعمالاً مجمَّداً.`);
  process.exit(0);
}

const findings = [];
for (const [file, count] of current) {
  const allowed = BASELINE[file] ?? 0;
  if (count > allowed) {
    findings.push(
      allowed === 0
        ? `${file}: ${count} من مفردات الفلاتر مكتوبة يدوياً (الأساس ٠) ⇒ استعمل FilterShell`
        : `${file}: ${count} (الأساس ${allowed}، +${count - allowed})`,
    );
  }
}

const descent = assertMonotonicDescent({
  baselinePath: BASELINE_REL,
  baseline: BASELINE,
  label: "اعتماد FilterShell",
});
if (!descent.ok) {
  console.error(descent.message);
  process.exit(1);
}

const stale = Object.keys(BASELINE).filter((f) => !current.has(f));

if (findings.length === 0) {
  console.log(`✓ اعتماد FilterShell محفوظ — ${current.size} ملف ضمن خطّ الأساس.`);
  if (!descent.skipped) console.log(descent.message);
  if (stale.length > 0) {
    console.log(`ℹ️  ${stale.length} ملف نظيف يمكن حذفه من ${BASELINE_REL}:`);
    for (const f of stale) console.log(`   - ${f}`);
  }
  process.exit(0);
}

console.error(`✗ اعتماد FilterShell مكسور — ${findings.length} انتهاك:\n`);
for (const f of findings) console.error(`  ${f}`);
console.error(`
القاعدة: مساحة الفلاتر سطحٌ واحد — \`FilterShell\` + \`FilterField\`:

  import { FilterField, FilterShell, SearchField } from "@/components/list";

  <FilterShell columns={3} activeCount={activeCount} onReset={resetAll}>
    <FilterField label="بحث (اسم / SKU / باركود)" wide>
      <SearchField value={q} onChange={setQ} barcode onScan={handleScan} />
    </FilterField>
    <FilterField label="الفرع">
      <AppSelect value={branch} onValueChange={setBranch}>…</AppSelect>
    </FilterField>
  </FilterShell>

المكوّن يوفّر: العنوان + عدّاد المفعَّل + زرّ «${FILTER_VOCAB[0]}» بصياغةٍ واحدة + شبكةً
منطقية (١..٤ أعمدة) + تسميةً ظاهرة لكل حقل — فلا تُكتَب هذه النصوص في الشاشة.

خطّ الأساس (تنازليّ — لا يُرفَع): ${BASELINE_REL}
`);
process.exit(1);
