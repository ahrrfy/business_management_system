#!/usr/bin/env node
// حارِس CI — يمنع استعمال متغيّرات CSS غير معرَّفة (typo) في `client/src/**`.
//
// المشكلة (بأثر رجعي): PR #771 كشف ستّة مواقع تستعمل `var(--sem-warning)` بينما التعريف
// في `tokens.css` هو `--sem-warn`. المتصفّح يُبقي القيمة الافتراضية بلا خطأ ⇒ **العنصر
// غير مرئيّ حرفياً**. الاستمرار في «تحذيرٍ غير مرئيّ» بلا رصدٍ آليّ ممكنٌ لأشهر.
//
// النطاق: يمسح كلّ استعمالٍ `var(--tokenName)` في `client/src/**/*.{tsx,ts,css,scss}`،
// ويطابقه مع التعريفات في:
//   - `client/src/lib/theme/tokens.css` (التوكنز الدلاليّة الموحّدة)
//   - `client/src/lib/theme/comfort.css` (مسافات وسلالم الراحة)
//   - `client/src/index.css` (متغيّرات shadcn/root — --primary/--foreground/…)
//
// ما يُتجاهَل: الاستعمالات داخل `var(--x, fallback)` تُقبل حتى لو `--x` غير معرَّف — لأنّ
// الـfallback مقصود. والمتغيّرات الديناميكيّة (مبنيّة بـtemplate literal) تفلت بلا false-positive.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const SCAN_ROOTS = [path.join(REPO_ROOT, "client", "src")];
const SCAN_EXT = new Set([".ts", ".tsx", ".css", ".scss"]);
const IGNORE_DIRS = new Set(["node_modules", "dist", "__tests__", "build"]);

// بادئاتٌ يُحقنها المُكوّن (Radix/Tailwind/shadcn sidebar) عند التركيب — ليست تعريفاً في CSS
// ثابت. نتجاهلها كي لا نُنذر كذباً على المستهلكين المشروعين لبيئتها الخاصّة.
const RUNTIME_PROVIDED_PREFIXES = [
  "--radix-", // Radix UI: قياساتٌ للعناصر (popover trigger, select trigger, navigation-menu viewport…)
  "--sidebar-width", // shadcn sidebar: عرضٌ يُحقن ديناميكياً
];

// أسماءُ توكنز تولّدها Tailwind v4 كأدواتٍ زوداً (utility tokens) بلا تعريفٍ في our tokens.css.
const TAILWIND_UTILITY_TOKENS = new Set([
  "--spacing", // spacing utility unit
]);

function isRuntimeProvided(token) {
  if (TAILWIND_UTILITY_TOKENS.has(token)) return true;
  return RUNTIME_PROVIDED_PREFIXES.some((p) => token.startsWith(p));
}

// النطاقُ المُحرَّس: بادئاتٌ تخصّ نظامَ توكنز التصميم في هذا المستودع (tokens.css/comfort.css).
// أيّ متغيّر بهذه البادئات **يجب** أن يكون معرَّفاً؛ غيرها (متغيّرات محلّية/دايناميكية على العناصر
// مثل `--paper`/`--ink`/`--secN-ink` على JobApply أو Dashboard) خارج النطاق كي لا نُنذر كذباً.
// النمط الذي أوقعنا فيه بلاغ PR #771 (`--sem-warning` بدل `--sem-warn`) يقع ضمن `--sem-*` تحديداً.
const GUARDED_PREFIXES = [
  "--sem-",     // الدلالية الموحّدة (pos/neg/warn/info + ‎-bg)
  "--money-",   // ألوان المال (positive/negative/neutral)
  "--status-",  // شارات الحالة (pending/active/done/cancelled)
  "--stock-",   // مؤشرات المخزون (ok/low/out)
  "--brand-",   // العلامات (whatsapp/…)
  "--chart-",   // ألوان الرسوم (cash/card/…)
  "--dash-",    // خلفيات لوحة القيادة
];
function isGuarded(token) {
  return GUARDED_PREFIXES.some((p) => token.startsWith(p));
}

// جمع كلّ التوكنز المعرَّفة من كلّ ملفّات CSS تحت client/src/** (يشمل tokens.css/comfort.css/
// index.css وأيّ CSS مخصّصة لصفحة/مكوّن — مثل PriceChecker.css التي تُعرّف --brand-weak محلّياً).
// نُلحق أيضاً تعريفاتٍ داخل نصوصٍ style في ملفات TSX (نمط `--var: value` داخل style={{}}).
const definedTokens = new Set();
function collectDefinitionsFrom(file) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/(?<![a-zA-Z0-9-])(--[a-zA-Z][a-zA-Z0-9-]*)\s*:/g)) {
    definedTokens.add(m[1]);
  }
}

const violations = [];

// المرور الأوّل: جمعُ التعريفات من كلّ ملفات CSS/TSX/TS. TSX/TS تحوي أحياناً تعريفاتٍ inline
// عبر `style={{ "--x": v }}` أو strings CSS معلَّقة.
function collectDefsWalk(dir) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) { collectDefsWalk(full); continue; }
    if (!SCAN_EXT.has(path.extname(entry))) continue;
    collectDefinitionsFrom(full);
  }
}
for (const root of SCAN_ROOTS) collectDefsWalk(root);

if (definedTokens.size === 0) {
  console.error("⛔ لم يُعثر على أيّ توكن CSS معرَّف — تحقّق من مصادر التوكنز.");
  process.exit(2);
}

// المرور الثاني: البحث عن استعمالاتٍ لتوكنٍ غير معرَّف.
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      walk(full);
      continue;
    }
    if (!SCAN_EXT.has(path.extname(entry))) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;

    const src = readFileSync(full, "utf8");
    const lines = src.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const m of line.matchAll(/var\(\s*(--[a-zA-Z][a-zA-Z0-9-]*)\s*\)/g)) {
        const token = m[1];
        if (definedTokens.has(token)) continue;
        if (isRuntimeProvided(token)) continue;
        if (!isGuarded(token)) continue;
        violations.push({
          file: path.relative(REPO_ROOT, full).replace(/\\/g, "/"),
          line: i + 1,
          token,
        });
      }
    }
  }
}

for (const root of SCAN_ROOTS) walk(root);

if (violations.length === 0) {
  console.log(`✓ فحص متغيّرات CSS: كلّ استعمالات var(--x) بلا fallback مطابقةٌ لتعريفٍ موجود (${definedTokens.size} توكن معرَّف).`);
  process.exit(0);
}

console.error(`⛔ حارس check:css-vars — ${violations.length} استعمال لمتغيّر CSS غير معرَّف:\n`);
// نجمّع لكلّ توكن غير معرَّف لوصفٍ نظيف.
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
  // اقتراحُ الاسم الأقرب من المعرَّفات (Levenshtein بسيط) لتسهيل الإصلاح.
  const suggestion = closestToken(token, definedTokens);
  if (suggestion) console.error(`    ↳ هل تقصد: ${suggestion}؟`);
  console.error("");
}
console.error(
  "الأثر: متصفّحُ العميل يُبقي القيمة الافتراضية (شفاف/أبيض) بلا خطأ ⇒ العنصر قد يكون غير مرئيّ.\n" +
  "الحلّ: صحّح الاسم إلى التوكن المعرَّف، أو أضف تعريفاً في client/src/lib/theme/tokens.css.",
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
  // نقبل الاقتراح فقط إن كان قريباً معنويّاً (≤٤ محرف اختلاف)
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
