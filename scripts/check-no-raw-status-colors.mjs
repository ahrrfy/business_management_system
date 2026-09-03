#!/usr/bin/env node
// حارِس CI — يمنع إضافة ألوان Tailwind خام لدلالات المال/الحالة في الشاشات، بدل التوكنز الدلالية
// (text-money-positive/negative · text-stock-low/ok/out · text-[var(--sem-info)]).
//
// السبب: تقييم التصميم ٢٧/٧/٢٦ رصد ~٨٠٩ لوناً خاماً يتجاوز التوكنز مقابل ٥-١٠ ملفات تستعملها ⇒
// انجراف بصريّ يتراكم مع كل شاشة. لا نُصلح الموجود دفعةً (٨٠٠+ موقع) — بل «ratchet»: خطّ أساس
// يُجمّد العدد الحاليّ لكل ملف، والحارس يفشل فقط عند «الزيادة» (لون مال/حالة خام جديد)، فيُحكِمها
// تدريجياً ويجعل أيّ إضافة قراراً واعياً ظاهراً في الـPR (تعديل خطّ الأساس).
//
// النطاق: client/src/pages/**/*.tsx (حيث تركّز الرصد). الأصباغ ذات المقابل الدلاليّ فقط:
//   red/rose (سالب/نفد) · green/emerald (موجب/متوفّر) · amber/yellow (منخفض).
// (لا نمنع slate/gray/blue العامة — ليست دلالة حالة، وتوليدها إيجابياتٍ كاذبة.)
//
// تحديث الأساس (بعد إصلاح ملف، أو عند استعمالٍ مشروع لا يخصّ المال/الحالة):
//   node scripts/check-no-raw-status-colors.mjs --update-baseline
//
// إخراج: ملف: العدد الحاليّ (الأساس، +الزيادة) لكل ملف تجاوز أساسه. exit 1 عند أي زيادة.
//
// ⚠️ **الرقمُ الباقي ليس دَيْناً كلُّه — اقرأ هذا قبل أن تُطلق حملةَ خفضٍ جديدة** (٢/٩/٢٦):
// خطّ الأساس اليوم ١٤٨ موضعاً، **١٣٠ منها في `Storefront.tsx` وحده**، وهي **ليست ألوان
// حالة**: المتجرُ يملك طبقةَ كساءٍ في `client/src/index.css` تحت المُحدِّد `.storefront`
// تُعيد تعريف تلك الأصناف نفسها بـ`!important` بهوية العلامة —
// `text-emerald-600` ⇐ `--store-brand` (كحليّ) و`bg-amber-500` ⇐ `--store-accent` (طينيّ).
// فالصنفُ هنا **مقبضٌ للكساء** لا لونٌ أخضر، وتحويلُه إلى توكنٍ دلاليٍّ يقطع الكساءَ
// ويُنتج متجراً أخضرَ فعلاً — أي أنّ «الإصلاح» هو ما يكسر الهوية.
// وقد رُحّل من المتجر ما هو **دلالةُ حالةٍ حقيقية** (تنبيهات `role="alert"` والأفعال
// الهدّامة) وعددها ٢٢؛ وما بقي سعرٌ وهويّةُ علامةٍ يُقصد بها ما هي عليه.
//
// ⇒ الدَّيْنُ الحقيقيّ خارج المتجر ضئيل. لا تقِس تقدّم الحملة بالرقم الإجماليّ، واقرأه
// موزَّعاً على الملفّات. ولا تُخرج `Storefront` من النطاق: بقاؤه بأساسٍ مجمَّد يمنع
// **الزيادة** فيه، وهو المطلوب — بخلاف الاستثناء الذي يجعله أعمى تماماً.

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(REPO_ROOT, "client", "src", "pages");
const BASELINE_PATH = path.join(__dirname, "raw-color-baseline.json");
const UPDATE = process.argv.includes("--update-baseline");

// text-/bg-/border-/ring-/from-/to-/via- + صِبغة + درجة (٥٠..٩٥٠). يلتقط سوابق المتغيّرات (dark:‏، hover:‏)
// لأنّ الحرف قبلها ':' ليس [\w-]. حدود الكلمة تمنع مطابقةً جزئية داخل صنفٍ أطول.
const HUES = "red|rose|green|emerald|amber|yellow";
const RAW_COLOR_RE = new RegExp(
  String.raw`(?<![\w-])(?:text|bg|border|ring|from|to|via)-(?:${HUES})-\d{2,3}(?![\w-])`,
  "g",
);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name === "dist") continue;
      yield* walk(full);
    } else if (entry.isFile() && /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
      yield full;
    }
  }
}

// عدّ مطابقات اللون الخام في ملف — نتجاهل الأسطر التعليقية الكاملة (توثيق لا واجهة).
function countRaw(text) {
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    const m = line.match(RAW_COLOR_RE);
    if (m) n += m.length;
  }
  return n;
}

const current = {};
for (const file of walk(SCAN_ROOT)) {
  const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
  const c = countRaw(readFileSync(file, "utf8"));
  if (c > 0) current[rel] = c;
}
const total = Object.values(current).reduce((s, n) => s + n, 0);

if (UPDATE) {
  const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_PATH, JSON.stringify(sorted, null, 2) + "\n", "utf8");
  console.log(`✓ حُدِّث خطّ الأساس: ${Object.keys(current).length} ملفاً · ${total} لوناً خاماً مجمّداً.`);
  process.exit(0);
}

const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
const offenders = [];
for (const [rel, c] of Object.entries(current)) {
  const allowed = baseline[rel] ?? 0;
  if (c > allowed) offenders.push({ rel, current: c, allowed, delta: c - allowed });
}

if (offenders.length === 0) {
  console.log(`✓ لا ألوان مال/حالة خام جديدة في الشاشات (الأساس ${total} مجمّد، بلا زيادة).`);
  process.exit(0);
}

console.error(`✗ أُضيفت ألوان مال/حالة خام تتجاوز التوكنز الدلالية (${offenders.length} ملفاً):\n`);
for (const o of offenders) {
  console.error(`  ${o.rel}: ${o.current} (الأساس ${o.allowed}، +${o.delta})`);
}
console.error(`\nالقاعدة: استعمل توكن الحالة — text-money-positive/negative · text-stock-low/ok/out · text-[var(--sem-info)] (tokens.css).`);
console.error(`إن كان استعمالاً مشروعاً لا يخصّ المال/الحالة، جمّده صراحةً: node scripts/check-no-raw-status-colors.mjs --update-baseline`);
process.exit(1);
