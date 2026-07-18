#!/usr/bin/env node
// حارِس CI — يَمنَع بناء **حدود اليوم بمكوّناتٍ محلية** (تابعة لمنطقة عملية Node) في الخادم.
//
// السبب (تدقيق ١٧/٧، مخاطرة جهازية #٧): النظام يفرض TZ=UTC واتصال القاعدة timezone:"Z"، فـ«اليوم
// التجاريّ» = يوم UTC. لكن الحدود المبنيّة بمكوّناتٍ محلية تَتبع منطقة عملية Node فتنزاح ثلاث ساعات
// (بل يوماً قرب منتصف الليل) على أي جهاز بغير TZ=UTC (تشغيل يدويّ بلا cross-env، أو جهاز متجرٍ ببغداد).
// المصدر الواحد الصحيح: server/services/businessDay.ts (بناءٌ بـDate.UTC، مستقلّ عن المنطقة).
//
// ✅ تحليلٌ بنيويّ (AST عبر مصرّف TypeScript) لا regex — لأن regex يعجز عن تمييز وسائط المنشئ المتداخلة
//    (كشفت المراجعة العدائية ١٧/٧ أن الحارس السابق فاته صنفُ الخلل الذي وُجد فعلاً في promotionsV2Router).
//    يَرصد ثلاثة أنماطٍ خطِرة:
//    ١) `new Date(a, b, …)` بوسيطين فأكثر — منشئ المكوّنات المحلية (البديل الصحيح: `new Date(Date.UTC(y,m,d))`، وسيطٌ واحد).
//    ٢) سلسلة datetime حرفية بلا Z/إزاحة داخل `new Date(… "…T00:00:00" …)` — تُفسَّر محلياً (البديل: أضِف Z).
//    ٣) مُغيِّرات Date المحلية `.setHours/.setMinutes/.setSeconds/.setMilliseconds/.setDate/.setMonth/.setFullYear/.setYear`
//       (لكلٍّ نظيرٌ حتميّ setUTC*).
//    غير مشمول عمداً: `Date.now()+offset ⇒ toISOString` (حتميّ)، و`new Date("YYYY-MM-DD")` (تاريخٌ بلا وقت ⇒ UTC).
//
// النطاق: كامل server/** (تجاهُل *.test.ts ومجلّدات __tests__ وبيتَي المصدر businessDay.ts/dateRange.ts).
// خطّ الأساس فارغ — الشجرة نظيفة بعد ترحيل المخاطرة #٧.
// تحقّقٌ ذاتيّ: `node scripts/check-date-boundaries.mjs --selftest` (يُثبِت رصدَ السيّئ ومرورَ السليم).

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const ROOTS = [path.join(REPO_ROOT, "server")];
const ALLOWED = new Set(["businessDay.ts", "dateRange.ts"]);
const LOCAL_SETTERS = new Set([
  "setHours", "setMinutes", "setSeconds", "setMilliseconds", "setDate", "setMonth", "setFullYear", "setYear",
]);

// خطّ الأساس فارغ. التوقيع = basename|السطر. لا تُضِف — رَحِّل النمط بدلاً من إسكاته.
const BASELINE = new Set([]);

/** يجمع نصوص كل السلاسل الحرفية في شجرةٍ فرعية (لكشف "…T00:00:00" داخل تسلسل +). */
function collectStringLiterals(node, out) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
  else if (ts.isTemplateExpression(node)) {
    out.push(node.head.text);
    for (const span of node.templateSpans) out.push(span.literal.text);
  }
  ts.forEachChild(node, (c) => collectStringLiterals(c, out));
}

/** يفحص مصدر ملفٍ ويعيد [{line, why}] لكل انتهاك. مُصدَّرٌ للتحقّق الذاتيّ. */
export function scanSource(relPath, text) {
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations = [];
  const push = (node, why) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    violations.push({ line: line + 1, why });
  };
  function visit(node) {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date") {
      const args = node.arguments ?? [];
      if (args.length >= 2) {
        push(node, "بناءُ Date بمكوّناتٍ محلية (منشئ ≥٢ وسائط) — استعمل Date.UTC(y, m, d) أو businessDay");
      } else if (args.length === 1) {
        const lits = [];
        collectStringLiterals(args[0], lits);
        const joined = lits.join("");
        // سلسلة تحمل مكوّن وقتٍ (HH:MM) بلا Z ولا إزاحة ⇒ تُفسَّر بمنطقة Node المحلية.
        if (/\d{1,2}:\d{2}/.test(joined) && !/[Zz]/.test(joined) && !/[+\-]\d{2}:?\d{2}/.test(joined)) {
          push(node, "سلسلة datetime تُفسَّر محلياً (بلا Z/إزاحة) — أضِف Z أو استعمل businessDay");
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      LOCAL_SETTERS.has(node.expression.name.text)
    ) {
      push(node, `مُغيِّر Date محليّ (.${node.expression.name.text}) — استعمل نظيره setUTC* أو businessDay`);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return violations;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function main() {
  const violations = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const base = path.basename(file);
      if (ALLOWED.has(base)) continue;
      const rel = path.relative(REPO_ROOT, file);
      for (const v of scanSource(rel, readFileSync(file, "utf8"))) {
        const sig = base + "|" + v.line;
        if (BASELINE.has(sig)) continue;
        violations.push(`${rel}:${v.line}: ${v.why}`);
      }
    }
  }
  if (violations.length) {
    console.error("✗ حارِس حدود اليوم: بناءُ حدّ يومٍ بمكوّناتٍ محلية (يَنزاح على غير TZ=UTC):");
    for (const v of violations) console.error("  " + v);
    console.error(`\n${violations.length} انتهاك. استورد من server/services/businessDay.ts (utcDayStart/utcNextDayStart/utcTodayStart/todayUtcDate) أو ابنِ بـDate.UTC — لا تبنِ حدود اليوم بمكوّناتٍ محلية.`);
    process.exit(1);
  }
  console.log("✓ حارِس حدود اليوم: لا بناءَ حدّ يومٍ بمكوّناتٍ محلية.");
}

/** يُثبِت أن الحارس يرصد الأنماط الخطِرة ويَعبُر الآمنة (يُشغَّل بـ--selftest). */
function selftest() {
  const BAD = [
    ['multi-arg literal', 'const d = new Date(2026, 6, 17);'],
    ['multi-arg vars', 'const d = new Date(y, m, day);'],
    ['multi-arg getters', 'const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());'],
    ['local-parsed T-string', 'const d = new Date(todayYmd + "T00:00:00");'],
    ['local-parsed space-string', 'const d = new Date("2026-07-17 00:00:00");'],
    ['setHours zero', 'd.setHours(0, 0, 0, 0);'],
    ['setHours single', 'd.setHours(0);'],
    ['setMonth', 'd.setMonth(d.getMonth() - 5);'],
    ['setDate', 'd.setDate(1);'],
    ['setFullYear', 'd.setFullYear(2026, 0, 1);'],
  ];
  const GOOD = [
    ['Date.UTC ctor', 'const d = new Date(Date.UTC(y, m - 1, d));'],
    ['Date.UTC nested', 'const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));'],
    ['epoch offset (baghdad)', 'const d = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);'],
    ['T-string with Z', 'const d = new Date(input.from + "T00:00:00Z");'],
    ['T-string with offset', 'const d = new Date(x + "T00:00:00+03:00");'],
    ['date-only string (UTC)', 'const d = new Date("2026-07-17");'],
    ['single var arg', 'const d = new Date(i.toDate);'],
    ['no-arg now', 'const d = new Date();'],
    ['setUTCHours ok', 'd.setUTCHours(0, 0, 0, 0);'],
    ['setUTCMonth ok', 'cur.setUTCMonth(cur.getUTCMonth() + 1);'],
    ['getUTCDay read', 'return WEEK_DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];'],
  ];
  let ok = true;
  for (const [name, src] of BAD) {
    if (scanSource("x.ts", src).length === 0) { console.error(`  MISS (should flag): ${name} — ${src}`); ok = false; }
  }
  for (const [name, src] of GOOD) {
    const v = scanSource("x.ts", src);
    if (v.length) { console.error(`  FALSE-POS (should pass): ${name} — ${src} :: ${v.map((x) => x.why).join("; ")}`); ok = false; }
  }
  if (!ok) { console.error("✗ selftest فشل — الحارس يُصنّف خطأً."); process.exit(1); }
  console.log(`✓ selftest: ${BAD.length} نمطاً خطِراً رُصِد، ${GOOD.length} آمناً عَبَر.`);
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
