#!/usr/bin/env node
// حارس منع سلاسل التحميل الحرفيّة — يمنع «جارٍ التحميل…»/«جارٍ الحفظ…» يدوياً في `client/src/pages/**`.
//
// السبب (مسح ٢٧/٨/٢٦): ١٠٢ استعمال لسلاسل التحميل بأشكالٍ منجرفة:
//   • «جارٍ التحميل…» ≠ «جار التحميل» ≠ «جارى التحميل» ≠ «يجري التحميل»
//   • «جارٍ الحفظ…» ≠ «جار الحفظ» ≠ «جاري الحفظ»
// النصّ لا يتّسق بين الشاشات ⇒ مطابقة الاختبارات هشّة، الترجمة تحتاج تعديل ١٠٢ موضع.
//
// البديل: `ACTION_LABELS` من `@shared/actionLabels`:
//   import { ACTION_LABELS as L } from "@shared/actionLabels";
//   {m.isPending ? L.saving : L.save}
//
// النطاق: `client/src/pages/**/*.tsx` — الشاشات فقط. المكوّنات المشتركة قد تحوي نصوصاً بنيوية.
// خطّ الأساس مجمَّد في `scripts/loading-strings-baseline.json` — يُخفَّض بالترحيل إلى القاموس.

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(REPO_ROOT, "client", "src", "pages");
const BASELINE_PATH = path.join(__dirname, "loading-strings-baseline.json");
const UPDATE = process.argv.includes("--update-baseline");

const BASELINE = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : {};

// نصوصٌ مرفوضة — نطاقٌ ضيّق ومحدَّد. نتغاضى عن نصوصٍ متعدّدة الاستعمال (مثل «تحميل» وحده).
const REJECTED_PATTERNS = [
  /جارٍ التحميل/g,
  /جار التحميل/g,
  /جارى التحميل/g,
  /يجري التحميل/g,
  /جارٍ الحفظ/g,
  /جار الحفظ/g,
  /جاري الحفظ/g,
  /يجري الحفظ/g,
  /جارٍ الإرسال/g,
  /جار الإرسال/g,
  /جاري الإرسال/g,
];

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

const current = new Map();
for (const file of walkTsx(SCAN_ROOT)) {
  const rel = relOf(file);
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    /*
     * ⚠️ **وتعليقُ JSX `{/* … *\/}` كذلك** (٢/٩/٢٦): كانت الثلاثةُ أدناه تُسقط `//` و`*`
     * و`/*` وحدها، فبقي تعليقُ JSX يُفحَص كأنّه شيفرة — وهو الشكل الأشيع في `client/**`.
     * والنتيجة إنذارٌ كاذب: `GiftsHub.tsx` بقي في خطّ الأساس بمخالفةٍ واحدة بعد ترحيله
     * كاملاً إلى `ACTION_LABELS`، ومَصدرُها **تعليقان** يشرحان الترحيل نفسه ويقتبسان
     * «جارٍ» ليوضّحا الإملاء. أي أنّ الحارس كان يطالب بإصلاح ما أصلحه المُرحِّل للتوّ.
     * والإنذارُ الكاذب أسوأ من الصمت: يدفع إلى تشويه تعليقٍ صحيحٍ للتملّص منه.
     * (نفسُ العلّة أُصلحت في `check-no-window-dialogs.mjs` على `Vouchers.tsx`.)
     */
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("{/*")
    ) continue;
    for (const rx of REJECTED_PATTERNS) {
      rx.lastIndex = 0;
      const m = line.match(rx);
      if (m) count += m.length;
    }
  }
  if (count > 0) current.set(rel, count);
}

if (UPDATE) {
  const asObj = Object.fromEntries([...current.entries()].sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_PATH, JSON.stringify(asObj, null, 2) + "\n", "utf8");
  const total = [...current.values()].reduce((s, n) => s + n, 0);
  console.log(`✓ حُدِّث خطّ الأساس: ${current.size} ملفاً · ${total} استعمالاً مجمَّداً.`);
  process.exit(0);
}

const findings = [];
for (const [file, count] of current) {
  const allowed = BASELINE[file] ?? 0;
  if (count > allowed) {
    findings.push({
      file,
      message: allowed === 0
        ? `${file}: ${count} سلسلة تحميل جديدة (خطّ الأساس ٠) ⇒ استعمل ACTION_LABELS من @shared/actionLabels`
        : `${file}: ${count} (الأساس ${allowed}، +${count - allowed})`,
    });
  }
}

const stale = Object.keys(BASELINE).filter((f) => !current.has(f));

if (findings.length === 0) {
  console.log(`✓ سلاسل التحميل موحّدة — ${current.size} ملف ضمن خطّ الأساس.`);
  if (stale.length > 0) {
    console.log(`ℹ️  ${stale.length} ملف نظيف يمكن حذفه من الأساس:`);
    for (const f of stale) console.log(`   - ${f}`);
  }
  process.exit(0);
}

console.error(`✗ استعمال سلسلة تحميل يدويّة جديدة — ${findings.length} انتهاك:\n`);
for (const f of findings) console.error(`  ${f.message}`);
console.error(`
القاعدة: استعمل \`ACTION_LABELS\` من \`@shared/actionLabels\`:

  import { ACTION_LABELS as L } from "@shared/actionLabels";
  <SubmitButton pending={m.isPending} pendingText={L.saving}>{L.save}</SubmitButton>

المفاتيح المتاحة: loading/saving/sending/deleting/uploading/exporting/…
النصوص موحّدة بحرف واحد («جارٍ» بألف واحدة) وشرطة عمودية عربية.

للتحديث بعد الترحيل: node scripts/check-loading-strings.mjs --update-baseline
`);
process.exit(1);
