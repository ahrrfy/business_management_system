#!/usr/bin/env node
// حارِس CI — يمنع استعمال متغيّرات CSS غير معرَّفة (typo) في `client/src/**`.
//
// المشكلة (بأثر رجعي): PR #771 كشف ستّة مواقع تستعمل `var(--sem-warning)` بينما التعريف
// في `tokens.css` هو `--sem-warn`. المتصفّح يُبقي القيمة الافتراضية بلا خطأ ⇒ **العنصر
// غير مرئيّ حرفياً**. الاستمرار في «تحذيرٍ غير مرئيّ» بلا رصدٍ آليّ ممكنٌ لأشهر.
//
// **الحلّ في هذا الملف:**
//   ١) نستخرج **بادئات التوكنز الحاكمة تلقائياً** من `tokens.css` (كلُّ ما يُعرَّف تحت `:root`
//      و`@media (prefers-color-scheme: dark)` و`:root[data-theme…]`) — لا قائمةٌ يدويّة تنجرف.
//   ٢) نتحقّق حتى من `var(--x, fallback)` — الـfallback مقصودٌ للتراجع لا لتغطية typo.
//   ٣) نُصنّف تعريفات CSS إلى **عامّة** (تحت `:root` وأخواتها) و**سياقيّة** (تحت `.class`/id
//      محدَّد كـ`.kioskpc-root` في PriceChecker.css) — لا نُدخل السياقيّة في المجموعة العامّة
//      حتى لا يمرّ استعمالٌ خارج نطاق تعريفه.
//
// النطاق: يمسح `client/src/**/*.{tsx,ts,css,scss}` (يستثني __tests__ و dist و node_modules).

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const SCAN_ROOTS = [path.join(REPO_ROOT, "client", "src")];
const SCAN_EXT = new Set([".ts", ".tsx", ".css", ".scss"]);
const IGNORE_DIRS = new Set(["node_modules", "dist", "__tests__", "build"]);

// المصدر الرسميّ للنطاق المُحرَّس: `tokens.css` — كلّ ما فيه من عائلاتٍ يُعتبر ذا نطاقٍ عامّ
// يجب أن يكون مُعرَّفاً. نستخرج البادئات تلقائياً كي لا ننسى عائلةً (Codex #3 على PR #775: كنت
// أغفلتُ `--pos-*` و`--sec1-*` … `--sec5-*` — الآن تُلتقط تلقائياً من نفس tokens.css).
const TOKENS_CSS = path.join(REPO_ROOT, "client", "src", "lib", "theme", "tokens.css");

// بادئاتٌ يُحقنها المُكوّن (Radix/Tailwind/shadcn sidebar) عند التركيب — ليست تعريفاً في CSS
// ثابت. نتجاهلها كي لا نُنذر كذباً على المستهلكين المشروعين لبيئتها الخاصّة.
const RUNTIME_PROVIDED_PREFIXES = [
  "--radix-", // Radix UI: قياساتٌ للعناصر (popover/select/navigation-menu…)
  "--sidebar-width", // shadcn sidebar: عرضٌ يُحقن ديناميكياً
];
const TAILWIND_UTILITY_TOKENS = new Set([
  "--spacing", // Tailwind v4: spacing utility unit
]);
function isRuntimeProvided(token) {
  if (TAILWIND_UTILITY_TOKENS.has(token)) return true;
  return RUNTIME_PROVIDED_PREFIXES.some((p) => token.startsWith(p));
}

/** بادئة الاسم (كلّ ما قبل الشرطة الأولى بعد `--`)، أو الاسم كاملاً إن بلا شرطة. */
function tokenPrefix(name) {
  // "--sem-warn" → "--sem-", "--sec1-ink" → "--sec1-", "--money-positive" → "--money-"
  const m = name.match(/^(--[a-zA-Z][a-zA-Z0-9]*-)/);
  return m ? m[1] : name;
}

// اشتقاق البادئات المُحرَّسة من tokens.css نفسها. أيّ عائلةٍ معرَّفةٌ هناك تصبح مُلزَمة.
const GUARDED_PREFIXES = new Set();
try {
  const src = readFileSync(TOKENS_CSS, "utf8");
  for (const m of src.matchAll(/(?<![a-zA-Z0-9-])(--[a-zA-Z][a-zA-Z0-9-]*)\s*:/g)) {
    const prefix = tokenPrefix(m[1]);
    GUARDED_PREFIXES.add(prefix);
  }
} catch (e) {
  console.error(`⛔ تعذّرت قراءة tokens.css: ${e.message}`);
  process.exit(2);
}
function isGuarded(token) {
  for (const p of GUARDED_PREFIXES) {
    if (token.startsWith(p)) return true;
  }
  return false;
}

// ============================ جمع التعريفات (مع تمييز النطاق) ============================
//
// نمسك كلّ بلوك CSS `selector { ... --var: … }` ونصنّف:
//   - انتماء **عامّ** إن كان selector = `:root` / `:root:not(...)` / `:root[...]` / بلا selector في
//     `@theme` أو داخل `@media prefers-color-scheme`.
//   - انتماء **سياقيّ** غير ذلك (`.kioskpc-root`, `[data-mobile]`, …) ⇒ لا تُضاف للـglobal.

const globalDefinedTokens = new Set();
const contextuallyDefinedTokens = new Map(); // token → Array<{ selector, file }>
// تعريفاتٌ ذاتُ نطاقٍ في نفس الملفّ (لتفادي false-positive على CSS nesting: تعريفٌ داخل
// `.parent { --x: … }` واستعمالٌ ضمن `.parent .child { … var(--x) … }` — الاستعمال صحيح
// لأن الوراثة سياقيّة، لكن الـselector في الحلقة لا يشمل `.parent`).
const tokensByFile = new Map(); // absoluteFile → Set<token>

function isGlobalSelector(sel) {
  if (!sel) return true; // بلوك بلا selector = @theme/@layer وأخواته
  const s = sel.trim();
  if (s === ":root") return true;
  if (s.startsWith(":root:")) return true;
  if (s.startsWith(":root[")) return true;
  return false;
}

function stripCssComments(src) {
  // نُصفّر تعليقات `/* … */` (كثيرة قبل `:root`) كي لا تُغلب استخراج selector.
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
}

// معالجٌ عودةٌ للكتل: يمرّ على المحتوى العامّ ويستدعي نفسه داخل `@media`/`@supports` — كي يُعامل
// `:root` داخل `@media (prefers-color-scheme: dark)` معاملةَ `:root` العامّ (وهو كذلك سلوكياً
// في المتصفح). الاسم الفرديّ للـat-rule مثل `@keyframes` نتخطّاه (لا يعرّف متغيّراتٍ عامّة).
function parseCssBlock(file, src, isTopLevel) {
  let i = 0;
  while (i < src.length) {
    const brace = src.indexOf("{", i);
    if (brace === -1) break;
    let selStart = brace - 1;
    while (selStart >= 0) {
      const ch = src[selStart];
      if (ch === "}" || ch === "{" || ch === ";") break;
      selStart--;
    }
    const selector = src.substring(selStart + 1, brace).trim();
    let depth = 1;
    let j = brace + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
      j++;
    }
    const body = src.substring(brace + 1, j - 1);

    // at-rules تحوي بلوكاتٍ فرعيّة (@media/@supports/@theme/@layer): كرّر داخلها. النطاق الفعليّ
    // للتعريف هو selector الابن (`:root` مثلاً)، لا at-rule نفسه.
    if (/^@(media|supports|layer|theme)\b/.test(selector)) {
      parseCssBlock(file, body, isTopLevel);
    } else {
      // بلوكٌ عاديّ: التقط تعريفات المتغيّرات مباشرةً.
      for (const m of body.matchAll(/(?<![a-zA-Z0-9-])(--[a-zA-Z][a-zA-Z0-9-]*)\s*:/g)) {
        const token = m[1];
        if (isGlobalSelector(selector)) {
          globalDefinedTokens.add(token);
        } else {
          const list = contextuallyDefinedTokens.get(token) ?? [];
          list.push({ selector, file: path.relative(REPO_ROOT, file).replace(/\\/g, "/") });
          contextuallyDefinedTokens.set(token, list);
        }
        // تتبّع per-file بلا اعتبار للـselector — يغطّي CSS nesting المشروع.
        const fileSet = tokensByFile.get(file) ?? new Set();
        fileSet.add(token);
        tokensByFile.set(file, fileSet);
      }
      // تعرّف على أيّ nesting داخل هذا البلوك أيضاً (‎`.parent { .child { … } }`).
      // نستعمل نفس المعالج على body (يتعامل مع الـchild كأنه بلوكٌ فرعيّ سياقيّ).
      parseCssBlock(file, body, false);
    }
    i = j;
  }
}

function collectFromCss(file, rawSrc) {
  const src = stripCssComments(rawSrc);
  parseCssBlock(file, src, true);
}

function collectFromTsxLike(src) {
  // TSX/TS: تعريفاتٌ inline في `style={{ "--x": v }}` — نعدّها عامّة (أعلى الرأس، لا selector).
  // لا نصنّفها سياقياً؛ الغالب أنها معرَّفة بعنصر فقط لكن يستهلكها CSS أبناءٌ داخله بلا false-positive
  // (لأنّ استهلاكها في نفس عنصر الـstyle أو أبنائه).
  for (const m of src.matchAll(/(?<![a-zA-Z0-9-])(--[a-zA-Z][a-zA-Z0-9-]*)\s*:/g)) {
    globalDefinedTokens.add(m[1]);
  }
}

function walkAndCollect(dir) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) { walkAndCollect(full); continue; }
    const ext = path.extname(entry);
    if (!SCAN_EXT.has(ext)) continue;
    const src = readFileSync(full, "utf8");
    if (ext === ".css" || ext === ".scss") {
      collectFromCss(full, src);
    } else {
      collectFromTsxLike(src);
    }
  }
}

for (const root of SCAN_ROOTS) walkAndCollect(root);

if (globalDefinedTokens.size === 0) {
  console.error("⛔ لم يُعثر على أيّ توكن CSS عامّ — تحقّق من مصادر التوكنز.");
  process.exit(2);
}

// ============================ فحص الاستعمالات ============================
//
// Codex #1 على PR #775: نتحقّق حتى من `var(--x, fallback)` — الـfallback مقصودٌ للتراجع
// إن غاب المتغيّر لأنّ الأصل لم يُوقَد بعد، لا لتغطية typo.

const violations = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) { walk(full); continue; }
    if (!SCAN_EXT.has(path.extname(entry))) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;

    const src = readFileSync(full, "utf8");
    const lines = src.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // نلتقط اسم المتغيّر (المعامل الأوّل لـvar) سواء كان بلا fallback أو معه.
      // نمط: `var(  --name  ` — نتوقّف عند أوّل `)` أو `,` بعد الاسم.
      for (const m of line.matchAll(/var\(\s*(--[a-zA-Z][a-zA-Z0-9-]*)\s*[,)]/g)) {
        const token = m[1];
        if (globalDefinedTokens.has(token)) continue;
        if (isRuntimeProvided(token)) continue;
        if (!isGuarded(token)) continue;
        // تسامُحُ نفس الملفّ: إذا كان معرّفاً في مكانٍ ما داخله (nesting مشروع)، لا تُنذر.
        const inSameFile = tokensByFile.get(full);
        if (inSameFile && inSameFile.has(token)) continue;
        violations.push({
          file: path.relative(REPO_ROOT, full).replace(/\\/g, "/"),
          line: i + 1,
          token,
          scoped: contextuallyDefinedTokens.get(token) ?? null,
        });
      }
    }
  }
}

for (const root of SCAN_ROOTS) walk(root);

if (violations.length === 0) {
  console.log(`✓ فحص متغيّرات CSS: كلّ استعمالات var(--x) بلا typo (${globalDefinedTokens.size} توكن عامّ معرَّف).`);
  process.exit(0);
}

console.error(`⛔ حارس check:css-vars — ${violations.length} استعمال لمتغيّر CSS غير معرَّف عامّاً:\n`);
const byToken = new Map();
for (const v of violations) {
  if (!byToken.has(v.token)) byToken.set(v.token, []);
  byToken.get(v.token).push(v);
}
for (const [token, occ] of byToken) {
  console.error(`  ${token} — ${occ.length} موقع:`);
  for (const v of occ.slice(0, 10)) {
    console.error(`    ${v.file}:${v.line}`);
  }
  if (occ.length > 10) {
    console.error(`    … (${occ.length - 10} أخرى)`);
  }
  const scoped = occ[0].scoped;
  if (scoped && scoped.length > 0) {
    console.error(`    ↳ معرَّفٌ سياقيّاً في: ${scoped.map((s) => `${s.file} (${s.selector})`).join(", ")}`);
    console.error(`      إن كنتَ تستعمله خارج ذلك النطاق، فسيُقرأ **غير معرَّف** في المتصفّح.`);
  } else {
    const suggestion = closestToken(token, globalDefinedTokens);
    if (suggestion) console.error(`    ↳ هل تقصد: ${suggestion}؟`);
  }
  console.error("");
}
console.error(
  "الأثر: متصفّحُ العميل يُبقي القيمة الافتراضية (شفاف/أبيض) بلا خطأ ⇒ العنصر قد يكون غير مرئيّ.\n" +
  "الحلّ: صحّح الاسم إلى التوكن المعرَّف، أو أضف تعريفاً عاماً في client/src/lib/theme/tokens.css.",
);
process.exit(1);

function closestToken(needle, pool) {
  let best = null;
  let bestDist = Infinity;
  for (const t of pool) {
    const d = levenshtein(needle, t);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return bestDist <= 4 ? best : null;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}
