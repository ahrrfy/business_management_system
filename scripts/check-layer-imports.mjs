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
 * ما يُحسَب انتهاكاً (بتحليل شجرة AST الرسمية لمترجم TypeScript):
 *   • استيرادٌ أو إعادةُ تصديرٍ وقت التشغيل (`ImportDeclaration` / `ExportDeclaration` غير الصرف،
 *     أو `import("...")` الديناميكيّ `CallExpression`) في `server/routers/**` (باستثناء `__tests__` و`*.test.ts`)
 *     يستهدف:
 *       - `drizzle/schema` أو أيّ `drizzle/*Schema`
 *       - `server/db` (`../db`, `../../db`, إلخ)
 *   • استيرادُ الأنواع الممحيّ عند الترجمة (`import type ...`، `import { type X }`، `export type { X }`،
 *     أو تعبيرات الأنواع `type T = import("...").Invoice` / `typeof import("...")` من نوع `ImportTypeNode`)
 *     **مسموحٌ** لأنّه يُمحى كليّاً ولا ينشئ تبعيةَ تشغيلٍ على طبقة البيانات.
 *
 * المِسنَنة تنازلية لكلّ ملفّ (`scripts/ratchet-core.mjs` + `scripts/layer-imports-baseline.json`):
 *   • جميع الراوترات النظيفة مقفلة عند ٠ استيراد مباشر.
 *   • الراوترات الإرثية المجمَّدة تنزل مع الترحيل التدريجي إلى `server/services/**` ولا ترتفع أبداً.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { assertMonotonicDescent, reportSlack } from "./ratchet-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const ROUTERS_DIR = path.join(REPO_ROOT, "server", "routers");
const BASELINE_PATH = path.join(__dirname, "layer-imports-baseline.json");
const BASELINE_REL = "scripts/layer-imports-baseline.json";

const SELFTEST_ONLY = process.argv.includes("--selftest");
const UPDATE_BASELINE = process.argv.includes("--update-baseline");
const REPORT_ONLY = process.argv.includes("--report");

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

/** هل جملة `ImportDeclaration` تقتصر على أنواع TypeScript الممحيّة فقط؟ */
function isTypeOnlyImportDeclaration(node) {
  const clause = node.importClause;
  if (!clause) return false; // side-effect import "..."
  if (clause.isTypeOnly) return true;
  if (clause.name) return false; // default value import
  const bindings = clause.namedBindings;
  if (!bindings) return true;
  if (ts.isNamespaceImport(bindings)) return false; // import * as ns
  if (ts.isNamedImports(bindings)) {
    return bindings.elements.every((el) => el.isTypeOnly);
  }
  return false;
}

/** هل جملة `ExportDeclaration` ذات `moduleSpecifier` تقتصر على أنواع TypeScript الممحيّة فقط؟ */
function isTypeOnlyExportDeclaration(node) {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (!clause) return false; // export * from "..."
  if (ts.isNamespaceExport(clause)) return false; // export * as ns from "..."
  if (ts.isNamedExports(clause)) {
    return clause.elements.every((el) => el.isTypeOnly);
  }
  return false;
}

/**
 * يستخرج قائمة المسارات المنتهِكة لحدود الطبقات في مصدر راوتر واحد عبر شجرة AST لـ TypeScript.
 * @returns {string[]}
 */
export function detectRouterDataLayerImports(source, fileName = "router.ts") {
  const sf = ts.createSourceFile(
    fileName,
    String(source ?? ""),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations = [];

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (!isTypeOnlyImportDeclaration(node) && isForbiddenDataLayerSpecifier(spec)) {
        violations.push(spec);
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text;
      if (!isTypeOnlyExportDeclaration(node) && isForbiddenDataLayerSpecifier(spec)) {
        violations.push(spec);
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      // استيرادٌ ديناميكيّ وقت التشغيل `import("...")` — بينما `type T = import("...").X` هو ImportTypeNode ولا يمرّ هنا.
      const spec = node.arguments[0].text;
      if (isForbiddenDataLayerSpecifier(spec)) {
        violations.push(spec);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
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
    "يمسك الاستيراد الديناميكي وقت التشغيل import('../db')",
    detectRouterDataLayerImports('const mod = await import("../db");').length,
    1,
  );
  eq(
    "يمسك الاستيراد الديناميكي المتسلسل import('../db').then(...)",
    detectRouterDataLayerImports('import("../db").then((m) => m);').length,
    1,
  );
  eq(
    "يمسك إعادة التصدير وقت التشغيل export { invoices } from '../../drizzle/schema'",
    detectRouterDataLayerImports('export { invoices } from "../../drizzle/schema";').length,
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
    "يسمح بتعبير النوع الممحيّ type Invoice = import('../../drizzle/schema').Invoice",
    detectRouterDataLayerImports(
      'type Invoice = import("../../drizzle/schema").Invoice;\ntype SchemaMod = typeof import("../db");',
    ).length,
    0,
  );
  eq(
    "يسمح بـ export type الصرف",
    detectRouterDataLayerImports('export type { Invoice } from "../../drizzle/schema";').length,
    0,
  );
  eq(
    "يمسك الاستيراد المختلط (نوع + قيمة وقت تشغيل)",
    detectRouterDataLayerImports('import { type Invoice, invoices } from "../../drizzle/schema";').length,
    1,
  );
  eq(
    "يتجاهل التعليقات السطرية والكتلية والنصوص الحرفية",
    detectRouterDataLayerImports(
      '// import { getDb } from "../db";\n/* import { invoices } from "../../drizzle/schema"; */\nconst s = \'import("../db")\';',
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
    const hits = detectRouterDataLayerImports(src, rel);
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

  if (REPORT_ONLY) {
    const total = sortedEntries.reduce((s, [, n]) => s + n, 0);
    console.log(
      `تقرير حدود الطبقات (server/routers/**): ${routerCount - sortedEntries.length}/${routerCount} راوتر نظيف (٠ استيراد مباشر) · ${sortedEntries.length} راوتر إرثي (${total} استيراد).`,
    );
    return;
  }

  if (!descent.ok || violations.length > 0) {
    if (!descent.ok) {
      console.error(descent.message);
    }
    if (violations.length > 0) {
      console.error(
        `✗ انتهاك حدود الطبقات في server/routers/** (${violations.length} راوتر يتجاوز خطّ الأساس):`,
      );
      for (const v of violations) {
        console.error(
          `  - ${v.rel}: ${v.count} استيراد مباشر (المسموح في الأساس: ${v.allowed}) ← [${v.specs.join(", ")}]`,
        );
      }
      console.error(
        "\nالقاعدة (CLAUDE.md §٢): الراوتر لا يستورد drizzle/*Schema ولا server/db وقت التشغيل؛ انقل منطق الاستعلام/المعاملة إلى server/services/** (واستعمل import type عند الحاجة للأنواع فقط).",
      );
    }
    process.exit(1);
  }

  const slack = reportSlack({ actual: actualMap, baseline });
  const totalFrozen = Object.values(baseline).reduce((s, n) => s + Number(n), 0);
  console.log(
    `✓ حدود طبقات الراوترات: ${routerCount - sortedEntries.length}/${routerCount} راوتر عند ٠ استيراد مباشر (${sortedEntries.length} إرثي مجمَّد عند ${totalFrozen}).`,
  );
  if (slack) {
    console.log(slack);
  }
}

main();
