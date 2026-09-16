#!/usr/bin/env node
// حارس عقد PageHeader — يمسك الانحرافات عن مصدر الحقيقة الوحيد لرأس الصفحة.
//
// السياق: حملة توحيد رأس الصفحة (§٦ من CLAUDE.md، PRs #777-#789) وضعت PageHeader
// كرأس قانونيّ واحد لكل صفحة (breadcrumbs + backHref + h1 + description + actions).
// قبله كانت ٢٣٦ صفحة تتفاوت في: `<h1>` بأنماط مختلفة، روابط «← رجوع» يدوية بمحرف
// السهم الخامّ (يشير إلى الأمام في RTL لا إلى الخلف)، غياب زر «الرئيسية» فيحبس
// المستخدم في شاشة الاستقبال بلا شريط جانبيّ.
//
// قاعدتان يفرضهما هذا الحارس عبر خطّ أساسٍ مجمَّد يُخفَّض كلّ دفعة:
//   ١) نصّ رابط الرجوع الخامّ (`← رجوع للX` / `← الرئيسية` / `← مركز X` / `← العودة`
//      / `← كل X`) — استعمل `<PageHeader backHref="/x" backLabel="رجوع لـX" />`
//      بدلاً منه. المحرف `←` في RTL يشير إلى الأمام (اتّجاه القراءة)، فاستعماله
//      لِ«رجوع» يقلب الدلالة بصرياً.
//   ٢) عنصر `<h1>` مباشرٌ في `client/src/pages/**` خارج مكوّن PageHeader.
//      PageHeader يُصدر `<h1>` واحداً بنمطٍ موحّد. أيّ `<h1>` إضافيّ يخلق تنافساً
//      بصرياً وموضعياً على «رأس الصفحة».
//
// خطّ الأساس المجمَّد: لكلّ ملفٍ فيه انتهاكاتٌ عند تفعيل الحارس، يُسجَّل عدد الانتهاكات
// المتوقّعة. كل دفعة توحيدٍ تُخفّض الرقم؛ عندما يبلغ ٠ يُحذف الملف من القائمة.
// **لا يُسمَح بزيادة العدد**: أيّ ملفٍ يزيد أو يُضاف يُفشل الحارس. المُطلَق: بعد
// إتمام الحملة، خطّ الأساس فارغ = لا انتهاكات مستقبلاً.
//
// النطاق: client/src/pages/**/*.tsx حصراً (تجاهُل tests و_legacy).
//
// الاستثناءات المدروسة:
//   - POS.tsx و PrintPOS.tsx: شاشات كاشير كامل الشاشة بنمطٍ خاصّ (لا شريط جانبيّ
//     ولا PageHeader). «← الرئيسية» فيهما مقصود ⇒ في allowlist.
//   - Reception.tsx: أعلى الملف يستعمل PageHeader فعلاً؛ السطر ٢٢٦٢ داخل شاشة
//     دخول جانبية (كاشير الاستقبال). في allowlist مع سببٍ.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(REPO_ROOT, "client", "src", "pages");

// نصوص «رجوع» الخامّة — كلها تبدأ بالسهم `←` ثم نصّ عربيّ.
// المحرف يُقاس بحرفيته لا بـregex معقّد كي يبقى الحارس شفّافاً.
const BACK_ARROW_TEXTS = [
  "← رجوع",       // الأكثر شيوعاً: `← رجوع`, `← رجوع للقائمة`, `← رجوع للمشتريات`، إلخ.
  "← الرئيسية",   // `← الرئيسية` — بديل عن homeHref
  "← مركز",       // `← مركز التقارير`
  "← العودة",     // `← العودة إلى X`
  "← كل",         // `← كل الأصول`, `← كل الفواتير`
];

// شاشات كاشير كامل الشاشة (مقصود بلا PageHeader).
// ملاحظة Codex الصائبة (PR #795): كان Reception.tsx كامله في الـallowlist — فأيّ `← رجوع`
// جديد يُضاف لأقسام الصفحة الأخرى (٢٢٠٠+ سطر) يمرّ صامتاً. نقلناه إلى `RAW_BACK_BASELINE`
// بعدّه الحقيقيّ (١) بحيث الحارس يمسك أيّ زيادة على تلك الحالة الواحدة المقصودة (السطر ٢٢٦٢:
// «← الرئيسية» داخل شاشة كاشير جانبية بلا شريط جانبيّ).
const RAW_BACK_ALLOW = new Set([
  "client/src/pages/POS.tsx",
  "client/src/pages/PrintPOS.tsx",
]);

/**
 * خطّ أساسٍ مجمَّد: عدد أسطر النصّ الخامّ لِـ«رجوع» في كلّ ملف عند تفعيل الحارس.
 * يُقرأ من `ls scripts/check-page-header-contract.mjs` + `git blame` — لا يُعدَّل
 * إلا في PR توحيد يُخفّضه. المفتاح مسار relative بشرطة مائلة (unix).
 */
const RAW_BACK_BASELINE = {
  // Reception.tsx (السطر ٢٢٦٢): «← الرئيسية» داخل شاشة كاشير جانبية بلا شريط جانبيّ — مقصود.
  // تنبيه Codex: نقلناه من allowlist إلى baseline كي يمسك الحارس أيّ زيادة جديدة على الأقسام
  // الأخرى من هذه الصفحة الضخمة (٢٢٠٠+ سطر).
  "client/src/pages/Reception.tsx": 1,
};

/**
 * خطّ أساسٍ ثانٍ: عدد `<h1` مباشر خارج PageHeader في كلّ ملف.
 * يُقاس بأنّ الملف يستورد PageHeader ومع ذلك يحوي `<h1` خامّاً، أو لا يستورده
 * ويحوي `<h1` خامّاً. الاستثناء الوحيد: PageHeader.tsx نفسه.
 *
 * المصدر: `grep -rE '^\s*<h1\s' client/src/pages/` = ٢٧ حالة في ٢٣ ملف عند التفعيل.
 *
 * ⚠️ **ما بقي هنا بقي بقرارٍ لا بتقصير** (فحصٌ موضعيّ ٢/٩/٢٦، موجةُ ذيل التوحيد). صُنّف كلّ
 * مدخلٍ يدوياً، فلا يُعيد أحدٌ استقصاءه ولا يُحوّله آلياً ظنّاً أنّه دَيْنٌ متبقٍّ:
 *
 *   • **نصٌّ داخل مستند طباعة، ليس JSX** — `ConsignmentSettlements` · `ContractPrices` ·
 *     `WorkOrderNew`: `<h1>` داخل قالبٍ نصّيٍّ يُمرَّر لنافذة طباعة. الحارس يمسكه بـregex
 *     بدائيّ. تحويله إلى `PageHeader` **مستحيلٌ** — لا React في تلك النافذة.
 *
 *   • **صفحاتٌ عامّة خارج هيكل التطبيق** — `JobApply` (تقديمُ توظيفٍ للزائر) ·
 *     `MobileTurnstile` · `Storefront` (وهو `sr-only` أصلاً — عنوانٌ لقارئ الشاشة لا
 *     يُعرَض): لا شريطَ جانبياً ولا مسارَ رجوعٍ ولا هويّةَ نظامٍ داخليّة. `PageHeader` يفرض
 *     هويّةَ لوحةِ الإدارة على صفحةٍ تخاطب زبوناً — وهو ضررٌ لا إصلاح.
 *
 *   • **صفحاتٌ ذاتُ هويّةٍ بصريّة خاصّة** — `Dashboard` (رأسٌ مُثيَّمٌ بكائن `T` بأسلوبٍ
 *     مستقلّ) · `MobileDesignPreview` (معاينةُ لغةِ تصميمٍ للجوّال — عناوينُه **عيّنةُ
 *     التصميم نفسها** لا رأسَ صفحة): توحيدُها يمحو الشيءَ الذي وُجدت لعرضه.
 *
 *   • **`<h1>` وحيدٌ في شاشةٍ بلا هيكلِ صفحة** — `Inbox` (لوحةٌ بعمودَين بارتفاعٍ كامل،
 *     العنوان في العمود الجانبيّ) · `PointOfSale` (شاشةُ «لا صلاحية») · `Reception`
 *     (طبقةٌ عائمة داخل الكاشير): هذه الشاشات **بلا
 *     `PageHeader` أصلاً**، فـ`<h1>` فيها هو العنوانُ الوحيد — وهو الصحيحُ دلالياً.
 *     إقحامُ رأسٍ موحَّدٍ يأكل ارتفاعاً في شاشاتٍ مصمَّمةٍ لملء النافذة.
 *
 *   • **مسارُ عرضٍ بديل يملك `<h1>` الوحيد لما يُعرَض** — `ReservationsHub` و
 *     `StocktakeNew`: يظهر في الملفّ `<PageHeader>` **و**`<h1>` معاً، فيبدو للوهلة الأولى
 *     تكراراً لعنوانٍ أوّل. وهو ليس كذلك: الاثنان على **مسارَين متنافيَين**.
 *     `StocktakeNew` يخرج مبكّراً إلى `CreatedLinksScreen` (مكوّنٌ مستقلّ بلا `PageHeader`)
 *     فلا يُبلَغ سطرُ `PageHeader` أصلاً حين تُعرَض بطاقةُ النجاح؛ و`ReservationsHub` يتفرّع
 *     بـ`embedded ? … : <PageHeader/>` ومَركَبُه الوحيد `PointOfSale` **بلا `PageHeader`**.
 *     ⇒ إنزالُهما إلى `<h2>` يترك الشاشةَ المعروضة **بصفر `<h1>`** — أي يصنع العيبَ الذي
 *     يدّعي إصلاحه. أمسك ذلك عاملُ الموجة بقراءة مسارات العرض بدل الاكتفاء بوجود الرمزَين
 *     في الملفّ، وهو الفرق بين `grep` على مستوى الملفّ وقراءةِ ما يُعرَض فعلاً.
 *
 * والذي **أُصلح فعلاً** في الموجة: `PlatformAdmin` وحده — رأسُ صفحةٍ حقيقيّ (عنوانٌ وزرُّ
 * خروجٍ في `justify-between`) صار `<PageHeader>` بزرّه في `actions`، وبـ`homeHref={null}`
 * لأنّ المسار خارج `AppLayout` بجلسةٍ منفصلة فرابطُ «الرئيسية» كان سيقود إلى طريقٍ مسدود.
 */
const RAW_H1_BASELINE = {
  // ⬇️ حُذفت خمسةُ ملفّاتٍ من الأساس (٢/٩/٢٦) بعد أن نظّفتها موجاتُ التوحيد:
  // CashRemediation · MyStocktakes · MyStocktakeWorkspace · Treasury · WorkOrderStation
  // ثمّ PlatformAdmin بعد تحويله إلى PageHeader في الموجة نفسها.
  // حذفُها **يشدّ السقّاطة**: عودةُ `<h1>` خامٍّ إليها تكسر CI بدل أن تُبتلَع في سقفٍ قديم.
  "client/src/pages/ConsignmentSettlements.tsx": 1,
  "client/src/pages/ContractPrices.tsx": 1,
  "client/src/pages/Dashboard.tsx": 2,
  "client/src/pages/Inbox.tsx": 1,
  "client/src/pages/JobApply.tsx": 1,
  "client/src/pages/MobileDesignPreview.tsx": 3,
  "client/src/pages/MobileTurnstile.tsx": 1,
  "client/src/pages/PointOfSale.tsx": 1,
  "client/src/pages/Reception.tsx": 1,
  "client/src/pages/ReservationsHub.tsx": 1,
  "client/src/pages/StocktakeNew.tsx": 1,
  "client/src/pages/Storefront.tsx": 1,
  // WorkOrderNew.tsx يحوي <h1>طلب خدمة — معاينة</h1> داخل template string لـ`window.open()`
  // (نافذة طباعة منبثقة، ليس JSX). الحارس يمسكه بـregex بدائيّ. مقصود، ثابت.
  "client/src/pages/WorkOrderNew.tsx": 1,
};

function* walkTsx(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name === "_legacy") continue;
      yield* walkTsx(full);
    } else if (entry.isFile() && /\.tsx$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      yield full;
    }
  }
}

const relOf = (full) => path.relative(REPO_ROOT, full).replace(/\\/g, "/");

const rawBackViolations = new Map();
const rawH1Violations = new Map();

for (const file of walkTsx(SCAN_ROOT)) {
  const rel = relOf(file);
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);

  // القاعدة ١: نصوص «رجوع» الخامّة (بمحرف السهم)
  if (!RAW_BACK_ALLOW.has(rel)) {
    let n = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // تجاهل التعليقات — نبحث عن نصوص فعلية داخل JSX
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      for (const needle of BACK_ARROW_TEXTS) {
        if (line.includes(needle)) { n++; break; }
      }
    }
    if (n > 0) rawBackViolations.set(rel, n);
  }

  // القاعدة ٢: `<h1` مباشر خارج PageHeader — أينما ظهر في السطر، ليس فقط في بدايته.
  // ملاحظة Codex الصائبة (PR #795): كان `^\s*<h1[\s>]` يفوّت `<Card><h1>` أو
  // `{cond && <h1>` — نفس الرأس المكرّر الذي يفرضه الحارس.
  //
  // نتغاضى عن الأسطر التي كلّها تعليق (`//` أو `*` من JSDoc أو بلوك `/*…*/`).
  // ولا نمسك `<h1>` داخل template string HTML لطباعة `w.document.write(...)` — يظهر عادةً
  // بلا شرطة مسبقة داخل backticks متعددة الأسطر. نحدّده بأنّ السطر يحوي backtick قبل `<h1>`.
  let h1Count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    // نطاق مطابقة: `<h1` أينما كان، مع حرف whitespace/`>` بعده لمنع التداخل مع مثل `<h10>`
    if (!/<h1[\s>]/.test(line)) continue;
    // استثناء `<h1>` داخل template literal ` `` ` (HTML طباعة). heuristic: backtick قبل `<h1>`
    // في نفس السطر ⇒ نتغاضى. متعدّد الأسطر يبقى ثغرة صغيرة، لكنّه نمطٌ نادر في الممارسة.
    const h1Idx = line.indexOf("<h1");
    const backtickIdx = line.indexOf("`");
    if (backtickIdx >= 0 && backtickIdx < h1Idx) continue;
    h1Count++;
  }
  if (h1Count > 0) rawH1Violations.set(rel, h1Count);
}

// تحقّق مقابل خطّ الأساس: أيّ ملفٍ زاد عدده = فشل، وأيّ ملفٍ **جديد** = فشل.
const findings = [];

function reconcile(kind, current, baseline, ruleName) {
  // زيادة: نُبلغها انتهاكاً
  for (const [file, count] of current) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) {
      findings.push({
        rule: ruleName,
        file,
        message: allowed === 0
          ? `[${kind}] ${file}: ${count} انتهاك جديد (خطّ الأساس ٠) ⇒ لم يُدرَج في القائمة`
          : `[${kind}] ${file}: ${count} انتهاك (خطّ الأساس ${allowed}) — الزيادة ${count - allowed}`,
      });
    }
  }
  // ملفات في خطّ الأساس اختفت انتهاكاتها ⇒ إبلاغ مفيد (ليس فشلاً): يجب حذفها منه.
  const stale = [];
  for (const file of Object.keys(baseline)) {
    if (!current.has(file)) stale.push(file);
  }
  return stale;
}

const staleRawBack = reconcile("رجوع خامّ", rawBackViolations, RAW_BACK_BASELINE, "raw-back-arrow");
const staleH1 = reconcile("h1 خارج PageHeader", rawH1Violations, RAW_H1_BASELINE, "raw-h1");

if (findings.length === 0) {
  const staleCount = staleRawBack.length + staleH1.length;
  console.log(`✓ عقد PageHeader محفوظ — ${rawBackViolations.size + rawH1Violations.size} ملف ضمن خطّ الأساس.`);
  if (staleCount > 0) {
    console.log(`ℹ️  ${staleCount} ملف نظيف يمكن حذفه من خطّ الأساس داخل scripts/check-page-header-contract.mjs:`);
    for (const f of staleRawBack) console.log(`   - ${f} (raw-back)`);
    for (const f of staleH1) console.log(`   - ${f} (raw-h1)`);
  }
  process.exit(0);
}

console.error(`✗ عقد PageHeader مكسور — ${findings.length} انتهاك:\n`);
for (const f of findings) {
  console.error(`  ${f.message}`);
}
console.error(`
القاعدة:
  ١) لا نصّ «← رجوع/← الرئيسية/← مركز» يدوياً — استعمل:
       <PageHeader title="..." backHref="/x" backLabel="رجوع لـX" homeHref="/" />
  ٢) لا <h1> مباشر في client/src/pages — PageHeader يُصدر <h1> بنمط موحّد.

     الفرق: <h1> عادي = padding/font-size/margin يدويّ متفاوت عبر الشاشات؛ PageHeader
     يُطبّق نمطاً واحداً + دعم أيقونة + وصف + إجراءات + breadcrumbs.

خطّ الأساس المجمَّد يُخفَّض دفعةً دفعة في: scripts/check-page-header-contract.mjs
`);
process.exit(1);
