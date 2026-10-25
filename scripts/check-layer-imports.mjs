#!/usr/bin/env node
/**
 * حارس حدود الطبقات (Wave D2) — يمنع استيراد `drizzle/*Schema` أو `server/db` مباشرةً
 * في طبقة الراوترات (`server/routers/**`) وقت التشغيل.
 *
 * القاعدة (CLAUDE.md §٢):
 *   «الراوتر بلا منطق أعمال، والخدمة لا تقرأ ctx — تستقبل Actor { userId, branchId, role }».
 *   وصولُ الراوتر مباشرةً إلى الجداول أو قاعدة البيانات يخلط التحقّق الشكليّ بمنطق الأعمال
 *   ويمنع إعادة استعمال المنطق من القنوات الأخرى (الجوال الأصيل / الأوفلاين / الوظائف الخلفية).
 *
 * ما يُحسَب انتهاكاً:
 *   • استيرادٌ وقت التشغيل (`import ... from "..."` أو `import("...")`) في `server/routers/**`
 *     (باستثناء `__tests__` و`*.test.ts`) يستهدف:
 *       - `drizzle/schema` أو أيّ `drizzle/*Schema`
 *       - `server/db` (`../db`, `../../db`, إلخ)
 *   • استيرادُ الأنواع الصرف (`import type ...` أو `import { type X, type Y }`) **مسموحٌ**
 *     لأنّه يُمحى كليّاً عند الترجمة ولا ينشئ تبعيةَ تشغيلٍ على طبقة البيانات.
 *
 * المِسنَنة تنازلية لكلّ ملفّ (`scripts/ratchet-core.mjs` + `scripts/layer-imports-baseline.json`):
 *   • جميع الراوترات النظيفة مقفلة عند ٠ استيراد مباشر.
 *   • الراوترات الإرثية المجمَّدة تنزل مع الترحيل التدريجي إلى `server/services/**` ولا ترتفع أبداً.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertMonotonicDescent, reportSlack } from "./ratchet-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const ROUTERS_DIR = path.join(REPO_ROOT, "server", "routers");
const BASELINE_PATH = path.join(__dirname, "layer-imports-baseline.json");
const BASELINE_REL = "scripts/layer-imports-baseline.json";

const SELFTEST_ONLY = process.argv.includes("--selftest");
const UPDATE_BASELINE = process.argv.includes("--update-baseline");
const REPORT_ONLY = process.argv.includes("--report");

/**
 * يجرّد التعليقات السطرية والكتلية مع الحفاظ على النصوص الحرفية (`"..."` / `'...'` / `` `...` ``)
 * حتى لا تُبتلع المسارات أو علامات الاقتباس.
 */
export function stripCommentsPreservingStrings(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        const c = source[i];
        out += c;
        i += 1;
        if (c === "\\" && i < n) {
          out += source[i];
          i += 1;
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** هل المسار المستورَد يستهدف طبقة المخطّط (`drizzle/*Schema`) أو طبقة الاتّصال (`server/db`)؟ */
export function isForbiddenDataLayerSpecifier(specifier) {
  const clean = String(specifier ?? "").trim();
  if (!clean) return false;
  // 1) drizzle/schema أو drizzle/fulfillmentSchema أو أيّ drizzle/*Schema
  if (/(?:^|\/)drizzle\/(?:schema|[A-Za-z0-9_-]*Schema)(?:\.[cm]?[jt]s)?$/.test(clean)) {
    return true;
  }
  // 2) ../db أو ../../db أو server/db (أو .../db/index)
  if (/^(?:\.\.?\/)+db(?:\/index)?(?:\.[cm]?[jt]s)?$/.test(clean)) {
    return true;
  }
  if (/(?:^|\/)server\/db(?:\/index)?(?:\.[cm]?[jt]s)?$/.test(clean)) {
    return true;
  }
  return false;
}

/** هل عبارة الاستيراد تقتصر على أنواع TypeScript فقط (تُمحى عند الترجمة)؟ */
function isTypeOnlyImportClause(clauseRaw) {
  const clause = String(clauseRaw ?? "").trim();
  if (!clause) return false;
  if (/^type\s+/.test(clause)) return true;
  // import { type A, type B as C } from "..."
  const braceMatch = clause.match(/^\{([\s\S]*)\}$/);
  if (!braceMatch) return false;
  const specifiers = braceMatch[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (specifiers.length === 0) return true;
  return specifiers.every((s) => /^type\s+[A-Za-z0-9_$]/.test(s));
}

/**
 * يستخرج قائمة المسارات المنتهِكة لحدود الطبقات في مصدر راوتر واحد.
 * @returns {string[]}
 */
export function detectRouterDataLayerImports(source) {
  const clean = stripCommentsPreservingStrings(source);
  const violations = [];

  // 1) import <clause> from "<spec>"
  const staticImportRe = /\bimport\s+([\s\S]*?)\s+from\s*["'`]([^"'`]+)["'`]/g;
  for (const match of clean.matchAll(staticImportRe)) {
    const clause = match[1];
    const spec = match[2];
    if (isTypeOnlyImportClause(clause)) continue;
    if (isForbiddenDataLayerSpecifier(spec)) {
      violations.push(spec);
    }
  }

  // 2) import "<spec>" (side-effect)
  const sideEffectImportRe = /\bimport\s*["'`]([^"'`]+)["'`]/g;
  for (const match of clean.matchAll(sideEffectImportRe)) {
    const spec = match[1];
    if (isForbiddenDataLayerSpecifier(spec)) {
      violations.push(spec);
    }
  }

  // 3) await import("<spec>") / import("<spec>")
  const dynamicImportRe = /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  for (const match of clean.matchAll(dynamicImportRe)) {
    const spec = match[1];
    if (isForbiddenDataLayerSpecifier(spec)) {
      violations.push(spec);
    }
  }

  return violations;
}

function* walkRouterFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      yield* walkRouterFiles(full);
    } else if (
      entry.isFile() &&
      /\.ts$/.test(entry.name) &&
      !/\.(?:test|spec)\.ts$/.test(entry.name)
    ) {
      yield full;
    }
  }
}

function runSelfTest({ quiet = false } = {}) {
  const fails = [];
  const eq = (label, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      fails.push(`${label}: توقّعنا ${JSON.stringify(want)} فجاء ${JSON.stringify(got)}`);
    }
  };

  eq(
    "يمسك استيراد جدول من drizzle/schema",
    detectRouterDataLayerImports('import { invoices } from "../../drizzle/schema";').length,
    1,
  );
  eq(
    "يمسك استيراد drizzle/fulfillmentSchema",
    detectRouterDataLayerImports('import { deliveryCustody } from "../../drizzle/fulfillmentSchema";').length,
    1,
  );
  eq(
    "يمسك استيراد ../db وقت التشغيل",
    detectRouterDataLayerImports('import { getDb } from "../db";').length,
    1,
  );
  eq(
    "يمسك الاستيراد الديناميكي import('../db')",
    detectRouterDataLayerImports('const mod = await import("../db");').length,
    1,
  );
  eq(
    "يسمح بـ import type الصرف",
    detectRouterDataLayerImports('import type { Invoice } from "../../drizzle/schema";').length,
    0,
  );
  eq(
    "يسمح بـ import { type A, type B }",
    detectRouterDataLayerImports('import { type Invoice, type User } from "../../drizzle/schema";').length,
    0,
  );
  eq(
    "يمسك الاستيراد المختلط (نوع + قيمة وقت تشغيل)",
    detectRouterDataLayerImports('import { type Invoice, invoices } from "../../drizzle/schema";').length,
    1,
  );
  eq(
    "يتجاهل التعليقات السطرية والكتلية",
    detectRouterDataLayerImports(
      '// import { getDb } from "../db";\n/* import { invoices } from "../../drizzle/schema"; */',
    ).length,
    0,
  );
  eq(
    "يسمح باستيراد الخدمات من ../services/*",
    detectRouterDataLayerImports('import { createSale } from "../services/saleService";').length,
    0,
  );

  if (fails.length > 0) {
    console.error("✗ الاختبار الذاتيّ لحارس حدود الطبقات فشل:");
    for (const f of fails) console.error(`  - ${f}`);
    process.exit(1);
  }
  if (!quiet) {
    console.log("✓ الاختبار الذاتيّ لحارس حدود الطبقات (check:layer-imports): سليم.");
  }
}

function main() {
  runSelfTest({ quiet: !SELFTEST_ONLY });
  if (SELFTEST_ONLY) return;

  const actualMap = new Map();
  const detailByFile = new Map();
  let routerCount = 0;

  for (const fullPath of walkRouterFiles(ROUTERS_DIR)) {
    routerCount += 1;
    const rel = path.relative(REPO_ROOT, fullPath).replace(/\\/g, "/");
    const src = readFileSync(fullPath, "utf8");
    const hits = detectRouterDataLayerImports(src);
    if (hits.length > 0) {
      actualMap.set(rel, hits.length);
      detailByFile.set(rel, hits);
    }
  }

  const sortedEntries = [...actualMap.entries()].sort(([a], [b]) => a.localeCompare(b));

  if (UPDATE_BASELINE) {
    const obj = Object.fromEntries(sortedEntries);
    writeFileSync(BASELINE_PATH, JSON.stringify(obj, null, 2) + "\n", "utf8");
    const total = sortedEntries.reduce((s, [, n]) => s + n, 0);
    console.log(
      `✓ حُدِّث ${BASELINE_REL}: ${sortedEntries.length} راوتراً إرثياً (${total} استيراد) من أصل ${routerCount} راوتر.`,
    );
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error(`✗ ملفّ خطّ الأساس مفقود: ${BASELINE_REL}`);
    process.exit(1);
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  for (const key of Object.keys(baseline)) {
    if (!key.startsWith("server/routers/") || /\.(?:test|spec)\.ts$/.test(key)) {
      console.error(`✗ مفتاح غير صالح في ${BASELINE_REL}: ${key}`);
      process.exit(1);
    }
  }

  const descent = assertMonotonicDescent({
    baselinePath: BASELINE_REL,
    baseline,
    label: "حدود طبقات الراوترات (check:layer-imports)",
  });

  const violations = [];
  for (const [rel, count] of sortedEntries) {
    const allowed = Number(baseline[rel] ?? 0);
    if (count > allowed) {
      violations.push({
        rel,
        count,
        allowed,
        specs: detailByFile.get(rel) ?? [],
      });
    }
  }

  const totalActual = sortedEntries.reduce((s, [, n]) => s + n, 0);
  const cleanRouters = routerCount - sortedEntries.length;

  if (REPORT_ONLY) {
    console.log(
      `تقرير حدود الطبقات: ${cleanRouters}/${routerCount} راوتر نظيف تماماً · ${sortedEntries.length} راوتر إرثي (${totalActual} استيراد).`,
    );
    for (const [rel, count] of sortedEntries) {
      console.log(`  - ${rel}: ${count}`);
    }
    return;
  }

  if (!descent.ok) {
    console.error(descent.message);
    process.exit(1);
  }

  if (violations.length > 0) {
    console.error(
      `✗ انتهاك حدود الطبقات في ${violations.length} راوتر (CLAUDE.md §٢: الراوتر لا يستورد drizzle/schema أو server/db مباشرةً):\n`,
    );
    for (const v of violations) {
      console.error(
        `  - ${v.rel}: ${v.count} استيراد (الأساس المسموح: ${v.allowed}) ← [${v.specs.join(", ")}]`,
      );
    }
    console.error(
      `\nالإصلاح: انقل استعلامات/تعديلات الجداول إلى خدمةٍ في server/services/** تستقبل Actor، واستورد الخدمة في الراوتر (أو استعمل import type للأنواع فقط).`,
    );
    process.exit(1);
  }

  const slack = reportSlack({
    baseline,
    actual: actualMap,
    label: "حدود طبقات الراوترات",
    updateHint: "node scripts/check-layer-imports.mjs --update-baseline",
  });

  console.log(
    `✓ حدود طبقات الراوترات: ${cleanRouters}/${routerCount} راوتر عند ٠ استيراد مباشر (${sortedEntries.length} إرثي مجمَّد عند ${totalActual}).`,
  );
  if (!descent.skipped) console.log(descent.message);
  if (slack.total > 0) console.log(slack.message);
}

main();
