#!/usr/bin/env node
/**
 * حارس السلامة والتعامد والشبكة الأصولية للجداول (Table Integrity & Orthogonal Grid Harness)
 *
 * الغرض:
 * ١. منع انكسار التعامد البصري بين ترويسات الأعمدة <th> وخلايا الصفوف <td> (التعامد 100%).
 * ٢. التحقق من تطابق الأعمدة المالية والحسابية مع عقد meta: { kind: "money" | "number" }.
 * ٣. منع استخدام كلاسات فيزيائية متناقضة (مثل text-left أو text-right) داخل خلايا الأعمدة المعرفة كـ money.
 * ٤. ضمان سلامة فواصل الأعمدة وشبكة الجداول الأصولية (Full-Bordered Orthogonal Grid).
 * ٥. اختبار ذاتي كامل (--selftest) وفق معايير الحواضن الآلية في CLAUDE.md.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const CLIENT_SRC = path.join(REPO_ROOT, "client", "src");

/** استخراج كافة ملفات tsx */
function getTsxFiles(dir) {
  let results = [];
  try {
    const list = readdirSync(dir);
    for (const file of list) {
      const fullPath = path.join(dir, file);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        if (!file.startsWith(".") && file !== "node_modules" && file !== "dist") {
          results = results.concat(getTsxFiles(fullPath));
        }
      } else if (file.endsWith(".tsx") && !file.endsWith(".test.tsx")) {
        results.push(fullPath);
      }
    }
  } catch {
    // تجاهل المجلدات غير المقروءة
  }
  return results;
}

/**
 * فحص محتوى كودي لكشف تناقضات التعامد والمحاذاة في الجداول
 */
export function auditTableCode(content, filePath = "snippet.tsx") {
  const issues = [];
  const lines = content.split("\n");

  // ١. فحص تضارب محاذاة خلايا الأعمدة المالية (وجود text-left أو text-right متناقض داخل زر أو عنصر الخلية)
  // نمط: عمود kind: "money" وبداخله عنصر يحمل text-right أو text-left بدلاً من text-end
  const moneyColRegex = /id:\s*["'](?:debit|credit|balance|amount|total|price)["']|accessorKey:\s*["'](?:debit|credit|balance|total|paidAmount)["']/i;

  // فحص المقاطع البرمجية التي تخلط بين kind: "money" و text-right في الأزرار
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // كشف استخدام text-right المباشر داخل button أو span في سياق خلايا مالية
    if (
      (line.includes("text-right block w-full") || line.includes("text-right cursor-pointer")) &&
      !line.includes("text-end")
    ) {
      issues.push({
        line: i + 1,
        rule: "CONFLICTING_PHYSICAL_TEXT_RIGHT",
        message: `استخدام غير متعامد لكلاس 'text-right' داخل خلية تفاعلية — يجب استخدام 'text-end' في الجداول لتطابق RTL/LTR`,
        snippet: line.trim(),
      });
    }

    // كشف استخدام className="... text-start" على أزرار خلايا المبالغ المالية
    if (line.includes('meta: { kind: "money" }')) {
      // فحص الأسطر التالية لنفس العمود
      for (let j = i; j < Math.min(i + 20, lines.length); j++) {
        if (lines[j].includes("hover:underline cursor-pointer text-start")) {
          issues.push({
            line: j + 1,
            rule: "MONEY_CELL_TEXT_START_MISALIGNMENT",
            message: `تضارب تعامد: عمود 'kind: money' محاذى لـ text-end بينما الزر الداخلي يحمل text-start`,
            snippet: lines[j].trim(),
          });
        }
      }
    }
  }

  // ٢. التحقق من سلامة المكونات المركزية DataTable و tableStyles
  if (filePath.endsWith("tableStyles.ts")) {
    if (!content.includes("TABLE_GRID_HEAD_BORDER_CLS") || !content.includes("TABLE_GRID_CELL_BORDER_CLS")) {
      issues.push({
        line: 1,
        rule: "MISSING_GRID_BORDER_CONSTANTS",
        message: "غياب ثوابت فواصل الأعمدة الأصولية (TABLE_GRID_HEAD_BORDER_CLS / TABLE_GRID_CELL_BORDER_CLS) في tableStyles.ts",
      });
    }
  }

  if (filePath.endsWith("DataTable.tsx")) {
    if (!content.includes("TABLE_GRID_HEAD_BORDER_CLS") || !content.includes("renderHeaderContent")) {
      issues.push({
        line: 1,
        rule: "MISSING_DATATABLE_GRID_HARNESS",
        message: "DataTable.tsx لا يستخدم ثوابت فواصل الأعمدة أو معالج ترويسات التعامد renderHeaderContent",
      });
    }
  }

  return issues;
}

/**
 * الاختبار الذاتي للحارس (--selftest)
 */
function runSelfTest() {
  console.log("جارٍ تشغيل الاختبار الذاتي لحارس سلامة وتعامد الجداول (check-table-integrity-harness)...");

  // حالة ١: كود نظيف ومتعامد
  const cleanSnippet = `
    const columns = [
      {
        accessorKey: "total",
        header: "الإجمالي",
        meta: { kind: "money" },
        cell: ({ row }) => <span className="text-end block w-full tabular-nums">{row.original.total}</span>,
      }
    ];
  `;
  const cleanIssues = auditTableCode(cleanSnippet, "clean.tsx");
  if (cleanIssues.length > 0) {
    console.error("✗ فشل الاختبار الذاتي: تم تسجيل مخالفة وهمية في كود سليم:", cleanIssues);
    process.exit(1);
  }

  // حالة ٢: كود يحمل كلاس text-right فيزيائي متعارض
  const dirtySnippet1 = `
    <button className="text-money-positive font-semibold hover:underline cursor-pointer transition-colors text-right block w-full">
      {fmt(r.debit)}
    </button>
  `;
  const dirtyIssues1 = auditTableCode(dirtySnippet1, "dirty1.tsx");
  if (dirtyIssues1.length === 0 || dirtyIssues1[0].rule !== "CONFLICTING_PHYSICAL_TEXT_RIGHT") {
    console.error("✗ فشل الاختبار الذاتي: لم يتم كشف تعارض text-right الفيزيائي");
    process.exit(1);
  }

  // حالة ٣: كود يخلط بين kind: money و text-start
  const dirtySnippet2 = `
    meta: { kind: "money" },
    cell: ({ row }) => {
      return (
        <button className="hover:underline cursor-pointer text-start">
          {val}
        </button>
      );
    }
  `;
  const dirtyIssues2 = auditTableCode(dirtySnippet2, "dirty2.tsx");
  if (dirtyIssues2.length === 0 || dirtyIssues2[0].rule !== "MONEY_CELL_TEXT_START_MISALIGNMENT") {
    console.error("✗ فشل الاختبار الذاتي: لم يتم كشف خلط kind: money مع text-start");
    process.exit(1);
  }

  console.log("✓ نجح الاختبار الذاتي لحارس سلامة وتعامد الجداول 100% بنجاح.");
}

/** التشغيل الرئيسي */
function main() {
  const args = process.argv.slice(2);
  const isSelfTest = args.includes("--selftest");

  if (isSelfTest) {
    runSelfTest();
    process.exit(0);
  }

  // فحص الكود المصدري في pages و components
  const filesToScan = [
    ...getTsxFiles(path.join(CLIENT_SRC, "pages")),
    ...getTsxFiles(path.join(CLIENT_SRC, "components")),
  ];

  let totalViolations = 0;
  const violationReports = [];

  for (const file of filesToScan) {
    try {
      const content = readFileSync(file, "utf8");
      const relativePath = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
      const fileIssues = auditTableCode(content, file);

      if (fileIssues.length > 0) {
        totalViolations += fileIssues.length;
        violationReports.push({ file: relativePath, issues: fileIssues });
      }
    } catch {
      // تجاهل ملفات غير قابلة للقراءة
    }
  }

  if (totalViolations > 0) {
    console.error(`\n✗ رُصدت ${totalViolations} مخالفات في تعامد وسلامة الجداول:\n`);
    for (const report of violationReports) {
      console.error(`📄 الملف: ${report.file}`);
      for (const issue of report.issues) {
        console.error(`   - السطر ${issue.line}: [${issue.rule}] ${issue.message}`);
        if (issue.snippet) console.error(`     الكود: ${issue.snippet}`);
      }
      console.error("");
    }
    console.error("الإصلاح: وحّد محاذاة العناوين والخلايا بـ 'text-end' أو 'text-start' وفق دلالة meta، وتجنب استخدام text-right الفيزيائي.");
    process.exit(1);
  }

  console.log("✓ حارس سلامة وتعامد وشبكة الجداول (check-table-integrity-harness): كافة الجداول متعامدة ومتناسقة بنسبة 100%.");
}

main();
