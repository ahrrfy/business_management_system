#!/usr/bin/env node
// حارِس CI — يمنع بطاقةً مدحرجةً يدوياً جديدة في `client/src/pages/**`، والبديل `<Card>`.
//
// السبب (بلاغ المالك بخمس لقطات، ٣١/٨/٢٦): «الشاشات لا تتبع مكوّناً موحّداً». والقياس
// يؤيّده جزئياً فقط: `<Card>` من `@/components/ui/card` **مُتبنّى فعلاً في ١٧٠ صفحة**،
// مقابل عشراتٍ من البطاقات المدحرجة بيد. فالمكوّن ليس ناقصاً — الانحرافُ هو المشكلة.
//
// ولماذا يهمّ الانحراف: `<div className="rounded-lg border bg-card p-4">` يبدو اليوم مطابقاً
// لِـ`<Card>`، ثمّ يتغيّر نصفُ قطر الزاوية أو الظلّ أو الحدّ في `card.tsx` مرّةً واحدة —
// فتتبعه ١٧٠ صفحة وتتخلّف البقيّة بمظهرٍ قديمٍ **بلا أن يشتكي أحد**. وهذا بالضبط شكلُ
// «عدم الاتّساق» الذي رآه المالك في لقطاته: لا خطأ بيّن، بل درجاتٌ متفاوتة من الشيء نفسه.
//
// ⚠️ **ولا يُحوَّل القائم دفعةً واحدة**: `<Card>` يجرّ `CardHeader/CardContent` بحشوتها
// الخاصّة، وكثيرٌ من هذه لوحاتٌ صغيرة بحشوةٍ مضبوطة يدوياً — فالتحويل الأعمى يزيح
// التخطيط في شاشاتٍ لا يشتكي منها أحد. لذلك: سقّاطةٌ تُجمّد القائم وتمنع **الزيادة**،
// ويُخفَّض خطُّ الأساس شاشةً شاشةً حين تُفتَح لسببٍ آخر.
//
// النطاق: `client/src/pages/**/*.tsx`. التوقيع: صنفٌ يجمع الثلاثة معاً — زاويةً مُدوَّرة
// (`rounded-lg|xl|2xl`) وحدّاً (`border`) وخلفيةَ بطاقة (`bg-card`) — وهو ما يجعل الـ`div`
// بطاقةً بصرياً. (لا نمسك `rounded-md` وحدها ولا `bg-muted`: ليستا بطاقةً، ونُنتج إيجابياتٍ كاذبة.)
//
// التحديث بعد الترحيل: node scripts/check-raw-card.mjs --update-baseline

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertMonotonicDescent } from "./ratchet-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(REPO_ROOT, "client", "src", "pages");
const BASELINE_PATH = path.join(__dirname, "raw-card-baseline.json");
const UPDATE = process.argv.includes("--update-baseline");

const BASELINE = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : {};

/*
 * ⭐ **لا يكفي مسحُ `className="…"` الحرفيّ** (مراجعة Codex على PR #953): البطاقة تُكتب في
 * هذا المستودع بأربع صيغٍ لا واحدة — سلسلةً حرفية، و`className={cn("…", cond && "…")}`،
 * وقالباً نصّياً، وسمةً موزّعةً على أسطر. والحارسُ الأوّل كان يشترط سلسلةً حرفيةً **في سطرٍ
 * واحد**، فيَعمى عن الثلاث الباقيات ⇒ أيُّ إضافةٍ جديدة بصيغة `cn(...)` تعبر CI بينما
 * الحارسُ يُعلن الاخضرار. وحارسٌ يقرأ صيغةً واحدةً من أربع ليس حارساً — هو تمثيلٌ للحراسة.
 *
 * فيُقرأ الآن **كلُّ** قيمة `className` أياً كانت صيغتها (توازنُ الأقواس يلتقط الأسطر
 * المتعدّدة)، ثمّ — داخل التعبير — تُفحَص **كلُّ سلسلةٍ نصّيّة على حدة**. وهذا الأخير
 * مقصودٌ لا تبسيط: فحصُ نصّ التعبير كاملاً يجعل
 *   cn(open ? "rounded-lg border" : "bg-card")
 * مخالفةً وهي فرعان متنافيان لا بطاقة — والإنذارُ الكاذب يُبطِل الحارس أسرع من العمى.
 */
function stripComments(text) {
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => (line.trim().startsWith("//") ? "" : line))
    .join("\n");
}

/** يُخرج قيمة كلّ سمة `className` — سلسلةً حرفية أو نصَّ التعبير داخل `{…}`. */
function* classNameValues(text) {
  const re = /className\s*=\s*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[0].length;
    const ch = text[start];
    if (ch === '"' || ch === "'") {
      const end = text.indexOf(ch, start + 1);
      if (end === -1) continue;
      yield { kind: "literal", value: text.slice(start + 1, end) };
      re.lastIndex = end + 1;
    } else if (ch === "{") {
      let depth = 0;
      let j = start;
      for (; j < text.length; j++) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      yield { kind: "expression", value: text.slice(start + 1, j) };
      re.lastIndex = j + 1;
    }
  }
}

/** سلاسلُ نصّيّة داخل تعبير — كلٌّ تُقاس وحدها كي لا يُدمَج فرعا ترناريٍّ متنافيان. */
function* stringLiterals(expr) {
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  let m;
  while ((m = re.exec(expr)) !== null) yield m[1] ?? m[2] ?? m[3] ?? "";
}

const isCard = (cls) =>
  /(^|\s)rounded-(lg|xl|2xl)(\s|$)/.test(cls) &&
  /(^|\s)border(\s|$)/.test(cls) &&
  /(^|\s)bg-card(\s|$)/.test(cls);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "_legacy", "dist", "__tests__"].includes(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile() && /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
      yield full;
    }
  }
}

const relOf = (full) => path.relative(REPO_ROOT, full).replace(/\\/g, "/");

const current = new Map();
for (const file of walk(SCAN_ROOT)) {
  const text = stripComments(readFileSync(file, "utf8"));
  let count = 0;
  for (const attr of classNameValues(text)) {
    if (attr.kind === "literal") {
      if (isCard(attr.value)) count++;
    } else {
      for (const lit of stringLiterals(attr.value)) {
        if (isCard(lit)) {
          count++;
          break; // بطاقةٌ واحدة لكلّ سمة، لا لكلّ فرعٍ فيها
        }
      }
    }
  }
  if (count > 0) current.set(relOf(file), count);
}

if (UPDATE) {
  const asObj = Object.fromEntries([...current.entries()].sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_PATH, JSON.stringify(asObj, null, 2) + "\n", "utf8");
  const total = [...current.values()].reduce((s, n) => s + n, 0);
  console.log(`✓ حُدِّث خطّ الأساس: ${current.size} ملفاً · ${total} بطاقةً مجمَّدة.`);
  console.log("ℹ️  الرفعُ لا يمرّ: المِسنَنة التنازلية تقارن المجموع بـorigin/main وترفض أيّ زيادة.");
  process.exit(0);
}

const findings = [];
for (const [file, count] of current) {
  const allowed = BASELINE[file] ?? 0;
  if (count > allowed) {
    findings.push(
      allowed === 0
        ? `${file}: ${count} بطاقة مدحرجة يدوياً (خطّ الأساس ٠) ⇒ استعمل <Card> من @/components/ui/card`
        : `${file}: ${count} (الأساس ${allowed}، +${count - allowed})`,
    );
  }
}

/*
 * ⭐ **المِسنَنة التنازلية** (مراجعة Codex على PR #953): بلا هذه المقارنة كان الحارس
 * يُلتَفّ عليه **بأمرِه المُعلَن نفسه** — يُضيف المرء بطاقةً خامّة ثمّ يشغّل
 * `--update-baseline` فيُعاد كتابة الأساف بالعدد الأكبر ويخرج بصفر، ويقبله CI بعدها.
 * أي أنّ «السقّاطة» تدور في الاتّجاهين. المقارنةُ مع `origin/main` تجعل الخفضَ وحده
 * مقبولاً: الترحيلُ يُنزل الرقم، ولا شيء يرفعه. (نفسُ الآلية في `check-raw-tables`.)
 */
const descent = assertMonotonicDescent({
  baselinePath: "scripts/raw-card-baseline.json",
  baseline: BASELINE,
  label: "عقد البطاقة",
});
if (!descent.ok) {
  console.error(descent.message);
  process.exit(1);
}

const stale = Object.keys(BASELINE).filter((f) => !current.has(f));

if (findings.length === 0) {
  const total = [...current.values()].reduce((s, n) => s + n, 0);
  console.log(`✓ عقد البطاقة محفوظ — ${current.size} ملف · ${total} بطاقة ضمن خطّ الأساس.`);
  if (!descent.skipped) console.log(descent.message);
  if (stale.length > 0) {
    console.log(`ℹ️  ${stale.length} ملف نظيف يمكن حذفه من الأساس:`);
    for (const f of stale) console.log(`   - ${f}`);
  }
  process.exit(0);
}

console.error(`✗ بطاقة مدحرجة يدوياً جديدة — ${findings.length} انتهاك:\n`);
for (const f of findings) console.error(`  ${f}`);
console.error(`
القاعدة: استعمل <Card> بدل <div className="rounded-lg border bg-card …">:

  import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
  <Card>
    <CardHeader><CardTitle>العنوان</CardTitle></CardHeader>
    <CardContent>…</CardContent>
  </Card>

الفائدة: تغييرُ الزاوية/الظلّ/الحدّ مرّةً واحدة يسري على كل الشاشات بدل أن تتخلّف بطاقاتٌ
بمظهرٍ قديم بلا أن يشتكي أحد.

للتحديث بعد الترحيل: node scripts/check-raw-card.mjs --update-baseline
(والرفعُ لا يمرّ — المِسنَنة تقارن المجموع بـorigin/main.)
`);
process.exit(1);
