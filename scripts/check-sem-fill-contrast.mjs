#!/usr/bin/env node
// حارِس CI — يمنع النمط `bg-[var(--sem-*)] + text-white` الذي يفشل تباين WCAG في الوضع الليليّ.
//
// **الجذر** (أمسكه Codex ٤ مرّات: PR #800 · #801 · #812 · #813):
// توكنات `--sem-{pos,neg,warn,info,danger}` تُقلَب في الوضع الليليّ إلى ألوانٍ فاتحة
// (`oklch(0.725/0.740/0.800 …)`) كي يقرأها نصٌّ داكن. النصّ الأبيض عليها يعطي 1.9-2.8:1 —
// دون WCAG AA (4.5:1 للنصّ العاديّ، 3:1 للكبير).
//
// **الحلّ:** `text-background` يعكس الوضع دائماً ⇒ تباين WCAG صحيح. النمط الرسميّ:
//   `bg-[var(--sem-*)] text-background hover:bg-[var(--sem-*-hover)]`
// أو استعمل `<Button variant="success/warning/info/destructive">` (PR #802).
//
// **الاكتشاف order-agnostic** (Codex #815 P2): نمسك التعبئة و`text-white` في نفس className
// بغضّ النظر عن الترتيب أو المحرفات بينهما — يشمل `cn("text-white", "bg-[var(--sem-*)]")`
// و`cn("bg-…", "text-white")` وكل تركيبات المُنشئ التي كان الregex الخطّي يفوتها.
//
// **النطاق:** `client/src/**` كاملاً. لا استثناءات (Codex #815: الاستثناءات تُخفي انتهاكاتٍ
// حقيقيّة — Storefront.tsx كان يحمل ٢ منها على sem-pos غير المُعاد تعريفه لواجهة المتجر).

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CLIENT_ROOT = path.join(REPO_ROOT, "client", "src");

// نمطُ التعبئة (يظهر كصنفٍ Tailwind arbitrary): `bg-[var(--sem-{pos|neg|warn|info|danger})]`
const SEM_BG_RE = /bg-\[var\(--sem-(?:pos|neg|warn|info|danger)\)\]/;
// نمطُ النصّ الأبيض (لا `text-background` ولا `dark:text-white`): بحثٌ على حدودٍ صريحة
// كي لا يلتقط `text-white/50` (يقصر التبايناً إضافياً) ونعتبره منتهكاً أيضاً — لكن أيضاً كي
// لا نلتقط سلاسل داخل تعليقاتٍ محتوية على "text-white" في نصّ رمزيّ.
const TEXT_WHITE_RE = /\btext-white\b/;

// **قلبُ الاكتشاف** — نمرّ على كلّ تعبيرِ سلسلةٍ نصيّة، وننظر إن كان يحمل الاثنَين معاً.
// نلتقط:
//   1) قيمُ className المباشرة: className="…" | className={"…"} | className={`…`}
//   2) نصوصُ cn(...) و clsx(...): cn("…", "…") ⇒ نمسحُ داخل الأقواس ما بين كل زوج ".
// المسحُ نصّيٌّ محضٌ (لا AST) — يكفي هنا لأنّ Tailwind classes تُكتب دائماً كنصّ حرفيّ.

/** يستخرج كلّ سلاسل النصوص الحرفيّة من مصدر tsx واحد (استعمال Tailwind = classes كنصّ). */
function extractStringLiterals(source) {
  const out = [];
  const re = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    out.push({ text: m[2], index: m.index });
  }
  return out;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx") || full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const violations = [];
for (const file of walk(CLIENT_ROOT)) {
  const source = readFileSync(file, "utf8");
  // فحصٌ سريعٌ أوّل: لو الملفّ لا يحمل التعبئة أصلاً، نتجاوزه.
  if (!SEM_BG_RE.test(source)) continue;
  const literals = extractStringLiterals(source);
  for (const { text, index } of literals) {
    if (SEM_BG_RE.test(text) && TEXT_WHITE_RE.test(text)) {
      const line = source.substring(0, index).split("\n").length;
      violations.push({
        file: path.relative(REPO_ROOT, file),
        line,
        snippet: text.length > 120 ? `${text.slice(0, 120)}…` : text,
      });
    }
  }
}

if (violations.length === 0) {
  console.log("✓ فحص التباين على تعبئات sem: صفر مواقع تحمل `bg-[var(--sem-*)] + text-white`.");
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
console.error("  AFTER:  className=\"bg-[var(--sem-neg)] text-background hover:bg-[var(--sem-neg-hover)]\"");
process.exit(1);
