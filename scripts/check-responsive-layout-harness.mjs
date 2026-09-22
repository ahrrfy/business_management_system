#!/usr/bin/env node
/**
 * حارس التجاوب البصري وشاشات الهاتف واللوحيات — check-responsive-layout-harness.mjs
 *
 * القواعد الحاكمة:
 * ⛔ 1. DIALOG_RESPONSIVE_WIDTH:
 *    ممنوع استخدام فئات max-w-* الصلبة (مثل max-w-lg, max-w-2xl) على <DialogContent>
 *    دون بادئة تجاوب (sm: أو md:). الفئات الصلبة تُسقط هامش أمان شاشات الهاتف
 *    max-w-[calc(100%-2rem)] عبر tailwind-merge مما يجعل النوافذ تلتصق بحواف الشاشة.
 *
 * ⛔ 2. UNRESPONSIVE_CONTAINER_GRID:
 *    ممنوع فرض شبكات صلبة عالية الأعمدة (grid-cols-4 وما فوق) مباشرة على شاشات
 *    الموبايل دون بادئات تجاوب تضمن التدرج السلس (مثل grid-cols-1 sm:grid-cols-2 lg:grid-cols-4).
 *
 * يدعم:
 *   --selftest : اختبار ذاتي للتأكد من قدرة الحارس على كشف المخالفات وتمرير الأنماط السليمة.
 *   --report   : عرض تقرير التجاوب دون كسر البناء.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CLIENT_SRC = path.join(REPO_ROOT, "client", "src");

const SELFTEST = process.argv.includes("--selftest");
const REPORT = process.argv.includes("--report");

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function* walkCode(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "_legacy" ||
        entry.name === "dist" ||
        entry.name === "__tests__"
      )
        continue;
      yield* walkCode(full);
    } else if (
      entry.isFile() &&
      /\.(tsx|ts)$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      yield full;
    }
  }
}

export function analyzeCodeForResponsiveLayout(content, filename = "test.tsx") {
  const lines = content.split("\n");
  const violations = [];

  // فحص 1: DialogContent مع bare max-w-*
  const dialogMatches = [...content.matchAll(/<DialogContent[^>]*className=["']([^"']*)["']/g)];
  for (const match of dialogMatches) {
    const cls = match[1];
    // استثناء الأنماط المقبولة المعتمدة على viewport مثل min(95vw, ...)
    if (cls.includes("min(") || cls.includes("calc(")) continue;

    // البحث عن bare max-w-(xs|sm|md|lg|xl|2xl|3xl|4xl|5xl)
    const bareMatch = cls.match(/(?<![a-z0-9:-])max-w-(xs|sm|md|lg|xl|2xl|3xl|4xl|5xl)\b/);
    if (bareMatch) {
      // إيجاد رقم السطر التقريبي
      const index = content.indexOf(match[0]);
      const lineNum = content.slice(0, index).split("\n").length;
      violations.push({
        line: lineNum,
        rule: "DIALOG_RESPONSIVE_WIDTH",
        message: `نافذة حوارية غير متجاوبة: استخدام ${bareMatch[0]} صلبة على DialogContent يلغي هامش شاشة الهاتف. استخدم sm:${bareMatch[0]} بدلاً منها.`,
        snippet: match[0].slice(0, 100),
      });
    }
  }

  // فحص 2: شبكات صلبة عالية الأعمدة بدون بادئة تجاوب
  lines.forEach((line, index) => {
    if (isCommentLine(line)) return;

    // استثناء شاشات العرض التجريبي والطباعة التي تتطلب شاشات ثابتة عمداً
    if (filename.includes("MobileDesignPreview") || filename.includes("CashCounter") || filename.includes("ReceiptOverlay")) return;

    // استثناء الجداول العريضة التي تحمل min-w صريحة وتمرير أفقي
    if (line.includes("min-w-[") || line.includes("overflow-x-auto")) return;

    // كشف grid-cols-4 أو grid-cols-5 بدون sm:, md:, lg:
    const gridMatch = line.match(/(?<![a-z0-9:-])grid-cols-(4|5|6)\b/);
    if (gridMatch && line.includes("grid ") && !line.includes("sm:grid-cols") && !line.includes("md:grid-cols")) {
      violations.push({
        line: index + 1,
        rule: "UNRESPONSIVE_CONTAINER_GRID",
        message: `شبكة صلبة ${gridMatch[0]} على الجوال: تسبب انضغاط العناصر على الشاشات الصغيرة (< 640px). استخدم التدرج التجاوبي (مثال: grid-cols-2 sm:${gridMatch[0]}).`,
        snippet: line.trim().slice(0, 100),
      });
    }
  });

  return violations;
}

export function runSelfTest() {
  console.log("جارٍ تشغيل الاختبار الذاتي لحارس التجاوب البصري (check-responsive-layout-harness)...");

  // حالة 1: نافذة حوارية بـ max-w صلبة دون sm: (يجب أن تفشل)
  const badDialog = `
    export function MyModal() {
      return (
        <Dialog open>
          <DialogContent className="max-w-xl">
            <div>محتوى</div>
          </DialogContent>
        </Dialog>
      );
    }
  `;
  const badRes = analyzeCodeForResponsiveLayout(badDialog, "badDialog.tsx");
  if (!badRes.some((v) => v.rule === "DIALOG_RESPONSIVE_WIDTH")) {
    console.error("فشل الاختبار الذاتي: لم يتم كشف DialogContent بـ max-w صلبة دون sm:");
    process.exit(1);
  }

  // حالة 2: نافذة حوارية بـ sm:max-w متجاوبة (يجب أن تنجح)
  const goodDialog = `
    export function MyModal() {
      return (
        <Dialog open>
          <DialogContent className="sm:max-w-xl">
            <div>محتوى</div>
          </DialogContent>
        </Dialog>
      );
    }
  `;
  const goodRes = analyzeCodeForResponsiveLayout(goodDialog, "goodDialog.tsx");
  if (goodRes.length > 0) {
    console.error("فشل الاختبار الذاتي: تم وسم DialogContent متجاوبة كـ مخالفة!", goodRes);
    process.exit(1);
  }

  // حالة 3: شبكة صلبة 4 أعمدة على الجوال دون بادئة (يجب أن تفشل)
  const badGrid = `
    export function Stats() {
      return <div className="grid grid-cols-4 gap-4"><div>1</div></div>;
    }
  `;
  const badGridRes = analyzeCodeForResponsiveLayout(badGrid, "badGrid.tsx");
  if (!badGridRes.some((v) => v.rule === "UNRESPONSIVE_CONTAINER_GRID")) {
    console.error("فشل الاختبار الذاتي: لم يتم كشف grid-cols-4 صلبة دون بادئة تجاوب");
    process.exit(1);
  }

  // حالة 4: شبكة متجاوبة مع الجوال (يجب أن تنجح)
  const goodGrid = `
    export function Stats() {
      return <div className="grid grid-cols-2 sm:grid-cols-4 gap-4"><div>1</div></div>;
    }
  `;
  const goodGridRes = analyzeCodeForResponsiveLayout(goodGrid, "goodGrid.tsx");
  if (goodGridRes.length > 0) {
    console.error("فشل الاختبار الذاتي: تم وسم شبكة متجاوبة كـ مخالفة!", goodGridRes);
    process.exit(1);
  }

  console.log("✓ نجح الاختبار الذاتي لحارس التجاوب البصري 100% بنجاح.");
}

function runAudit() {
  const allViolations = [];

  for (const filePath of walkCode(CLIENT_SRC)) {
    const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");
    const content = readFileSync(filePath, "utf8");
    const violations = analyzeCodeForResponsiveLayout(content, relativePath);

    if (violations.length > 0) {
      allViolations.push({ file: relativePath, violations });
    }
  }

  if (allViolations.length === 0) {
    console.log("✓ حارس التجاوب البصري (check-responsive-layout-harness): كافة النوافذ والشبكات متوافقة مع معايير التجاوب للهواتف واللوحيات بنسبة 100%.");
    process.exit(0);
  }

  console.error(`✗ تم كشف ${allViolations.length} ملفاً يحتوي مخالفات تجاوب بصري:`);
  for (const { file, violations } of allViolations) {
    console.error(`\n📄 [${file}] (${violations.length} مخالفة):`);
    for (const v of violations) {
      console.error(`   - سطر ${v.line}: [${v.rule}] ${v.message}`);
      console.error(`     الرمز: ${v.snippet}`);
    }
  }

  if (REPORT) {
    console.log("\n(وضع التقرير --report: تخطي كسر البناء)");
    process.exit(0);
  }

  process.exit(1);
}

if (SELFTEST) {
  runSelfTest();
} else {
  runAudit();
}
