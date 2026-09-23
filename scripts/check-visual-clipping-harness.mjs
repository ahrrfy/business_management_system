#!/usr/bin/env node
/**
 * حارس السلامة البصرية ومنع الاقتطاع المالي — check-visual-clipping-harness.mjs
 *
 * القاعدة الحاكمة:
 * ⛔ ممنوع منعاً باتاً تطبيق قناع الاقتطاع `truncate` أو `text-overflow: ellipsis`
 *    على أي مبالغ مالية أو عملات أو أرقام مطابقة حسابية (مثل 21,...).
 *    المبالغ المالية يجب أن تظهر كاملة وواضحة دائماً ومحمية بـ shrink-0 و whitespace-nowrap.
 *
 * يدعم:
 *   --selftest : اختبار ذاتي للتأكد من قدرة الحارس على كشف المخالفات وتمرير السليم.
 *   --report   : عرض التقرير دون كسر البناء.
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

export function analyzeCodeForClipping(content, filename = "test.tsx") {
  const lines = content.split("\n");
  const violations = [];

  lines.forEach((line, index) => {
    if (isCommentLine(line)) return;

    // نمط 1: استخدام truncate في نفس العنصر مع دالة تنسيق مالي
    const hasTruncate = /(?:className|class)=["'][^"']*\btruncate\b[^"']*["']/.test(line);
    const hasMoneyFormatter = /\b(?:fmt|fmtAr|formatIqd|positiveMoney|positiveDiff)\s*\(/.test(line);
    const isTitleOnly = /title=["'][^"']*\{[^}]*fmt[^}]*\}["']/.test(line);

    if (hasTruncate && hasMoneyFormatter && !isTitleOnly) {
      violations.push({
        line: index + 1,
        rule: "NO_TRUNCATE_ON_MONEY",
        message: "اقتطاع مالي محظور: تم دمج صنف truncate مع دالة تنسيق مالي.",
        snippet: line.trim(),
      });
    }

    // نمط 2: استخدام truncate داخل كتل tabular-nums للأرصدة
    if (
      hasTruncate &&
      line.includes("tabular-nums") &&
      (line.includes("Balance") || line.includes("balance") || line.includes("د.ع"))
    ) {
      violations.push({
        line: index + 1,
        rule: "NO_TRUNCATE_ON_BALANCE",
        message: "اقتطاع مالي محظور: تم دمج truncate مع tabular-nums لرصيد أو مبلغ.",
        snippet: line.trim(),
      });
    }
  });

  return violations;
}

function runSelfTest() {
  console.log("جارٍ تشغيل الاختبار الذاتي لحارس السلامة البصرية (check-visual-clipping-harness)...");

  // حالة 1: كود يحوي اقتطاعاً لمبلغ مالي (يجب أن يفشل)
  const badCode1 = `<div className="tabular-nums text-muted-foreground truncate" dir="ltr">{fmt(values[i].toFixed(0))}</div>`;
  const res1 = analyzeCodeForClipping(badCode1);
  if (res1.length === 0) {
    console.error("❌ فشل الاختبار الذاتي: لم يتم كشف truncate على دالة fmt!");
    process.exit(1);
  }

  // حالة 2: كود سليم محمي بـ whitespace-nowrap (يجب أن يمر)
  const goodCode1 = `<div className="tabular-nums text-muted-foreground whitespace-nowrap shrink-0" dir="ltr">{fmt(values[i].toFixed(0))}</div>`;
  const res2 = analyzeCodeForClipping(goodCode1);
  if (res2.length > 0) {
    console.error("❌ فشل الاختبار الذاتي: تم وسم كود سليم بأنه مخالفة زوراً!");
    process.exit(1);
  }

  // حالة 3: استخدام truncate لنص عادي مثل عنوان أو ملاحظات (يجب أن يمر)
  const goodCode2 = `<span className="truncate">{customerNotes}</span>`;
  const res3 = analyzeCodeForClipping(goodCode2);
  if (res3.length > 0) {
    console.error("❌ فشل الاختبار الذاتي: تم وسم truncate على نص غير مالي كمخالفة!");
    process.exit(1);
  }

  console.log("✓ نجح الاختبار الذاتي لحارس السلامة البصرية 100% بنجاح.");
}

function main() {
  if (SELFTEST) {
    runSelfTest();
    return;
  }

  const allViolations = [];

  for (const file of walkCode(CLIENT_SRC)) {
    const content = readFileSync(file, "utf8");
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
    const issues = analyzeCodeForClipping(content, rel);
    if (issues.length > 0) {
      allViolations.push({ file: rel, issues });
    }
  }

  if (allViolations.length === 0) {
    console.log("✓ حارس السلامة البصرية (check-visual-clipping-harness): صفر اقتطاعات مالية في كافة شاشات الواجهة.");
    process.exit(0);
  }

  console.error(`\n❌ حارس السلامة البصرية: وُجدت ${allViolations.length} ملفات تحوي اقتطاعاً بصرياً لمبالغ مالية:\n`);
  for (const v of allViolations) {
    console.error(`  📄 ${v.file}:`);
    for (const issue of v.issues) {
      console.error(`    سطر ${issue.line} [${issue.rule}]: ${issue.message}`);
      console.error(`      └─ ${issue.snippet}`);
    }
  }

  if (!REPORT) {
    console.error("\nيرجى استبدال truncate بـ whitespace-nowrap shrink-0 على القيم المالية لحماية بيانات النظام من التشويه.\n");
    process.exit(1);
  }
}

main();
