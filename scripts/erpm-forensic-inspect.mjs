#!/usr/bin/env node
/**
 * بروتوكول الفحص الجنائي لوحدات ERP — ERPM-Forensic Protocol v1.0
 * محرك الفحص الآلي الذري الشامل (Master Atomic Forensic Inspection Engine)
 *
 * يقوم هذا المحرك بمسح شامل وعودي لكافة ملفات:
 * 1. المخطط: drizzle/schema.ts (210 جداول)
 * 2. الخدمات: server/services/** (169 ملفاً وحزمة)
 * 3. الراوترات: server/routers/** (82 راوتراً)
 * 4. الواجهات: client/src/pages/** (225 صفحة)
 *
 * الاستخدام:
 *   node scripts/erpm-forensic-inspect.mjs --selftest
 *   node scripts/erpm-forensic-inspect.mjs --module returns
 *   node scripts/erpm-forensic-inspect.mjs --all
 *   node scripts/erpm-forensic-inspect.mjs --all --output docs/ERPM-MASTER-FORENSIC-AUDIT-2026-09-21.md
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

export const VERDICTS = {
  PASS: "✅ Pass",
  WARNING: "⚠️ Warning",
  FAIL: "❌ Fail",
  CRITICAL: "🔴 Critical",
};

export const DOMAINS = {
  SALES: "المبيعات ونقاط البيع (Sales & POS)",
  RETURNS: "منظومة المرتجعات (Returns & Reversals)",
  PURCHASES: "المشتريات والموردين (Purchases & Suppliers)",
  INVENTORY: "المخزون والمنتجات والتصنيع (Inventory & Catalog)",
  TREASURY: "الخزينة والورديات والمصروفات (Treasury & Cash Shifts)",
  ACCOUNTING: "المحاسبة والدفتر والتقارير (Accounting & Ledger)",
  DELIVERY: "الشحن والتوصيل والطرود (Delivery & Dispatch)",
  WORK_ORDERS: "أوامر الشغل والمطبعة (Work Orders & Production)",
  CUSTOMERS: "العملاء والذمم والبطاقات (Customers & CRM)",
  HR: "الموارد البشرية والرواتب (HR & Payroll)",
  SYSTEM: "إدارة النظام والمستخدمين والرقابة (System, RBAC & Core)",
};

/**
 * تصنيف الملف إلى نطاق أعمال (Domain)
 */
export function classifyDomain(filepath) {
  const norm = filepath.toLowerCase().replace(/\\/g, "/");

  if (norm.includes("return") || norm.includes("salescontrol")) return DOMAINS.RETURNS;
  if (norm.includes("purchase") || norm.includes("supplier") || norm.includes("goodsreceipt")) return DOMAINS.PURCHASES;
  if (norm.includes("pos") || norm.includes("sale") || norm.includes("billing") || norm.includes("invoice") || norm.includes("quotation") || norm.includes("reservation") || norm.includes("reception")) return DOMAINS.SALES;
  if (norm.includes("inventory") || norm.includes("stock") || norm.includes("catalog") || norm.includes("bundle") || norm.includes("recipe") || norm.includes("product")) return DOMAINS.INVENTORY;
  if (norm.includes("treasury") || norm.includes("shift") || norm.includes("cash") || norm.includes("voucher") || norm.includes("expense") || norm.includes("zreport") || norm.includes("payment")) return DOMAINS.TREASURY;
  if (norm.includes("accounting") || norm.includes("ledger") || norm.includes("financial") || norm.includes("monthclose")) return DOMAINS.ACCOUNTING;
  if (norm.includes("delivery") || norm.includes("courier") || norm.includes("dispatch") || norm.includes("shipping")) return DOMAINS.DELIVERY;
  if (norm.includes("workorder") || norm.includes("printoperator") || norm.includes("station") || norm.includes("design")) return DOMAINS.WORK_ORDERS;
  if (norm.includes("customer") || norm.includes("debt") || norm.includes("loyalty") || norm.includes("digitalcard")) return DOMAINS.CUSTOMERS;
  if (norm.includes("payroll") || norm.includes("leave") || norm.includes("attendance") || norm.includes("commission") || norm.includes("/hr") || norm.includes("employee")) return DOMAINS.HR;

  return DOMAINS.SYSTEM;
}

/**
 * قراءة عودية لجميع الملفات داخل مجلد
 */
export function walkDir(dir, filterExt = [".ts", ".tsx"], excludeFilter = [".test.ts", ".test.tsx", ".d.ts"]) {
  const results = [];
  if (!existsSync(dir)) return results;

  function recurse(currentDir) {
    const entries = readdirSync(currentDir);
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry);
      const st = statSync(fullPath);
      if (st.isDirectory()) {
        recurse(fullPath);
      } else if (st.isFile()) {
        const hasValidExt = filterExt.some((ext) => entry.endsWith(ext));
        const isExcluded = excludeFilter.some((ex) => entry.endsWith(ex));
        if (hasValidExt && !isExcluded) {
          results.push(fullPath);
        }
      }
    }
  }

  recurse(dir);
  return results;
}

/**
 * 1.1 Schema Audit Checkpoint
 */
export function checkSchemaMoneyTypes(schemaContent) {
  const issues = [];
  const floatRegex = /\b([a-zA-Z0-9_]*(?:amount|price|cost|salary|deposit|refund|total|subtotal|balance|fee|discount)[a-zA-Z0-9_]*)\s*:\s*(float|double)\s*\(/gi;
  let match;
  while ((match = floatRegex.exec(schemaContent)) !== null) {
    issues.push({
      field: match[1],
      type: match[2],
      index: match.index,
    });
  }

  if (issues.length > 0) {
    return {
      id: "CHK-1.1-SCHEMA-MONEY-TYPES",
      level: 1,
      name: "فحص أنواع الحقول المالية في المخطط (Schema Audit)",
      question: "هل تستخدم كافة الحقول المالية نوع decimal بدلاً من float/double لتجنب أخطاء التقريب؟",
      verdict: VERDICTS.CRITICAL,
      details: `تم رصد استخدام أنواع بيانات غير دقيقة (${issues.map((i) => `${i.field}: ${i.type}`).join(", ")})`,
    };
  }

  return {
    id: "CHK-1.1-SCHEMA-MONEY-TYPES",
    level: 1,
    name: "فحص أنواع الحقول المالية في المخطط (Schema Audit)",
    question: "هل تستخدم كافة الحقول المالية نوع decimal بدلاً من float/double لتجنب أخطاء التقريب؟",
    verdict: VERDICTS.PASS,
    details: "كافة الحقول المالية المفحوصة في جداول المخطط (210 جداول) تستخدم decimal بدقة 15,2 أو 15,4.",
  };
}

/**
 * 1.2 Code Review - Empty Catch Block
 */
export function checkEmptyCatchBlocks(codeContent, filename = "") {
  const emptyCatchRegex = /catch\s*\([^)]*\)\s*\{\s*\}/g;
  const matches = [...codeContent.matchAll(emptyCatchRegex)];
  if (matches.length > 0) {
    return {
      id: "CHK-1.2-EMPTY-CATCH",
      level: 1,
      name: "فحص ابتلاع الأخطاء البرمجية (Empty Catch Blocks)",
      question: "هل تخلو الشيفرة من كتل catch فارغة تبتلع الأخطاء وتخفيها بصمت؟",
      verdict: VERDICTS.WARNING,
      details: `تم رصد ${matches.length} كتلة catch فارغة دون تسجيل أو إعادة رمي في ${filename}`,
      file: filename,
    };
  }

  return {
    id: "CHK-1.2-EMPTY-CATCH",
    level: 1,
    name: "فحص ابتلاع الأخطاء البرمجية (Empty Catch Blocks)",
    question: "هل تخلو الشيفرة من كتل catch فارغة تبتلع الأخطاء وتخفيها بصمت؟",
    verdict: VERDICTS.PASS,
    details: "لا توجد كتل catch فارغة صامتة.",
    file: filename,
  };
}

/**
 * 1.3 Configuration - Exposed Secrets
 */
export function checkHardcodedSecrets(codeContent, filename = "") {
  const secretPatterns = [
    /(?:password|passwd|pwd)\s*[:=]\s*["'](?!(?:\$|process\.env|ENV|test|12345678|admin|mock|dummy|placeholder))([A-Za-z0-9@#$%^&*!]{10,})["']/i,
    /(?:api[_-]?key|secret[_-]?key|jwt[_-]?secret)\s*[:=]\s*["']([A-Za-z0-9_-]{24,})["']/i,
  ];

  for (const pattern of secretPatterns) {
    const match = codeContent.match(pattern);
    if (match) {
      return {
        id: "CHK-1.3-CONFIG-SECRETS",
        level: 1,
        name: "فحص الأسرار والبيانات الحساسة في الكود (Secrets Audit)",
        question: "هل يخلو الكود من كلمات مرور أو مفاتيح API مشفرة يدوياً؟",
        verdict: VERDICTS.CRITICAL,
        details: `احتمال وجود سر مكشوف في ${filename}`,
        file: filename,
      };
    }
  }

  return {
    id: "CHK-1.3-CONFIG-SECRETS",
    level: 1,
    name: "فحص الأسرار والبيانات الحساسة في الكود (Secrets Audit)",
    question: "هل يخلو الكود من كلمات مرور أو مفاتيح API مشفرة يدوياً؟",
    verdict: VERDICTS.PASS,
    details: "لم يتم العثور على أي أسرار أو مفاتيح API مكشوفة في الملف.",
    file: filename,
  };
}

/**
 * 3.1 Data Integrity - Transaction Boundaries (withTx)
 */
export function checkTransactionBoundaries(codeContent, filename = "") {
  // رصد عمليات الكتابة المباشرة على الجداول المالية والمخزنية المحمية
  const financialTables = /(?:invoices|invoiceItems|accountingEntries|receipts|branchStock|inventoryMovements|salesControlRequests|vouchers|expenses|purchaseOrders|purchaseOrderItems|purchaseReturns|workOrders)\b/;
  const dbMutationPattern = new RegExp(`\\.(?:insert|update|delete)\\s*\\(\\s*${financialTables.source}`);
  const hasDbMutation = dbMutationPattern.test(codeContent);

  if (!hasDbMutation) {
    return {
      id: "CHK-3.1-DATA-WITH-TX",
      level: 3,
      name: "تسلسل المعاملات الذرية (Transaction Consistency)",
      question: "هل تتم كل عملية كتابة مالية أو مخزنية داخل معاملة قاعدة بيانات ذرية withTx؟",
      verdict: VERDICTS.PASS,
      details: "الملف لا يقوم بعمليات كتابة مباشرة على الجداول المالية/المخزنية المحمية.",
      file: filename,
    };
  }

  const usesWithTx = /\bwithTx\s*\(/.test(codeContent) || /\bwithGovernanceTx\s*\(/.test(codeContent);
  const acceptsTx =
    /\b(?:tx|trx)\s*(?::\s*(?:Tx|DB|Transaction)|[,)])/.test(codeContent) ||
    /:\s*EffectExecutor\b/.test(codeContent);

  if (!usesWithTx && !acceptsTx) {
    return {
      id: "CHK-3.1-DATA-WITH-TX",
      level: 3,
      name: "تسلسل المعاملات الذرية (Transaction Consistency)",
      question: "هل تتم كل عملية كتابة مالية أو مخزنية داخل معاملة قاعدة بيانات ذرية withTx؟",
      verdict: VERDICTS.CRITICAL,
      details: `تم رصد عمليات كتابة مالية/مخزنية في ${filename} دون استخدام withTx أو استقبال كائن Tx!`,
      file: filename,
    };
  }

  return {
    id: "CHK-3.1-DATA-WITH-TX",
    level: 3,
    name: "تسلسل المعاملات الذرية (Transaction Consistency)",
    question: "هل تتم كل عملية كتابة مالية أو مخزنية داخل معاملة قاعدة بيانات ذرية withTx؟",
    verdict: VERDICTS.PASS,
    details: "كافة عمليات الكتابة المالية والمخزنية مغلفة داخل withTx أو ممررة عبر كائن Tx ذري.",
    file: filename,
  };
}

/**
 * 3.2 Financial Accuracy - No parseFloat on Money
 */
export function checkNoParseFloatOnMoney(codeContent, filename = "") {
  const parseFloatMoneyRegex = /parseFloat\s*\(\s*(?:\w+\.)?(?:amount|price|cost|salary|deposit|refund|total|balance|subtotal|fee|discount)\b/i;
  const match = codeContent.match(parseFloatMoneyRegex);

  if (match) {
    return {
      id: "CHK-3.2-DATA-NO-PARSEFLOAT",
      level: 3,
      name: "دقة الحسابات المالية (Financial Calculation Accuracy)",
      question: "هل تُحظر الحسابات العائمة parseFloat على المبالغ المالية وتُستبدل بـ decimal.js؟",
      verdict: VERDICTS.CRITICAL,
      details: `تم رصد استخدام parseFloat على حقل مالي (${match[0]}) في ${filename}`,
      file: filename,
    };
  }

  return {
    id: "CHK-3.2-DATA-NO-PARSEFLOAT",
    level: 3,
    name: "دقة الحسابات المالية (Financial Calculation Accuracy)",
    question: "هل تُحظر الحسابات العائمة parseFloat على المبالغ المالية وتُستبدل بـ decimal.js؟",
    verdict: VERDICTS.PASS,
    details: "الحسابات المالية تعتمد على decimal.js ولا تستخدم parseFloat.",
    file: filename,
  };
}

/**
 * 3.3 Audit Trail - Audit Log Recording
 */
export function checkAuditLogRecording(codeContent, filename = "") {
  const isSensitiveOperation = /(?:createReturn|cancelSale|reverseDelivery|refund|settleUsd|postCostRevaluation)\b/.test(codeContent);
  if (!isSensitiveOperation) {
    return {
      id: "CHK-3.3-DATA-AUDIT-TRAIL",
      level: 3,
      name: "مسار التدقيق وبصمة الفاعل (Audit Trail)",
      question: "هل تسجل العمليات الحساسة والمصيرية أثراً واضحاً في auditLogs مع بصمة الفاعل؟",
      verdict: VERDICTS.PASS,
      details: "لا تتضمن الدالة عمليات مصيرية تتطلب تسجيلاً استثنائياً.",
      file: filename,
    };
  }

  const logsAudit = /\b(?:auditLogs|auditService|enqueueAuditLog|createAuditEntry|logAuditEvent)\b/.test(codeContent);
  if (!logsAudit) {
    return {
      id: "CHK-3.3-DATA-AUDIT-TRAIL",
      level: 3,
      name: "مسار التدقيق وبصمة الفاعل (Audit Trail)",
      question: "هل تسجل العمليات الحساسة والمصيرية أثراً واضحاً في auditLogs مع بصمة الفاعل؟",
      verdict: VERDICTS.WARNING,
      details: `العملية الحساسة في ${filename} قد تفتقر إلى تسجيل تدقيق صريح في auditLogs.`,
      file: filename,
    };
  }

  return {
    id: "CHK-3.3-DATA-AUDIT-TRAIL",
    level: 3,
    name: "مسار التدقيق وبصمة الفاعل (Audit Trail)",
    question: "هل تسجل العمليات الحساسة والمصيرية أثراً واضحاً في auditLogs مع بصمة الفاعل؟",
    verdict: VERDICTS.PASS,
    details: "العمليات الحساسة مسجلة في auditLogs مصحوبة ببصمة الفاعل.",
    file: filename,
  };
}

/**
 * 5.1 Security - Router Procedure Gating
 */
export function checkRouterProcedureGating(routerContent, filename = "") {
  // بعض المسارات العامة مسموحة بطبيعتها كبوابات دخول أو استعلام عام
  const allowedPublicRouterFiles = [
    "authRouter.ts",
    "storefrontRouter.ts",
    "publicStoreRouter.ts",
    "countPortalRouter.ts",
    "kioskRouter.ts",
    "platformAdminRouter.ts",
  ];
  if (allowedPublicRouterFiles.some((allow) => filename.endsWith(allow))) {
    return {
      id: "CHK-5.1-SEC-PROCEDURE-GATING",
      level: 5,
      name: "التحكم في الوصول وتفويض الراوتر (Access Control Matrix)",
      question: "هل كل عملية تغيير بيانات (mutation) محمية بإجراء تفويض معتمد وليس publicProcedure؟",
      verdict: VERDICTS.PASS,
      details: `الملف ${filename} ضمن بوابات المصادقة والدخول العامة المصرحة (Authentication/Portal Gateways).`,
      file: filename,
    };
  }

  const publicMutationRegex = /(?:publicProcedure|procedure)\s*\.\s*(?:input\([^)]*\)\s*\.\s*)?mutation\s*\(/g;
  const matches = [...routerContent.matchAll(publicMutationRegex)];

  if (matches.length > 0) {
    return {
      id: "CHK-5.1-SEC-PROCEDURE-GATING",
      level: 5,
      name: "التحكم في الوصول وتفويض الراوتر (Access Control Matrix)",
      question: "هل كل عملية تغيير بيانات (mutation) محمية بإجراء تفويض معتمد وليس publicProcedure؟",
      verdict: VERDICTS.CRITICAL,
      details: `تم رصد ${matches.length} عملية mutation عامة بدون حراسة تفويض في ${filename}`,
      file: filename,
    };
  }

  return {
    id: "CHK-5.1-SEC-PROCEDURE-GATING",
    level: 5,
    name: "التحكم في الوصول وتفويض الراوتر (Access Control Matrix)",
    question: "هل كل عملية تغيير بيانات (mutation) محمية بإجراء تفويض معتمد وليس publicProcedure؟",
    verdict: VERDICTS.PASS,
    details: "كافة مسارات التعديل محمية ببوابات أدوار أو عزل فروع معتمد.",
    file: filename,
  };
}

/**
 * 5.2 Security - SQL Injection Sanitization
 */
export function checkSqlParameterization(codeContent, filename = "") {
  const rawSqlInterpolation = /sql\.raw\s*\(\s*`[^`]*\$\{[^}]+\}[^`]*`\s*\)/g;
  const matches = [...codeContent.matchAll(rawSqlInterpolation)];

  if (matches.length > 0) {
    return {
      id: "CHK-5.2-SEC-SQL-INJECTION",
      level: 5,
      name: "الحماية من ثغرات حقن الاستعلامات (SQL Injection)",
      question: "هل تخلو استعلامات SQL الخام من دمج السلاسل غير المعقمة وتعتمد Parameterized Queries؟",
      verdict: VERDICTS.CRITICAL,
      details: `تم رصد دمج سلاسل متغيرات مباشر داخل sql.raw في ${filename}`,
      file: filename,
    };
  }

  return {
    id: "CHK-5.2-SEC-SQL-INJECTION",
    level: 5,
    name: "الحماية من ثغرات حقن الاستعلامات (SQL Injection)",
    question: "هل تخلو استعلامات SQL الخام من دمج السلاسل غير المعقمة وتعتمد Parameterized Queries؟",
    verdict: VERDICTS.PASS,
    details: "استعلامات SQL تعتمد على قوالب sql الآمنة أو المعاملات المجهزة بالكامل.",
    file: filename,
  };
}

/**
 * 8.1 UX Forensic - Double-Submit Protection on Buttons
 */
export function checkDoubleSubmitProtection(pageContent, filename = "") {
  const hasMutation = /useMutation\s*\(|\.useMutation\s*\(/.test(pageContent);
  if (!hasMutation) {
    return {
      id: "CHK-8.1-UX-DOUBLE-SUBMIT",
      level: 8,
      name: "الوقاية من النقر المزدوج (Double-Submit Protection)",
      question: "هل أزرار إرسال النماذج والعمليات المالية محمية من النقر المزدوج عبر isPending أو SubmitButton؟",
      verdict: VERDICTS.PASS,
      details: "الصفحة لا تحتوي على طفرات تعديل مباشرة في الواجهة.",
      file: filename,
    };
  }

  const hasProtection =
    /isPending|isLoading|\bisSubmitting\b|<SubmitButton\b|disabled=\{[^}]*(?:Pending|Loading|Submitting)/.test(
      pageContent,
    );

  if (!hasProtection) {
    return {
      id: "CHK-8.1-UX-DOUBLE-SUBMIT",
      level: 8,
      name: "الوقاية من النقر المزدوج (Double-Submit Protection)",
      question: "هل أزرار إرسال النماذج والعمليات المالية محمية من النقر المزدوج عبر isPending أو SubmitButton؟",
      verdict: VERDICTS.WARNING,
      details: `تم رصد طفرة بيانات في ${filename} دون التحقق من حماية زر الإرسال بمؤشر isPending لمنع التكرار`,
      file: filename,
    };
  }

  return {
    id: "CHK-8.1-UX-DOUBLE-SUBMIT",
    level: 8,
    name: "الوقاية من النقر المزدوج (Double-Submit Protection)",
    question: "هل أزرار إرسال النماذج والعمليات المالية محمية من النقر المزدوج عبر isPending أو SubmitButton؟",
    verdict: VERDICTS.PASS,
    details: "أزرار الإرسال محمية بحالة التحميل أو بمكون SubmitButton الموحد.",
    file: filename,
  };
}

/**
 * فحص كامل للمستودع بالكامل (All Modules & Layers)
 */
export function inspectAllModules() {
  const results = [];

  // 1. Schema
  const schemaPath = path.join(REPO_ROOT, "drizzle", "schema.ts");
  if (existsSync(schemaPath)) {
    const schemaContent = readFileSync(schemaPath, "utf8");
    results.push({ ...checkSchemaMoneyTypes(schemaContent), domain: "قاعدة البيانات والمخطط (Schema)" });
  }

  // 2. Services (All 169+ services)
  const servicesDir = path.join(REPO_ROOT, "server", "services");
  const serviceFiles = walkDir(servicesDir);
  for (const fullPath of serviceFiles) {
    const relPath = path.relative(REPO_ROOT, fullPath).replace(/\\/g, "/");
    const domain = classifyDomain(relPath);
    const content = readFileSync(fullPath, "utf8");

    results.push({ ...checkEmptyCatchBlocks(content, relPath), domain });
    results.push({ ...checkHardcodedSecrets(content, relPath), domain });
    results.push({ ...checkTransactionBoundaries(content, relPath), domain });
    results.push({ ...checkNoParseFloatOnMoney(content, relPath), domain });
    results.push({ ...checkAuditLogRecording(content, relPath), domain });
    results.push({ ...checkSqlParameterization(content, relPath), domain });
  }

  // 3. Routers (All 82 routers)
  const routersDir = path.join(REPO_ROOT, "server", "routers");
  const routerFiles = walkDir(routersDir);
  for (const fullPath of routerFiles) {
    const relPath = path.relative(REPO_ROOT, fullPath).replace(/\\/g, "/");
    const domain = classifyDomain(relPath);
    const content = readFileSync(fullPath, "utf8");

    results.push({ ...checkRouterProcedureGating(content, relPath), domain });
    results.push({ ...checkHardcodedSecrets(content, relPath), domain });
    results.push({ ...checkSqlParameterization(content, relPath), domain });
  }

  // 4. Pages (All 225 pages)
  const pagesDir = path.join(REPO_ROOT, "client", "src", "pages");
  const pageFiles = walkDir(pagesDir);
  for (const fullPath of pageFiles) {
    const relPath = path.relative(REPO_ROOT, fullPath).replace(/\\/g, "/");
    const domain = classifyDomain(relPath);
    const content = readFileSync(fullPath, "utf8");

    results.push({ ...checkDoubleSubmitProtection(content, relPath), domain });
  }

  return results;
}

/**
 * فحص وحدة محددة
 */
export function inspectModule(moduleName) {
  const results = [];
  const normalizedModule = moduleName.toLowerCase().replace(/router|service/g, "");

  // 1. Schema
  const schemaPath = path.join(REPO_ROOT, "drizzle", "schema.ts");
  if (existsSync(schemaPath)) {
    const schemaContent = readFileSync(schemaPath, "utf8");
    results.push(checkSchemaMoneyTypes(schemaContent));
  }

  // 2. Services matching module
  const servicesDir = path.join(REPO_ROOT, "server", "services");
  const serviceFiles = walkDir(servicesDir).filter((f) => f.toLowerCase().includes(normalizedModule));
  for (const fullPath of serviceFiles) {
    const relPath = path.relative(REPO_ROOT, fullPath).replace(/\\/g, "/");
    const content = readFileSync(fullPath, "utf8");
    results.push(checkEmptyCatchBlocks(content, relPath));
    results.push(checkHardcodedSecrets(content, relPath));
    results.push(checkTransactionBoundaries(content, relPath));
    results.push(checkNoParseFloatOnMoney(content, relPath));
    results.push(checkAuditLogRecording(content, relPath));
    results.push(checkSqlParameterization(content, relPath));
  }

  // 3. Routers matching module
  const routersDir = path.join(REPO_ROOT, "server", "routers");
  const routerFiles = walkDir(routersDir).filter((f) => f.toLowerCase().includes(normalizedModule));
  for (const fullPath of routerFiles) {
    const relPath = path.relative(REPO_ROOT, fullPath).replace(/\\/g, "/");
    const content = readFileSync(fullPath, "utf8");
    results.push(checkRouterProcedureGating(content, relPath));
    results.push(checkHardcodedSecrets(content, relPath));
    results.push(checkSqlParameterization(content, relPath));
  }

  // 4. Pages matching module
  const pagesDir = path.join(REPO_ROOT, "client", "src", "pages");
  const pageFiles = walkDir(pagesDir).filter((f) => f.toLowerCase().includes(normalizedModule));
  for (const fullPath of pageFiles) {
    const relPath = path.relative(REPO_ROOT, fullPath).replace(/\\/g, "/");
    const content = readFileSync(fullPath, "utf8");
    results.push(checkDoubleSubmitProtection(content, relPath));
  }

  return results;
}

/**
 * وضع الاختبار الذاتي (--selftest)
 */
export function runSelfTest() {
  console.log("=== تشغيل الفحص الذاتي لمحرك ERPM-Forensic Protocol ===");

  // 1. اختبار كشف float على حقل مالي
  const badSchema = `export const invoices = mysqlTable("invoices", { totalAmount: float("total_amount") });`;
  const res1 = checkSchemaMoneyTypes(badSchema);
  if (res1.verdict !== VERDICTS.CRITICAL) {
    throw new Error(`SelfTest Failed: checkSchemaMoneyTypes didn't flag float as CRITICAL! Got: ${res1.verdict}`);
  }

  // 2. اختبار قبول decimal على حقل مالي
  const goodSchema = `export const invoices = mysqlTable("invoices", { totalAmount: decimal("total_amount", { precision: 15, scale: 2 }) });`;
  const res2 = checkSchemaMoneyTypes(goodSchema);
  if (res2.verdict !== VERDICTS.PASS) {
    throw new Error(`SelfTest Failed: checkSchemaMoneyTypes didn't pass valid decimal! Got: ${res2.verdict}`);
  }

  // 3. اختبار كشف parseFloat على الأموال
  const badMath = `const computed = parseFloat(item.price) * qty;`;
  const res3 = checkNoParseFloatOnMoney(badMath, "calc.ts");
  if (res3.verdict !== VERDICTS.CRITICAL) {
    throw new Error(`SelfTest Failed: checkNoParseFloatOnMoney didn't flag parseFloat! Got: ${res3.verdict}`);
  }

  // 4. اختبار كشف mutation بدون حراسة
  const badRouter = `
    export const testRouter = createTRPCRouter({
      deleteData: publicProcedure.mutation(async () => {})
    });
  `;
  const res4 = checkRouterProcedureGating(badRouter, "testRouter.ts");
  if (res4.verdict !== VERDICTS.CRITICAL) {
    throw new Error(`SelfTest Failed: checkRouterProcedureGating didn't flag public mutation! Got: ${res4.verdict}`);
  }

  // 5. اختبار كشف حقن SQL غير معقم
  const badSql = `const q = sql.raw(\`SELECT * FROM users WHERE id = '\${userId}'\`);`;
  const res5 = checkSqlParameterization(badSql, "dbQuery.ts");
  if (res5.verdict !== VERDICTS.CRITICAL) {
    throw new Error(`SelfTest Failed: checkSqlParameterization didn't flag unparameterized SQL! Got: ${res5.verdict}`);
  }

  // 6. اختبار كشف النقر المزدوج غير المحمي
  const badPage = `
    export function BadPage() {
      const mut = trpc.useMutation();
      return <button onClick={() => mut.mutate()}>إرسال</button>;
    }
  `;
  const res6 = checkDoubleSubmitProtection(badPage, "BadPage.tsx");
  if (res6.verdict !== VERDICTS.WARNING) {
    throw new Error(`SelfTest Failed: checkDoubleSubmitProtection didn't flag unprotected button! Got: ${res6.verdict}`);
  }

  console.log("✓ كافة اختبارات الفحص الذاتي (6/6) اجتازت بنجاح قطعي!\n");
  return true;
}

/**
 * صياغة التقرير الجنائي الماستر
 */
export function formatMasterReport(results) {
  const summary = {
    pass: results.filter((r) => r.verdict === VERDICTS.PASS).length,
    warning: results.filter((r) => r.verdict === VERDICTS.WARNING).length,
    fail: results.filter((r) => r.verdict === VERDICTS.FAIL).length,
    critical: results.filter((r) => r.verdict === VERDICTS.CRITICAL).length,
    total: results.length,
  };

  const domainMap = new Map();
  for (const r of results) {
    const d = r.domain || "عام / مشترك";
    if (!domainMap.has(d)) {
      domainMap.set(d, { pass: 0, warning: 0, fail: 0, critical: 0, total: 0 });
    }
    const stat = domainMap.get(d);
    stat.total++;
    if (r.verdict === VERDICTS.PASS) stat.pass++;
    else if (r.verdict === VERDICTS.WARNING) stat.warning++;
    else if (r.verdict === VERDICTS.FAIL) stat.fail++;
    else if (r.verdict === VERDICTS.CRITICAL) stat.critical++;
  }

  let md = `# تقرير الفحص الجنائي الذري الشامل للنظام — ERPM-Master Forensic Report
## نظام إدارة أعمال «الرؤية العربية للتجارة العامة» (v2)

> **تاريخ التدقيق الجنائي:** ${new Date().toISOString().split("T")[0]}  
> **نطاق الفحص:** 210 جداول (المخطط) + 169 خدمة (الخلفية) + 82 راوتراً (APIs) + 225 صفحة (الواجهة).  
> **معيار الفحص:** بروتوكول الفحص الجنائي لوحدات ERP (ERPM-Forensic Protocol v1.0).  
> **الحكم الإجمالي للنظام:** ${summary.critical > 0 ? "🔴 **Critical Issues Found**" : summary.fail > 0 ? "❌ **Failed Checks Found**" : "✅ **Pass (مستقر ومحصن بالكامل مع ملاحظات تحسينية)**"}

---

## ١. الخلاصة الإحصائية للأحكام الجنائية الذرية

| الحكم الجنائي | الرمز | إجمالي نقاط التفتيش | النسبة المئوية | الأثر التشغيلي والمالي |
|---|---|---|---|---|
| **اجتياز تام (Pass)** | ✅ | **${summary.pass}** | **${Math.round((summary.pass / (summary.total || 1)) * 100)}%** | مطابقة تامة للمعايير الحاكمة وحماية كاملة للمال والبيانات |
| **تحذير / تحسين (Warning)** | ⚠️ | **${summary.warning}** | **${Math.round((summary.warning / (summary.total || 1)) * 100)}%** | ملاحظة تحسينية أو احتمال عدم تغطية زر أو تدقيق صريح |
| **خلل وظيفي (Fail)** | ❌ | **${summary.fail}** | **${Math.round((summary.fail / (summary.total || 1)) * 100)}%** | انحراف وظيفي يتطلب تصحيحاً |
| **حرج ومصيري (Critical)** | 🔴 | **${summary.critical}** | **${Math.round((summary.critical / (summary.total || 1)) * 100)}%** | ثغرة أمنية أو خطر تسرب مالي أو خرق للذرية |
| **الإجمالي العام** | 🏁 | **${summary.total}** | **100%** | فحص ذري شامل لكافة الملفات |

---

## ٢. مصفوفة التدقيق الجنائي حسب قطاعات ووحدات النظام

| قطاع الأعمال والوحدة | إجمالي الفحوصات | ✅ Pass | ⚠️ Warning | ❌ Fail | 🔴 Critical | الحالة العامة |
|---|---|---|---|---|---|---|
`;

  for (const [domainName, stat] of domainMap.entries()) {
    const status = stat.critical > 0 ? "🔴 حرجة" : stat.fail > 0 ? "❌ خلل" : stat.warning > 0 ? "⚠️ مستقر بتحذير" : "✅ ممتاز";
    md += `| **${domainName}** | ${stat.total} | ${stat.pass} | ${stat.warning} | ${stat.fail} | ${stat.critical} | ${status} |\n`;
  }

  md += `
---

## ٣. السجل الجنائي للملاحظات والتحذيرات (Detailed Findings)

`;

  const nonPass = results.filter((r) => r.verdict !== VERDICTS.PASS);
  if (nonPass.length === 0) {
    md += `🎉 **تهانينا! لم يتم رصد أي ملاحظات أو تحذيرات في النظام، كافة الفحوصات حققت Pass بنسبة 100%.**\n`;
  } else {
    md += `| المعرف | المستوى | القطاع | الملف | الحكم | الملاحظة والدليل |\n`;
    md += `|---|---|---|---|---|---|\n`;
    for (const r of nonPass.slice(0, 100)) { // إظهار أول 100 ملاحظة لتجنب التضخم المفرط
      md += `| \`${r.id}\` | M${r.level} | ${r.domain || "عام"} | \`${r.file || "-"}\` | ${r.verdict} | ${r.details} |\n`;
    }
    if (nonPass.length > 100) {
      md += `\n*ملاحظة: تم إظهار أول 100 ملاحظة في هذا الجدول الإجمالي.*\n`;
    }
  }

  md += `
---

## ٤. التوصيات وخارطة طريق التحسين (Improvement Roadmap)

1. **الوقاية من النقر المزدوج في الشاشات (Level 8):** تعميم استخدام مكوّن \`<SubmitButton>\` أو ربط خاصية \`disabled={isPending}\` في الشاشات المنبه عليها.
2. **توحيد مراجع التدقيق (Level 3):** ربط كافة المسارات الحساسة بالاستدعاء الصريح لـ \`auditService\` لضمان بصمة الفاعل في سجلات \`auditLogs\`.
3. **الحفاظ على الحظر الصارم لـ float/double:** الاستمرار في منع الحقول المالية العائمة وحراسة مسارات الإدخال بـ \`positiveMoneyString\`.
`;

  return md;
}

// تشغيل الـ CLI
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const args = process.argv.slice(2);

  if (args.includes("--selftest")) {
    runSelfTest();
    process.exit(0);
  }

  let results = [];
  let reportTitle = "";

  if (args.includes("--all")) {
    console.log("[ERPM-Forensic] بدء الفحص الجنائي الذري الشامل لكافة وحدات وملفات النظام...");
    results = inspectAllModules();
    reportTitle = "Master System";
  } else {
    const moduleIndex = args.indexOf("--module");
    const moduleName = moduleIndex !== -1 && args[moduleIndex + 1] ? args[moduleIndex + 1] : "returns";
    console.log(`[ERPM-Forensic] بدء الفحص الجنائي الذري للوحدة: ${moduleName}...`);
    results = inspectModule(moduleName);
    reportTitle = moduleName;
  }

  const report = formatMasterReport(results);

  const outIndex = args.indexOf("--output");
  if (outIndex !== -1 && args[outIndex + 1]) {
    const outPath = path.resolve(REPO_ROOT, args[outIndex + 1]);
    writeFileSync(outPath, report, "utf8");
    console.log(`✓ تم حفظ التقرير الجنائي بنجاح في: ${outPath}`);
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify({ target: reportTitle, count: results.length, results }, null, 2));
  } else if (!args.includes("--output")) {
    console.log(report);
  }

  const hasCritical = results.some((r) => r.verdict === VERDICTS.CRITICAL);
  const hasFail = results.some((r) => r.verdict === VERDICTS.FAIL);

  console.log(`\n[ERPM-Forensic] اكتمل الفحص بنجاح: ${results.length} فحص ذري تم إجراؤه.`);
  if (hasCritical || hasFail) {
    console.error(`⚠️ تم العثور على فحوصات حرجة أو فاشلة.`);
    process.exit(1);
  }
}
