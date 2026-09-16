#!/usr/bin/env node
// حارس منع window.confirm/prompt/alert — يمنع الاستعمال الجديد في `client/src/**`.
//
// السبب:
//   - `window.confirm`: حوارٌ متزامنٌ يجمّد الواجهة، لا يدعم RTL جيّداً، style افتراضي المتصفّح
//     متباين، لا يحمل هوية النظام، ولا يمكن اختباره في vitest بلا mock.
//   - `window.prompt`: نفس المشاكل + النصّ يعود بلا تطبيع (أرقام هندية، spaces).
//   - `window.alert`: حوار قذر — استعمل `notify.err/info` من `@/lib/notify` بدلاً منه.
//
// البديل: `confirm({...})` من `@/lib/confirm` — حوار احترافيّ مبنيّ على AlertDialog:
//   - RTL native + hoby النظام + `data-theme` aware
//   - يقبل `variant: "danger"|"warning"|"info"` + `requireText` للحذف الخطر
//   - يعود Promise<boolean> — أنسب لـasync/await من `if (!confirm(...))`
//   - قابل للاختبار بـmock بسيط
//
// النطاق: `client/src/**/*.tsx?` — الشيفرة الأمامية فقط.
// (الخادم يستعمل `notify.err` عبر tRPC error؛ لا `window` هناك.)
//
// خطّ الأساس مجمَّد في `scripts/window-dialogs-baseline.json` — يُخفَّض بالترحيل إلى `confirm` المشترك.

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(REPO_ROOT, "client", "src");
const BASELINE_PATH = path.join(__dirname, "window-dialogs-baseline.json");
const UPDATE = process.argv.includes("--update-baseline");

const BASELINE = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : {};

// أنماط الرفض — window.confirm/prompt/alert مع open paren.
const DIALOG_RE = /\bwindow\.(confirm|prompt|alert)\s*\(/g;

function* walkCode(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "_legacy" || entry.name === "dist" || entry.name === "__tests__") continue;
      yield* walkCode(full);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      yield full;
    }
  }
}

const relOf = (full) => path.relative(REPO_ROOT, full).replace(/\\/g, "/");

const current = new Map();
for (const file of walkCode(SCAN_ROOT)) {
  const rel = relOf(file);
  // نستثني confirm.ts نفسه — قد يذكر `window.confirm` نصّاً في تعليقٍ.
  if (rel === "client/src/lib/confirm.ts") continue;
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    /*
     * ⚠️ **وتعليقُ JSX `{/* … *\/}` كذلك** (٢/٩/٢٦): كانت الأسطر الثلاثة أدناه تُسقط
     * `//` و`*` و`/*` وحدها، فبقي تعليقُ JSX يُفحَص كأنّه شيفرة. والنتيجةُ إنذارٌ كاذب:
     * `Vouchers.tsx` كان في خطّ الأساس بمخالفةٍ واحدة، وهي **تعليق** يقول «بديل
     * window.prompt (سجل تدقيقيّ إلزاميّ)» — والقوس بعد الاسم يُطابق النمط. فالملفّ لم
     * يحمل حواراً حقيقياً قطّ، والحارسُ كان يطالب بإصلاح ما ليس معطوباً.
     * والإنذارُ الكاذب أسوأ من الصمت: يدفع إلى تشويه تعليقٍ صحيحٍ للتملّص منه.
     */
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("{/*")
    ) continue;
    // اقتطاع كل نصٍّ بعد `//` في السطر — تعليقٌ خلفيّ قد يذكرها.
    // ونزعُ تعليقات JSX المضمَّنة في وسط السطر كذلك.
    const codeOnly = line.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").split("//")[0];
    DIALOG_RE.lastIndex = 0;
    const matches = codeOnly.match(DIALOG_RE);
    if (matches) count += matches.length;
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
        ? `${file}: ${count} استعمال جديد لـwindow.confirm/prompt/alert (خطّ الأساس ٠) ⇒ استعمل confirm() من @/lib/confirm`
        : `${file}: ${count} (الأساس ${allowed}، +${count - allowed})`,
    });
  }
}

const stale = Object.keys(BASELINE).filter((f) => !current.has(f));

if (findings.length === 0) {
  console.log(`✓ منع حوارات المتصفّح محفوظ — ${current.size} ملف ضمن خطّ الأساس.`);
  if (stale.length > 0) {
    console.log(`ℹ️  ${stale.length} ملف نظيف يمكن حذفه من الأساس:`);
    for (const f of stale) console.log(`   - ${f}`);
  }
  process.exit(0);
}

console.error(`✗ استعمال window.confirm/prompt/alert جديد — ${findings.length} انتهاك:\n`);
for (const f of findings) console.error(`  ${f.message}`);
console.error(`
القاعدة: استعمل \`confirm()\` من \`@/lib/confirm\` بدل \`window.confirm/prompt/alert\`:

  import { confirm } from "@/lib/confirm";
  if (!(await confirm({
    variant: "danger",
    title: "حذف الفاتورة",
    description: "لا يمكن التراجع عن هذه العملية.",
    confirmText: "حذف نهائيّ",
  }))) return;

الفوائد: RTL + هويّة النظام + قابل للاختبار + Promise<boolean> بلا تجميد.

للتحديث بعد الترحيل: node scripts/check-no-window-dialogs.mjs --update-baseline
`);
process.exit(1);
