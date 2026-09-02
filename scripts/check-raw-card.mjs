#!/usr/bin/env node
// حارِس CI — يمنع بطاقةً مدحرجةً يدوياً جديدة في `client/src/pages/**`، والبديل `<Card>`.
//
// السبب (بلاغ المالك بخمس لقطات، ٣١/٨/٢٦): «الشاشات لا تتبع مكوّناً موحّداً». والقياس
// يؤيّده جزئياً فقط: `<Card>` من `@/components/ui/card` **مُتبنّى فعلاً في ١٧٠ صفحة**،
// مقابل ٦٩ بطاقةً مدحرجةً بيدٍ في ٣١ ملفاً. فالمكوّن ليس ناقصاً — الانحرافُ هو المشكلة.
//
// ولماذا يهمّ الانحراف: `<div className="rounded-lg border bg-card p-4">` يبدو اليوم مطابقاً
// لِـ`<Card>`، ثمّ يتغيّر نصفُ قطر الزاوية أو الظلّ أو الحدّ في `card.tsx` مرّةً واحدة —
// فتتبعه ١٧٠ صفحة وتتخلّف ٦٩ بطاقةً بمظهرٍ قديمٍ **بلا أن يشتكي أحد**. وهذا بالضبط شكلُ
// «عدم الاتّساق» الذي رآه المالك في لقطاته: لا خطأ بيّن، بل درجاتٌ متفاوتة من الشيء نفسه.
//
// ⚠️ **ولا يُحوَّل القائم دفعةً واحدة**: `<Card>` يجرّ `CardHeader/CardContent` بحشوتها
// الخاصّة، وكثيرٌ من هذه الـ٦٩ لوحاتٌ صغيرة بحشوةٍ مضبوطة يدوياً — فالتحويل الأعمى يزيح
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(REPO_ROOT, "client", "src", "pages");
const BASELINE_PATH = path.join(__dirname, "raw-card-baseline.json");
const UPDATE = process.argv.includes("--update-baseline");

const BASELINE = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : {};

// الزاوية + الحدّ + خلفية البطاقة في صنفٍ واحد، بأيّ ترتيب.
const CARD_RE =
  /className="(?=[^"]*\brounded-(?:lg|xl|2xl)\b)(?=[^"]*\bborder\b)(?=[^"]*\bbg-card\b)[^"]*"/g;

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
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    // التعليقات لا تُحسَب — الإنذارُ الكاذب يدفع إلى تشويه تعليقٍ صحيحٍ للتملّص منه
    // (أمسك هذا الشكلَ بعينه حارسُ `check:no-window-dialogs` على `Vouchers.tsx`).
    if (["//", "*", "/*", "{/*"].some((p) => trimmed.startsWith(p))) continue;
    const codeOnly = line.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").split("//")[0];
    CARD_RE.lastIndex = 0;
    const m = codeOnly.match(CARD_RE);
    if (m) count += m.length;
  }
  if (count > 0) current.set(relOf(file), count);
}

if (UPDATE) {
  const asObj = Object.fromEntries([...current.entries()].sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_PATH, JSON.stringify(asObj, null, 2) + "\n", "utf8");
  const total = [...current.values()].reduce((s, n) => s + n, 0);
  console.log(`✓ حُدِّث خطّ الأساس: ${current.size} ملفاً · ${total} بطاقةً مجمَّدة.`);
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

const stale = Object.keys(BASELINE).filter((f) => !current.has(f));

if (findings.length === 0) {
  const total = [...current.values()].reduce((s, n) => s + n, 0);
  console.log(`✓ عقد البطاقة محفوظ — ${current.size} ملف · ${total} بطاقة ضمن خطّ الأساس.`);
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
`);
process.exit(1);
