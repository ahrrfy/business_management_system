#!/usr/bin/env node
// حارس CI (Slice DFP2، ٣١/٨/٢٦) — يمنع التشكيل العربي داخل الشارات ورؤوس الجداول.
//
// السبب (الفحص البصريّ ٣١/٨): خطّ الواجهة (Cairo/Tajawal) يرسم «مُ + كلمة» + تشكيل
// بشكلٍ مشوَّه في الأحجام الصغيرة (11-12px)، فيقرأ الكاشير:
//   «سُلِّم» ⇒ «شلَم»       — 4 مواقع في التوصيل
//   «المُحصَّل» ⇒ «الفَحصل»  — 3 مواقع
//   «مُسنَد» ⇒ «فسند»       — 2 موقع
//   «المُوزَّعة» ⇒ «المؤرّعة» — 1 موقع
//   «حُصِّل» ⇒ «كُضّل»       — 1 موقع
// أي نصفُ الشاشة يُقرأ خطأً. الحلّ: **إزالة التشكيل من كلّ الشارات ورؤوس الأعمدة**.
//
// النطاق: client/src/**/*.{tsx,ts} — يبحث في:
//   - `<th ...>` — رؤوس الجداول
//   - `<Badge ...>` — الشارات المكوَّنة
//   - أنماط className تحوي text-[9px..13px] — الأحجام الحرِجة
//   - `title="..."` مسموحٌ به (تظهر بحجم نظام أكبر عبر tooltip).
//
// التشكيل الممنوع: U+064B..U+0652 (fatha, damma, kasra, shadda, sukun, tanwin variants) +
// U+0670 (Arabic Letter Superscript Alef) + U+0653..U+065F (misc).
//
// النطاق قد يوسَّع لاحقاً ليشمل أزرار bg-*/text-* بأحجام صغيرة.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(REPO_ROOT, "client", "src");

/**
 * Slice DFP2 (٣١/٨/٢٦) — النطاق الحاليّ: **مسارات التوصيل حصراً**.
 *
 * الفحص البصريّ الحيّ (٣١/٨) أثبت أنّ الشاشات الحرِجة في المنظومة هي شاشات التوصيل
 * (تسوية المناديب/جهات التوصيل/تفاصيل الجهة/الأداء/الأعمار/كشف الحساب). المشكلة العامّة
 * (تشكيلٌ في نصٍّ صغير) قائمةٌ في ~٥٠٠ موقع عبر النظام؛ توسيع الحارس دفعةً واحدة يُلزم بإصلاحٍ
 * بنيويٍّ خارج نطاق DFP2. نُطبّق المبدأ **حيث الحاجة الآن**، ونوسّع دفعةً دفعة.
 *
 * التوسيع لاحقاً: يكفي حذف هذه المصفوفة أو إضافة نطاقاتٍ جديدة إليها.
 */
const IN_SCOPE_PATH_RE = [
  /[\/\\]pages[\/\\]DeliveryHub\.tsx$/,
  /[\/\\]pages[\/\\]DeliveryParties\.tsx$/,
  /[\/\\]pages[\/\\]DeliveryPartyDetail\.tsx$/,
  /[\/\\]pages[\/\\]MyDeliveries\.tsx$/,
  /[\/\\]components[\/\\]delivery[\/\\]/,
];

function isInScope(file) {
  return IN_SCOPE_PATH_RE.some((rx) => rx.test(file));
}

// U+064B..U+0652 + U+0670 (superscript alef) + U+0653..U+065F.
const TASHKEEL_RE = /[ً-ٰٟ]/;

// الملفات المستثناة: اختبارات، أوصاف tooltip طويلة، قوالب طباعة.
const EXCLUDED_PATH_RE = [
  /[\/\\]__tests__[\/\\]/,
  /\.test\.tsx?$/,
  /[\/\\]lib[\/\\]printing[\/\\]/, // طباعة PDF/إيصال (خارج DOM المتصفح)
];

function isExcluded(f) {
  return EXCLUDED_PATH_RE.some((rx) => rx.test(f));
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "_legacy", "dist", "__tests__"].includes(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile() && /\.(tsx?)$/.test(entry.name) && !isExcluded(full) && isInScope(full)) {
      yield full;
    }
  }
}

/**
 * السطر بها تشكيل في سياقٍ محاسبيّ صغير؟ يعتبر خطأً إن حوى:
 *   - `<th ...>`   (رؤوس الأعمدة، حجمها ~12px)
 *   - `<Badge ...>` أو خصائص كـ`variant=`
 *   - class strings تحوي `text-[9px]|text-[10px]|text-[11px]|text-[12px]|text-[13px]|text-xs`
 *   - سلاسل JSX داخل <span> بحجمٍ صغير في نفس السياق
 * لكن يستثني `title="..."` (النصّ يظهر tooltip بحجمٍ نظاميّ أكبر).
 * ويستثني التعليقات (// … أو * …) لأنها ليست UI.
 */
/**
 * الحرِج ماذا:
 *   - `<th>` — رأس عمود (حجم ~12px + عريض غالباً).
 *   - `<Badge>` — شارة تعريف موجزة (10-11px عادةً).
 *   - `text-[9px]/[10px]/[11px]` — أحجام دقيقة يسقط رسم التشكيل عليها كلياً.
 *
 * ما هو **مستثنى** (النصّ فيه أطول ويقرأ بحجم متّسعٍ نسبياً):
 *   - `text-xs` عامّةً (١٢px) — للفقرات والوصف
 *   - `<Label>` — تسميات النماذج
 *   - `<p>` — فقرات
 */
function isSmallTextContext(line) {
  if (/<th[\s>]/.test(line)) return true;
  if (/<Badge[\s>]/.test(line)) return true;
  if (/text-\[(9|10|11)px\]/.test(line)) return true;
  return false;
}

function isCommentOnlyLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/** استخراج قيمة `title="..."` من السطر لأنّها مستثناة. */
function stripTitleAttrs(line) {
  return line.replace(/title=(?:\{[^}]*\}|"[^"]*"|'[^']*')/g, "");
}

const findings = [];
let checkedCount = 0;

for (const file of walk(SCAN_ROOT)) {
  const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentOnlyLine(line)) continue;
    if (!isSmallTextContext(line)) continue;
    checkedCount++;
    const stripped = stripTitleAttrs(line);
    if (TASHKEEL_RE.test(stripped)) {
      findings.push({ file: rel, line: i + 1, text: line.trim().slice(0, 200) });
    }
  }
}

if (findings.length === 0) {
  console.log(`✓ صفر تشكيل عربيّ في الشارات ورؤوس الجداول (${checkedCount} سياق فحصته).`);
  process.exit(0);
}

console.error(
  `✗ وُجدت ${findings.length} حالة تشكيل عربيّ في نصٍّ صغير (< 14px). ` +
  `خطّ الواجهة يرسمها خطأً في الحجم الصغير (مُ→ف، سُ→ش):\n`,
);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  ${f.text}`);
}
console.error(
  `\nالقاعدة: احذف التشكيل من رؤوس الأعمدة والشارات ` +
  `(النسخة الأدبيّة بتشكيلٍ كامل تبقى في title/tooltip وفي prose).`,
);
console.error(
  `المصدر الحاكم: shared/deliveryTerminology.ts — كل مصطلح يحوي {compact, prose, tooltip}.`,
);
process.exit(1);
