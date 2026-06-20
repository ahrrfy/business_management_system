// precheck-0018.mjs — فحص مسبق لقاعدة الإنتاج قبل تطبيق migration 0018 (للقراءة فقط).
//
// لماذا: migration 0018 يضيف قيود CHECK (col >= 0) + CHECK (rating 0..5) + UNIQUE(nationalId).
// إن كان في الإنتاج صفٌّ واحد يخالف أيّ قيد، فسيفشل ALTER TABLE وتتوقّف الهجرة بالكامل
// (db-migrate-apply ذرّي: يتوقّف عند أوّل فشل). هذا السكربت يكشف تلك الصفوف **قبل** النشر
// كي يعالجها المالك بهدوء بدل أن تكسر النشر.
//
// التشغيل (على جهاز الإنتاج، بعد تحميل .env الإنتاجي):
//   node scripts/precheck-0018.mjs
// يخرج برمز 0 إذا كل القيود ستُطبَّق بنجاح (PASS)، وبرمز 1 إذا وُجد أيّ خرق (FAIL)،
// وبرمز 2 عند خطأ تشغيلي (DATABASE_URL مفقود/تعذّر الاتصال). لا يكتب أيّ شيء في القاعدة.

import "dotenv/config";
import { createConnection } from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("⛔ DATABASE_URL غير محدّد — لا يمكن الفحص.");
  process.exit(2);
}

// أعمدة CHECK (col >= 0) — مطابقة لـmigration 0018 بالضبط.
const NONNEG = [
  // branchStock.quantity مُقصى عمداً — مسموح أن يكون سالباً لخدمات الطباعة (allowNegative).
  ["receipts", "amount"],
  ["expenses", "amount"],
  ["invoices", "subtotal"],
  ["invoices", "total"],
  ["invoices", "paidAmount"],
  ["invoiceItems", "quantity"],
  ["invoiceItems", "baseQuantity"],
  ["invoiceItems", "unitPrice"],
  ["invoiceItems", "total"],
  ["purchaseOrders", "total"],
  ["purchaseOrders", "paidAmount"],
  ["purchaseOrderItems", "quantity"],
  ["purchaseOrderItems", "baseQuantity"],
  ["purchaseOrderItems", "unitPrice"],
  ["purchaseOrderItems", "total"],
  ["productVariants", "costPrice"],
];

// أعمدة CHECK (rating BETWEEN 0 AND 5) — الخرق فقط على القيم غير الـNULL.
const RATING = [
  ["suppliers", "rating"],
  ["jobApplicants", "rating"],
];

const conn = await createConnection(url);
const dbName = new URL(url).pathname.replace(/^\//, "");

/** يتحقّق أن (جدول.عمود) موجودان فعلاً قبل الاستعلام — قاعدة قديمة قد تنقصها أعمدة. */
async function columnExists(table, column) {
  const [rows] = await conn.query(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1",
    [dbName, table, column]
  );
  return rows.length > 0;
}

const violations = []; // { label, count, detail }
const skipped = []; // أعمدة غير موجودة (لا تُفحَص — لن يفشل ALTER عليها لأنه لن يُطبَّق)

try {
  // ── 1) CHECK (col >= 0) ──
  for (const [table, col] of NONNEG) {
    if (!(await columnExists(table, col))) {
      skipped.push(`${table}.${col} (العمود غير موجود)`);
      continue;
    }
    const [rows] = await conn.query(
      `SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${col}\` < 0`
    );
    const n = Number(rows[0].n);
    if (n > 0) {
      violations.push({ label: `CHECK ${table}.${col} >= 0`, count: n });
    }
  }

  // ── 2) CHECK (rating BETWEEN 0 AND 5) — تجاهل NULL ──
  for (const [table, col] of RATING) {
    if (!(await columnExists(table, col))) {
      skipped.push(`${table}.${col} (العمود غير موجود)`);
      continue;
    }
    const [rows] = await conn.query(
      `SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${col}\` IS NOT NULL AND (\`${col}\` < 0 OR \`${col}\` > 5)`
    );
    const n = Number(rows[0].n);
    if (n > 0) {
      violations.push({ label: `CHECK ${table}.${col} BETWEEN 0 AND 5`, count: n });
    }
  }

  // ── 3) UNIQUE(employees.nationalId) — التفرّد على القيم غير الـNULL فقط ──
  if (!(await columnExists("employees", "nationalId"))) {
    skipped.push("employees.nationalId (العمود غير موجود)");
  } else {
    const [rows] = await conn.query(
      "SELECT `nationalId` AS v, COUNT(*) AS n FROM `employees` WHERE `nationalId` IS NOT NULL GROUP BY `nationalId` HAVING COUNT(*) > 1 ORDER BY n DESC"
    );
    if (rows.length > 0) {
      const dupTotal = rows.reduce((s, r) => s + Number(r.n), 0);
      const sample = rows
        .slice(0, 10)
        .map((r) => `"${r.v}" ×${r.n}`)
        .join("، ");
      violations.push({
        label: "UNIQUE employees.nationalId",
        count: rows.length,
        detail: `قيم مكرّرة (${rows.length} قيمة، ${dupTotal} صفّاً): ${sample}${rows.length > 10 ? " …" : ""}`,
      });
    }
  }

  // ── التقرير ──
  console.log("══════════════════════════════════════════════════════════");
  console.log("  فحص مسبق لـmigration 0018 (للقراءة فقط) — قاعدة:", dbName);
  console.log("══════════════════════════════════════════════════════════");

  if (skipped.length) {
    console.log("ℹ️  أعمدة لم تُفحَص (غير موجودة في هذه القاعدة):");
    for (const s of skipped) console.log("     -", s);
    console.log("");
  }

  if (violations.length === 0) {
    console.log("✅ PASS — لا صفوف تخالف أيّ قيد جديد. الهجرة 0018 ستُطبَّق بأمان.");
    await conn.end();
    process.exit(0);
  }

  console.log("❌ FAIL — وُجدت صفوف تخالف القيود الآتية (ستفشل الهجرة 0018 عليها):");
  console.log("");
  for (const v of violations) {
    console.log(`   ⛔ ${v.label} — ${v.count} ${v.detail ? "" : "صفّاً مخالفاً"}`);
    if (v.detail) console.log(`        ${v.detail}`);
  }
  console.log("");
  console.log("   عالِج هذه الصفوف يدوياً (تصحيح/تنظيف) قبل تشغيل pnpm prod:deploy.");
  console.log("   السكربت للقراءة فقط — لم يُعدّل أيّ بيانات.");
  await conn.end();
  process.exit(1);
} catch (e) {
  await conn.end().catch(() => {});
  console.error("✗ تعذّر إتمام الفحص:", e?.message ?? e);
  if (e?.sqlMessage) console.error("   SQL:", e.sqlMessage);
  process.exit(2);
}
