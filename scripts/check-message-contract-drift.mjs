#!/usr/bin/env node
/**
 * حارِسُ **انجراف الرسائل المتعاقَد عليها** (برنامج v2، ق٦ — ٢/٩/٢٦).
 *
 * ## العلّة التي وُجد لها
 * اختباراتٌ كثيرة في هذا المستودع تطابق **نصَّ** رسالة الخطأ (`toThrow(/إرسالية مفتوحة/)`)
 * لا رمزَها. فحين يُعاد صوغُ الرسالة — وهو ما تفعله حملةُ ق٦ في آلاف المواضع — **يسقط
 * التعاقد بلا خطأ نوعٍ ولا تحذيرٍ ولا شيءٍ يظهر قبل تشغيل الحزمة الكاملة** (٢٠-٤٥ دقيقة).
 * وقع هذا **ثلاث مرّات في يومٍ واحد**: `/إرسالية مفتوحة/` و`/استُهلكت/` و`/الحجوزات النشطة/`.
 *
 * وأخطرُ منه أنّ النصّ قد يكون تعاقداً **بين خدمتين** لا بين خدمةٍ واختبار:
 * `sale/create.ts` و`workOrder/lifecycle.ts` و`Reception.tsx` تفحص ثلاثتُها
 * `message.includes("المخزون غير كافٍ")` — وإسقاطُها يُعطّل ثلاثة مسارات بصمتٍ تامّ.
 *
 * ## ما يقيسه — وما لا يقيسه (بصراحة)
 * يقارن كلّ ملفٍّ **متغيّرٍ** بنسخته في المرجع، ويبحث عن نصٍّ عربيٍّ **كان يطابقه** مستهلِكٌ
 * ذو صلة **ولم يعد**. المستهلِكان نوعان: تأكيدُ اختبارٍ (`toThrow(/…/)`/`toContain("…")`)،
 * وفحصٌ نصّيٌّ في شيفرةٍ أخرى (`message.includes("…")`).
 *
 * ⛔ **ولا يدّعي أكثر من ذلك:** لا يحكم على جودة الرسالة، ولا يمسك تعاقداً بنصٍّ مبنيٍّ
 * ديناميكياً، ولا مطابقةً بمتغيّر. حارسٌ يدّعي ما لا يفعله يُنذر كذباً فيُتجاوَز فيصير مسرحياً.
 *
 * ⭐ **وقيدُ الصلة هو جوهرُ صحّته:** بلا اشتراطِ أن يستورد المستهلِكُ الملفَّ فعلاً، كانت أوّلُ
 * نسخةٍ تقارن كلَّ اختبارٍ بكلّ ملفّ فتُخرج **١٣٨ إنذاراً أغلبُها كاذب** («السابق» من
 * `TablePager.test.ts` مقابل إلغاء أمر شغل). القيدُ خفّضها إلى **٥ — كلُّها حقيقية**.
 *
 * الاستعمال:
 *   node scripts/check-message-contract-drift.mjs              # شجرةُ العمل مقابل HEAD
 *   node scripts/check-message-contract-drift.mjs --base origin/main
 *   node scripts/check-message-contract-drift.mjs --selftest
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const SELFTEST_ONLY = args.includes("--selftest");
const baseIdx = args.indexOf("--base");
const BASE = baseIdx >= 0 ? args[baseIdx + 1] : "HEAD";

const ARABIC = /[\u0600-\u06FF]/;

/** أنماطُ التعاقد النصّيّ في مستهلِكٍ: تأكيدُ اختبار، أو فحصٌ نصّيّ في شيفرة. */
const CONTRACT_PATTERNS = [
  /toThrowError[(][/]([^/\n]{4,140})[/][a-z]*[)]/g,
  /toThrow[(][/]([^/\n]{4,140})[/][a-z]*[)]/g,
  /toContain[(]"([^"\n]{6,140})"[)]/g,
  /[.]includes[(]"([^"\n]{6,140})"[)]/g,
];

/** يستخرج كلّ نصٍّ عربيٍّ يتعاقد عليه هذا المستهلِك. */
export function extractContractTexts(source) {
  const out = [];
  for (const re of CONTRACT_PATTERNS) {
    for (const m of source.matchAll(new RegExp(re.source, re.flags))) {
      const text = m[1];
      if (text && ARABIC.test(text)) out.push(text);
    }
  }
  return out;
}

/** هل يشير هذا المستهلِك إلى الوحدة `stem` (استيرادٌ أو مسار)؟ قيدُ الصلة. */
export function referencesModule(source, stem) {
  return source.includes(`/${stem}"`) || source.includes(`/${stem}'`);
}

/** هل انكسر التعاقد؟ كان يطابق النصَّ القديم ولم يعد يطابق الجديد. */
export function contractBroken(text, before, after) {
  let re;
  try {
    re = new RegExp(text);
  } catch {
    // نصٌّ حرفيّ لا نمط (من `toContain`/`includes`).
    return before.includes(text) && !after.includes(text);
  }
  return re.test(before) && !re.test(after);
}

function runSelfTest({ quiet }) {
  const fails = [];
  const eq = (name, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      fails.push(`${name}: توقّعنا ${JSON.stringify(want)} فجاء ${JSON.stringify(got)}`);
    }
  };

  eq("يلتقط تأكيد toThrow العربيّ", extractContractTexts('rejects.toThrowError(/إرسالية مفتوحة/);'), [
    "إرسالية مفتوحة",
  ]);
  eq("ويلتقط فحص includes بين خدمتين", extractContractTexts('e.message.includes("المخزون غير كافٍ")'), [
    "المخزون غير كافٍ",
  ]);
  eq("ولا يلتقط نمطاً لاتينياً — ليس رسالةَ مستخدم", extractContractTexts("toThrow(/ER_DUP_ENTRY/)"), []);

  eq("قيدُ الصلة يقبل الاستيراد الفعليّ", referencesModule('from "../returnService"', "returnService"), true);
  eq("ويرفض اسماً عابراً في نصّ", referencesModule("// returnService مذكورٌ تعليقاً", "returnService"), false);

  eq("الكسرُ يُكتشف", contractBroken("إرسالية مفتوحة", "x إرسالية مفتوحة y", "x إرسالية التوصيل y"), true);
  eq("والباقي لا يُنذَر عليه", contractBroken("إرسالية", "x إرسالية y", "x إرسالية التوصيل y"), false);
  // البديلُ يبقى محقَّقاً ما دام أحدُ شقّيه باقياً — وإلّا أنذر الحارس على صياغةٍ سليمة.
  eq("والبديل يُقاس كنمطٍ لا كنصّ", contractBroken("أ|ب", "فيه أ", "فيه ب"), false);

  if (fails.length) {
    console.error("✗ الاختبار الذاتيّ لحارس انجراف الرسائل:");
    for (const f of fails) console.error("  - " + f);
    process.exit(1);
  }
  if (!quiet) console.log("✓ الاختبار الذاتيّ لحارس انجراف الرسائل: كلّ الكواشف سليمة.");
}

runSelfTest({ quiet: !SELFTEST_ONLY });
if (SELFTEST_ONLY) process.exit(0);

let changed;
try {
  changed = execSync(`git diff --name-only ${BASE}`, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .split("\n")
    .filter((f) => /[.](ts|tsx)$/.test(f) && !f.includes(".test."));
} catch {
  // يفشل **مفتوحاً**: مرجعٌ غائب (استنساخٌ ضحل) لا يُعطّل عملاً مشروعاً — كبقيّة الحرّاس.
  console.log(`ℹ️ تعذّر قراءة الفرق مقابل «${BASE}» — يُتخطّى الحارس.`);
  process.exit(0);
}

const consumers = execSync("git ls-files", { cwd: REPO_ROOT })
  .toString()
  .split("\n")
  .filter((f) => /[.](ts|tsx)$/.test(f));

const findings = [];
for (const file of changed) {
  const stem = path.basename(file).replace(/[.]tsx?$/, "");
  let before;
  try {
    before = execSync(`git show ${BASE}:${file}`, { cwd: REPO_ROOT, maxBuffer: 1e8, stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    continue; // ملفٌّ جديد — لا تعاقدَ سابقاً يُكسر.
  }
  const full = path.join(REPO_ROOT, file);
  if (!fs.existsSync(full)) continue;
  const after = fs.readFileSync(full, "utf8");
  for (const consumer of consumers) {
    if (consumer === file) continue;
    let src;
    try {
      src = fs.readFileSync(path.join(REPO_ROOT, consumer), "utf8");
    } catch {
      continue;
    }
    if (!referencesModule(src, stem)) continue;
    for (const text of extractContractTexts(src)) {
      if (contractBroken(text, before, after)) findings.push({ consumer, text, file });
    }
  }
}

if (findings.length === 0) {
  console.log(`✓ لا انجرافَ في نصٍّ متعاقَدٍ عليه (مقابل ${BASE}).`);
  process.exit(0);
}

console.error(`✗ انجرافُ رسائل: ${findings.length} تعاقداً نصّياً كُسر مقابل ${BASE}.`);
for (const f of findings) {
  console.error(`  - ${f.consumer}`);
  console.error(`      «${f.text}» لم تعد تطابق ${f.file}`);
}
console.error("");
console.error("  القاعدة: نصُّ رسالةٍ يفحصه مستهلِكٌ **جزءٌ من العقد**. إمّا تُبقيه حرفياً،");
console.error("  وإمّا تُضيّق نمطَ المستهلِك على الجزء الثابت من المعنى — ولا تُضعِفه ولا تحذفه.");
process.exit(1);
