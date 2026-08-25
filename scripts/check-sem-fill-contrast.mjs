#!/usr/bin/env node
// حارِس CI — يمنع النمط `bg-[var(--sem-*)] text-white` الذي يفشل تباين WCAG في الوضع الليليّ.
//
// **الجذر** (أمسكه Codex ٤ مرّات: PR #800 · #801 · #812 · #813):
// توكنات `--sem-{pos,neg,warn,info,danger}` تُقلَب في الوضع الليليّ إلى ألوانٍ فاتحة
// (`oklch(0.725/0.740/0.800 …)`) كي يقرأها نصٌّ داكن. النصّ الأبيض عليها يعطي 1.9-2.8:1 —
// دون WCAG AA (4.5:1 للنصّ العاديّ، 3:1 للكبير).
//
// **الحلّ:** `text-background` يعكس الوضع دائماً (كريميّ فاتح في الفاتح، شبه أسود في الغامق)
// ⇒ تباين WCAG صحيح في كلا الوضعَين. النمط الرسميّ:
//   `bg-[var(--sem-*)] text-background hover:bg-[var(--sem-*)]/90`
// أو استعمل `<Button variant="success/warning/info/destructive">` (أُضيف على PR #802).
//
// **النطاق:** `client/src/**` كاملاً. المُستَثنى:
//   - `client/src/pages/store/**` — واجهة المتجر بتوكناتها الخاصّة (store-*)
//   - `client/src/pages/Storefront.tsx` — واجهة المتجر (متوقّعٌ استثناؤها لاحقاً بتوكن مستقل)
//   - `client/src/pages/MobileDesignPreview.tsx` — معاينة تصميم موبايل
//
// المصفوفة لا تُغلَق بتلقائيّة لأنّ raw <span>/<div> لا يمرّ بمتغيّرات Button — النمط
// نصّيّ لا سلوكيّ، والحارس نصّيٌّ يعالج ذلك مباشرةً.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CLIENT_ROOT = path.join(REPO_ROOT, "client", "src");

const EXCLUDE_PATH_PARTS = [
  path.join("pages", "store"),
  path.join("pages", "Storefront.tsx"),
  path.join("pages", "MobileDesignPreview.tsx"),
];

// نمط: `bg-[var(--sem-X)]` يليه أيّ شيء (بلا فواصل مسارٍ حدّية) ثمّ `text-white` قبل نهاية className.
// نستعمل نصفَ نافذةٍ ٢٠٠ حرف بعد `bg-` (يكفي تكوينات className متعدّدة الفئات).
const PATTERN = /bg-\[var\(--sem-(?:pos|neg|warn|info|danger)\)\][^"'`{}]{0,200}text-white\b/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.relative(CLIENT_ROOT, full);
    // استثناءات بالمسار
    if (EXCLUDE_PATH_PARTS.some((ex) => rel.startsWith(ex))) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx") || full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const violations = [];
for (const file of walk(CLIENT_ROOT)) {
  const source = readFileSync(file, "utf8");
  for (const m of source.matchAll(PATTERN)) {
    const line = source.substring(0, m.index).split("\n").length;
    violations.push({
      file: path.relative(REPO_ROOT, file),
      line,
      snippet: m[0].length > 100 ? `${m[0].slice(0, 100)}…` : m[0],
    });
  }
}

if (violations.length === 0) {
  console.log("✓ فحص التباين على تعبئات sem: صفر مواقع تحمل `bg-[var(--sem-*)] text-white`.");
  process.exit(0);
}

console.error(`⛔ حارس check:sem-fill-contrast — ${violations.length} موقع(اً) يحمل النمط الممنوع:\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    ${v.snippet}`);
  console.error("");
}
console.error("السبب:");
console.error("  `--sem-*` في الوضع الليليّ = ألوان فاتحة (oklch 0.725+). text-white عليها = 1.9-2.8:1 (دون WCAG).");
console.error("");
console.error("الحلّ:");
console.error("  استبدل `text-white` بـ`text-background` — يعكس الوضع دائماً فيبقى التباين صحيحاً.");
console.error("  أو استعمل `<Button variant=\"success|warning|info|destructive\">` (PR #802).");
console.error("");
console.error("مثال:");
console.error("  BEFORE: className=\"bg-[var(--sem-neg)] text-white hover:opacity-90\"");
console.error("  AFTER:  className=\"bg-[var(--sem-neg)] text-background hover:bg-[var(--sem-neg)]/90\"");
process.exit(1);
