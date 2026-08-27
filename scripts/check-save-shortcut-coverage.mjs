#!/usr/bin/env node
// حارس تغطية `useSaveShortcuts` — يرصد `<form onSubmit>` في `client/src/pages/*New.tsx` و
// `*Edit.tsx` بلا استعمال `useSaveShortcuts` من `@/hooks/useSaveShortcuts`.
//
// السبب: الاختصار Ctrl+S للحفظ **معيار عالميّ** للنماذج، ونحن نستعمله في ٩ نماذج فقط من ~٤٠.
// الموظّف يبني عادةً لديه (كان يستعملها في نموذج فأصبحت متوقّعة). غيابها في نموذجٍ آخر يقطع
// التدفّق ويجبره على استعمال الفأرة.
//
// القاعدة الشكلية:
//   • ملف مسمّى `*New.tsx` أو `*Edit.tsx` أو `*Detail.tsx` (فقط الشاشات المعدَّة للتحرير)
//   • يحوي `<form onSubmit=` أو `<form.*onSubmit`
//   ⇒ يجب أن يستورد `useSaveShortcuts` من `@/hooks/useSaveShortcuts`
//
// النطاق: `client/src/pages/**/*.tsx`. المكوّنات المشتركة خارج النطاق (نموذج داخل مكوّن).
// خطّ الأساس مجمَّد في `scripts/save-shortcut-coverage-baseline.json` — يُخفَّض بالترحيل.

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(REPO_ROOT, "client", "src", "pages");
const BASELINE_PATH = path.join(__dirname, "save-shortcut-coverage-baseline.json");
const UPDATE = process.argv.includes("--update-baseline");

const BASELINE = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : {};

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

// نطاق الشاشات المُعدَّة للتحرير: New/Edit (تحوي نماذج غالباً).
// Detail أُقصي: كثيرٌ منها للعرض بلا نماذج (RoleDetail، إلخ).
const EDITOR_PATTERN = /\/[A-Z][A-Za-z0-9]*(New|Edit)\.tsx$/;

// كشف `<form onSubmit=…>` بأمانةٍ عن السطر المتعدّد (يشمل props بعده).
// نبحث على مستوى الملف كاملاً بـmultiline flag.
const FORM_ONSUBMIT_RE = /<form\b[^>]*onSubmit\s*=/s;
const USE_SAVE_SHORTCUTS_IMPORT_RE = /from\s+["']@\/hooks\/useSaveShortcuts["']/;

const current = new Map();
for (const file of walkTsx(SCAN_ROOT)) {
  const rel = relOf(file);
  if (!EDITOR_PATTERN.test(rel)) continue;
  const text = readFileSync(file, "utf8");
  const hasForm = FORM_ONSUBMIT_RE.test(text);
  const hasHook = USE_SAVE_SHORTCUTS_IMPORT_RE.test(text);
  if (hasForm && !hasHook) {
    current.set(rel, 1);
  }
}

if (UPDATE) {
  const asObj = Object.fromEntries([...current.entries()].sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_PATH, JSON.stringify(asObj, null, 2) + "\n", "utf8");
  console.log(`✓ حُدِّث خطّ الأساس: ${current.size} ملفاً بلا useSaveShortcuts.`);
  process.exit(0);
}

const findings = [];
for (const [file] of current) {
  if (!(file in BASELINE)) {
    findings.push({
      file,
      message: `${file}: <form onSubmit> بلا useSaveShortcuts — أضف Ctrl+S`,
    });
  }
}

const stale = Object.keys(BASELINE).filter((f) => !current.has(f));

if (findings.length === 0) {
  console.log(`✓ تغطية useSaveShortcuts محفوظة — ${current.size} ملف ضمن خطّ الأساس.`);
  if (stale.length > 0) {
    console.log(`ℹ️  ${stale.length} ملف نظيف يمكن حذفه من الأساس:`);
    for (const f of stale) console.log(`   - ${f}`);
  }
  process.exit(0);
}

console.error(`✗ ملف جديد بـ<form onSubmit> بلا useSaveShortcuts — ${findings.length} انتهاك:\n`);
for (const f of findings) console.error(`  ${f.message}`);
console.error(`
القاعدة: أضف Ctrl+S للنماذج الجديدة:

  import { useSaveShortcuts } from "@/hooks/useSaveShortcuts";

  useSaveShortcuts({ onSave: () => submit(), enabled: !mutation.isPending });

الفائدة: تدفّق موحّد — الموظّف يعرف Ctrl+S يعمل في كل نموذج.

للتحديث بعد الترحيل: node scripts/check-save-shortcut-coverage.mjs --update-baseline
`);
process.exit(1);
