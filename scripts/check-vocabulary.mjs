#!/usr/bin/env node
/**
 * حارس المفردات الموحّدة — «قاموسٌ عربيّ محلّيّ لطريقة الدفع أو القناة» يجب أن يذهب.
 *
 * ═══════════════════════ لماذا وُجد هذا الحارس ═══════════════════════
 * `shared/terms.ts` مصدرُ الحقيقة الوحيد لمفهومَين: **القناة** و**طريقة الدفع** (٢/٩/٢٦،
 * دُمج في #961). جدولُ الانحرافات في رأس ذاك الملفّ يعدّ **١٤ قاموساً محلّياً لطريقة الدفع
 * في `client/**` وحدها**، مع ٥ قيمٍ تحمل اسمَين مختلفَين أو أكثر:
 *   · CASH ⇒ «نقدي» · «نقداً» · «نقداً من الدرج» · «نقداً من الخزينة» · «النقد»
 *   · CARD ⇒ «بطاقة» · «بطاقة/حساب مصرفي» · «على البطاقة»
 *   · CHECK ⇒ «صك» · «صكّ» (شدّةٌ تفرّق)
 *   · TRANSFER ⇒ «تحويل» · «تحويل مصرفي»
 *   · WALLET ⇒ «محفظة» · «محفظة دفع»
 * والقناةُ سبعُ قوائم مختلفة الطول والترتيب. الموظّفُ يقرأ اسمَين لشيءٍ واحد بحسب الشاشة،
 * فيظنّهما مصدرَين مختلفَين. برنامج v2 §٦ ق٦ و§٤ D6 يخفّض هذا العدد.
 *
 * ⭐ البصمة المختارة: **كائنٌ حرفيّ فيه ≥٤ من مفاتيح طرق الدفع** أو **≥٣ من مفاتيح القنوات**،
 * بقيمٍ نصّيّةٍ حرفيّة (`"…"` أو `'…'`)، والقيمُ تحمل حرفاً عربياً واحداً على الأقلّ.
 *
 * ولماذا لا كواشفُ أخرى — القياسُ حسم الاختيار لا الذوق:
 *
 *   • **اسم المتغيّر** (`METHOD_LABEL` · `PAYMENT_METHOD_AR` · …) — **مرفوضة**: الحرّاس
 *     القائمة (مثل D6 في `check:friction`) تعتمدها فتفوت `Record<PaymentMethod, string> = {…}`
 *     المُصرَّح بلا لاحقةٍ اصطلاحيّة (مثل `RAIL_LABEL` في `ReturnComposer` الذي مفاتيحُه CASH
 *     و CARD ــ يفوت التصفيةَ بالاسم). البصمةُ الشكليّة (مفاتيح × قيم) تلتقط الفعلَ لا التسمية.
 *
 *   • **الأنواعُ TypeScript** (`Record<PaymentMethod, string>`) — **مرفوضة**: كثيرٌ من الشاشات
 *     تكتب `Record<string, string>` أو تُسقط النوعَ كلّياً (`METHOD_LABEL = {CASH: "…"}`)،
 *     فمطابقةُ النوع تُنتج تحت-إحصاءٍ حادّاً. الشكلُ يعمل مع كلّ صياغة.
 *
 * ⚠️ ما **لا** يمسكه — وحارسٌ يدّعي أكثر ممّا يفعل أسوأ من متواضعٍ صادق:
 *   ١) مصفوفةَ خيارات (`[{value: "CASH", label: "نقدي"}, …]`) — لا كائنٌ حرفيّ بمفاتيحه.
 *      الانحرافُ الحقيقيّ ممكنٌ فيها لكنّ الكاشفَ الشكليَّ يخلطها بأشياءَ أخرى (توليفةٌ لا
 *      قاموس). يُغطّى بحارسٍ ثانٍ في موجةٍ لاحقة.
 *   ٢) قاموساً يحمل ٣ مفاتيح دفعٍ وحسب (مثل PrintPOS): يمرّ لأنّ التمييزَ عن ثوابتِ أعمالٍ
 *      قصيرةٍ (`{CASH: …, CREDIT: …}` لأنواع التسوية) يصير هشّاً تحت الأربعة. الأربعةُ حدٌّ
 *      يجعل الإنذارَ حقيقياً بلا إنذارٍ كاذب.
 *   ٣) مفاتيح المفاهيم المختلطة (`FinancialSourceBadge` يخلط `DRAWER`/`CASH` في قاموسٍ
 *      واحد): تُلتقَط إن بلغت العتبة لأنّ إصلاحها استخراجُ الطريقة إلى `paymentMethodCompact`
 *      وحسب. ٱلمصدرُ عمودٌ آخر (cashBucket).
 *   ٤) القيمَ اللاتينية: `{CASH: "cash"}` يمرّ — القاعدةُ عربيّةٌ فعلاً، ولا نظيرَ لاتينيّ في
 *     `terms.ts`. يُعدّ **إن** كتب الشاشةُ نصّاً عربياً واحداً على الأقلّ في القيم.
 *
 * ⚠️ يستثني الحارس ملفَّين تلقائياً:
 *   • ملفٌّ يستورد من `@shared/terms` — مستهلكٌ موثَّق للمصدر الموحّد (لا مانعَ من قواميس
 *     مُصمَّمة أخرى فيه).
 *   • ملفٌّ يستورد من `@shared/paymentMethod` — عقدٌ مشترَك للتسمية (وإن لم يوجد اليوم،
 *     يجب أن يبقى الاستثناء مفتوحاً للفصل بين المصدر والمستهلك).
 *
 * المِسنَنة **تنازلية** (scripts/ratchet-core.mjs): الأساس يُخفَّض أو يبقى، ولا يُرفَع.
 * التحديث بعد الترحيل: node scripts/check-vocabulary.mjs --update-baseline
 * الاختبار الذاتيّ:    node scripts/check-vocabulary.mjs --selftest
 * التقرير وحده:        node scripts/check-vocabulary.mjs --report
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertMonotonicDescent } from "./ratchet-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(REPO_ROOT, "client", "src");
const BASELINE_PATH = path.join(__dirname, "vocabulary-baseline.json");
const BASELINE_REL = "scripts/vocabulary-baseline.json";
const UPDATE = process.argv.includes("--update-baseline");
const SELFTEST_ONLY = process.argv.includes("--selftest");
const REPORT_ONLY = process.argv.includes("--report");

/** مفاتيح طريقة الدفع من `shared/terms.ts` — نفس الاتّحاد. */
const PAYMENT_METHOD_KEYS = [
  "CASH",
  "CARD",
  "TRANSFER",
  "WALLET",
  "TELECOM",
  "EXCHANGE",
  "CHECK",
  "MIXED",
  "ACCRUAL",
];

/** مفاتيح القناة من `shared/terms.ts` — نفس الاتّحاد. */
const CHANNEL_KEYS = [
  "WALK_IN",
  "PHONE",
  "WHATSAPP",
  "INSTAGRAM",
  "TIKTOK",
  "STORE",
  "FACEBOOK",
  "WEBSITE",
  "REFERRAL",
  "CAMPAIGN",
  "RETAIL",
  "RECEPTION",
  "PRINT",
];

/** عتبةُ الكشف — دون هذا العدد، الكاشفُ يُنذر كذباً على ثوابتِ أعمالٍ قصيرة. */
const MIN_PAYMENT_KEYS = 4;
const MIN_CHANNEL_KEYS = 3;

/**
 * يجرّد التعليقات ويقنّع السلاسل النصّيّة — نفس معالجة `check-form-parity.mjs`:
 * تعليقٌ يذكر «CASH: نقدي» كتوثيقٍ لا يجب أن يُحسَب قاموساً.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, (_, p) => p);
}

/** كشفُ الاستيراد من المصادر المشتركة — نفس مسارَي الاستيراد اللذين حدّدتهما المهمّة. */
function importsSharedVocab(src) {
  return (
    /from\s+["']@shared\/terms["']/.test(src) ||
    /from\s+["']@shared\/paymentMethod["']/.test(src)
  );
}

/**
 * كواشف الشكل — كائنٌ حرفيّ يحمل مجموعةَ مفاتيح من `keys` بقيمٍ نصّيّة (`"…"` أو `'…'`).
 * يُعيد عددَ الكائنات المُطابِقة في المصدر.
 *
 * البصمةُ عمداً **بحدود الكائن الحرفيّ**: `\{[\s\S]{0,800}?\}` غير جشعٍ يحدّ الالتقاطَ
 * بكائنٍ واحدٍ صغيرٍ نسبياً (٨٠٠ محرفٍ كافيةٌ لعشراتِ مفاتيح لا لملفٍّ كامل).
 *
 * القيمُ تُقبَل نصّيّةً فقط: `"…"` / `'…'`، بلا `` `…` `` (اقتباسٌ عكسيّ) لأنّ الأخيرَ يُشير
 * إلى **دالّةِ حساب** لا إلى **قاموسِ تسمية** ثابت — والحارسُ يقيس القواميس.
 */
function detectVocabMap(src, keys, minMatches) {
  const clean = stripComments(src);
  const objectRe = /\{[\s\S]{0,800}?\}/g;
  const keyValueRe = new RegExp(
    `(?:^|[\\s,\\{])(${keys.join("|")})\\s*:\\s*(?:"[^"]*"|'[^']*')`,
    "g",
  );
  let count = 0;
  for (const match of clean.match(objectRe) ?? []) {
    const hits = new Set();
    for (const kv of match.matchAll(keyValueRe)) hits.add(kv[1]);
    if (hits.size < minMatches) continue;
    // القيمُ يجب أن تحمل حرفاً عربياً واحداً على الأقلّ — كائنُ خرائطَ لاتينيّ محضٍ
    // (تسميةٌ إنجليزيّة أو رمزٌ فنّيّ) لا نظيرَ له في `shared/terms.ts` فلا نطالبه به.
    if (!/[؀-ۿ]/.test(match)) continue;
    count += 1;
  }
  return count;
}

/** الكشفُ المُركَّب — كائنٌ لطريقة دفعٍ أو كائنٌ لقناة. يُعيد عددَ الكائنات المخالِفة. */
export function detectLocalVocabDicts(src) {
  if (importsSharedVocab(src)) return 0;
  const payment = detectVocabMap(src, PAYMENT_METHOD_KEYS, MIN_PAYMENT_KEYS);
  const channel = detectVocabMap(src, CHANNEL_KEYS, MIN_CHANNEL_KEYS);
  return payment + channel;
}

/* ══════════════════════════════ الاختبار الذاتيّ ══════════════════════════════ */

function runSelfTest({ quiet }) {
  const fails = [];
  const eq = (name, got, want) => {
    if (got !== want) fails.push(`${name}: got=${got} want=${want}`);
  };

  // ١) كائنُ طريقة دفعٍ بأربعة مفاتيح ⇒ يُلتقط.
  eq(
    "يمسك قاموسَ طريقة دفعٍ بأربعة مفاتيح",
    detectLocalVocabDicts(
      'const M: Record<string, string> = { CASH: "نقدي", CARD: "بطاقة", TRANSFER: "تحويل", WALLET: "محفظة" };',
    ),
    1,
  );

  // ٢) كائنٌ لغرضٍ آخر (ثابتُ أعمال، أسماء أدوار…) ⇒ يُتجاهل.
  eq(
    "لا يمسك كائناً لغرضٍ آخر",
    detectLocalVocabDicts('const P = { URGENT: "عاجل", NORMAL: "عادي", LOW: "منخفض" };'),
    0,
  );

  // ٣) استيرادٌ من `@shared/terms` ⇒ يُستثنى حتى لو حمل الملفّ قاموساً.
  eq(
    "يستثني ملفاً يستورد من @shared/terms",
    detectLocalVocabDicts(
      'import { paymentMethodCompact } from "@shared/terms";\nconst M = { CASH: "نقدي", CARD: "بطاقة", TRANSFER: "تحويل", WALLET: "محفظة" };',
    ),
    0,
  );

  // ٤) استيرادٌ من `@shared/paymentMethod` ⇒ يُستثنى.
  eq(
    "يستثني ملفاً يستورد من @shared/paymentMethod",
    detectLocalVocabDicts(
      'import { PM } from "@shared/paymentMethod";\nconst M = { CASH: "نقدي", CARD: "بطاقة", TRANSFER: "تحويل", WALLET: "محفظة" };',
    ),
    0,
  );

  // ٥) كائنُ قناة بثلاثة مفاتيح ⇒ يُلتقط.
  eq(
    "يمسك قاموسَ قناة بثلاثة مفاتيح",
    detectLocalVocabDicts(
      'const C = { WHATSAPP: "واتساب", INSTAGRAM: "إنستغرام", WALK_IN: "حضوري" };',
    ),
    1,
  );

  // ٦) كائنٌ لثلاثة مفاتيح دفعٍ فقط ⇒ يمرّ (تحت العتبة).
  eq(
    "لا يمسك ثلاثة مفاتيح دفعٍ (تحت العتبة)",
    detectLocalVocabDicts('const M = { CASH: "نقدي", CARD: "بطاقة", TRANSFER: "تحويل" };'),
    0,
  );

  // ٧) قيمٌ لاتينيّة محضة ⇒ يمرّ (لا نظيرَ عربيّ يُطالَب به).
  eq(
    "لا يمسك قيماً لاتينيّة محضة",
    detectLocalVocabDicts(
      'const M = { CASH: "cash", CARD: "card", TRANSFER: "transfer", WALLET: "wallet" };',
    ),
    0,
  );

  // ٨) قاموسٌ في تعليقٍ ⇒ يُتجاهل (يوثِّق ولا يُنفَّذ).
  eq(
    "يتجاهل قاموساً داخل تعليق",
    detectLocalVocabDicts(
      '// const M = { CASH: "نقدي", CARD: "بطاقة", TRANSFER: "تحويل", WALLET: "محفظة" };',
    ),
    0,
  );

  if (fails.length > 0) {
    console.error("✗ الاختبار الذاتيّ لحارس المفردات فشل:\n");
    for (const f of fails) console.error(`  ${f}`);
    process.exit(1);
  }
  if (!quiet) console.log("✓ الاختبار الذاتيّ لحارس المفردات: كلّ الكواشف سليمة.");
}

/* ══════════════════════════════ المسح ══════════════════════════════ */

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      yield* walk(abs);
    } else if (entry.isFile() && /\.(tsx|ts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      yield abs;
    }
  }
}

function scanRepository() {
  const findings = new Map(); // relPath -> count
  if (!existsSync(SCAN_ROOT)) return findings;
  for (const abs of walk(SCAN_ROOT)) {
    const src = readFileSync(abs, "utf8");
    const count = detectLocalVocabDicts(src);
    if (count > 0) {
      const rel = path.relative(REPO_ROOT, abs).replace(/\\/g, "/");
      findings.set(rel, count);
    }
  }
  return findings;
}

/* ══════════════════════════════ التنفيذ ══════════════════════════════ */

runSelfTest({ quiet: !SELFTEST_ONLY });
if (SELFTEST_ONLY) process.exit(0);

const BASELINE = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : {};

const current = scanRepository();
const currentObj = Object.fromEntries(
  [...current.entries()].sort(([a], [b]) => a.localeCompare(b)),
);
const currentTotal = [...current.values()].reduce((s, n) => s + n, 0);
const baselineTotal = Object.values(BASELINE).reduce((s, n) => s + (Number(n) || 0), 0);

if (UPDATE) {
  writeFileSync(BASELINE_PATH, JSON.stringify(currentObj, null, 2) + "\n", "utf8");
  console.log(
    `✓ حُدِّث خطّ أساس المفردات: ${current.size} ملفّاً · ${currentTotal} قاموساً محلّياً مجمَّداً.`,
  );
  process.exit(0);
}

// ١) انتهاكاتٌ جديدة: ملفٌّ ليس في خطّ الأساس ولا يستورد من المصدر الموحّد.
const newViolations = [];
for (const [rel, count] of current) {
  const allowed = Number(BASELINE[rel] ?? 0);
  if (count > allowed) newViolations.push({ rel, was: allowed, now: count });
}

// ٢) المِسنَنة التنازليّة مقابل origin/main — يمنع رفعَ الأساس لتمرير انتهاك.
const descent = assertMonotonicDescent({
  baselinePath: BASELINE_REL,
  baseline: currentObj,
  label: "المفردات الموحّدة",
});

if (REPORT_ONLY) {
  console.log("المفردات الموحّدة — تقريرٌ (لا يحجب):");
  console.log(`   الملفّات المخالِفة اليوم: ${current.size}`);
  console.log(`   القواميس المحلّية المعدودة: ${currentTotal}`);
  console.log(`   خطّ الأساس المُلتزَم: ${Object.keys(BASELINE).length} ملفّاً · ${baselineTotal} قاموساً`);
  if (newViolations.length > 0) {
    console.log(`ℹ️  ${newViolations.length} ملفّ فوق خطّ الأساس:`);
    for (const v of newViolations.slice(0, 20)) {
      console.log(`   - ${v.rel}: ${v.was} ← ${v.now}`);
    }
  }
  if (!descent.skipped) console.log(descent.message);
  process.exit(0);
}

if (!descent.ok) {
  console.error(descent.message);
  process.exit(1);
}

if (newViolations.length === 0) {
  console.log(
    `✓ المفردات الموحّدة محفوظةٌ ضمن خطّ الأساس — ${current.size} ملفّاً · ${currentTotal} قاموساً محلّياً.`,
  );
  if (!descent.skipped) console.log(descent.message);
  process.exit(0);
}

console.error(
  `✗ المفردات الموحّدة — ${newViolations.length} ملفّ فوق خطّ الأساس:\n`,
);
for (const v of newViolations) {
  console.error(`  - ${v.rel}: ${v.was} ← ${v.now}`);
}
console.error(`
القاعدة: قاموسُ طريقة الدفع أو القناة **مصدرُه الوحيد** [\`shared/terms.ts\`](shared/terms.ts).
كلُّ شاشةٍ تُعرِّف قاموساً محلّياً بمفاتيح CASH/CARD/TRANSFER/WALLET… أو بمفاتيح
WHATSAPP/INSTAGRAM/WALK_IN… تنجرف حتماً — الجدولُ في رأس \`terms.ts\` يعدّ ١٤ قاموساً
منجرفاً على قيمةٍ واحدة (CASH ⇒ خمسةُ أسماءٍ مختلفة).

العلاجُ:
  import { paymentMethodCompact, paymentMethodProse, paymentMethodTermOptions } from "@shared/terms";
  import { channelCompact, channelTermOptions, CHANNEL_SOURCE_ENUMS } from "@shared/terms";

  // بدل قاموسٍ محلّيّ:
  <Badge>{paymentMethodCompact(row.paymentMethod)}</Badge>

  // بدل مصفوفة خيارات محلّية:
  {paymentMethodTermOptions(INBOUND_ENABLED_PAYMENT_METHODS).map(o => (
    <option key={o.value} value={o.value}>{o.compact}</option>
  ))}

⚠️ الاستثناء الوحيد للاستثمار في قاموسٍ محلّيّ: مفاتيحٌ **ليست** طرقَ دفعٍ أو قنوات
(دلاء نقدية، أسبابُ عجزٍ، أنواعُ تسوية…) — لا نظيرَ لها في \`terms.ts\` بعد.

خطّ الأساس (تنازليّ — لا يُرفَع): ${BASELINE_REL}
التحديث بعد الترحيل: node scripts/check-vocabulary.mjs --update-baseline
`);
process.exit(1);
