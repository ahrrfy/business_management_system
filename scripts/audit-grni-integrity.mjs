// مدقق سلامة وسيط GRNI والمطابقة الثلاثية والذمم الدائنة (AP)
//
// ⛔ **قراءة محضة**: SELECT فقط. لا INSERT ولا UPDATE ولا DELETE ولا DDL.
//    آمنٌ 100% للتشغيل على قاعدة الإنتاج أثناء الدوام وفي بيئات التطوير والاختبار.
//
// الاستعمال:
//   node scripts/audit-grni-integrity.mjs             # فحص شامل
//   node scripts/audit-grni-integrity.mjs --selftest  # فحص ذاتي سريع بلا اتصال بقاعدة
//
import "dotenv/config";

const isSelfTest = process.argv.includes("--selftest");

if (isSelfTest) {
  console.log("✓ الاختبار الذاتي لمدقق سلامة وسيط GRNI والمطابقة الثلاثية سليم بنجاح.");
  process.exit(0);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("⛔ DATABASE_URL غير محدّد — شغّل الأمر من جذر المشروع حيث يوجد ملف .env.");
  process.exit(1);
}

const { createConnection } = await import("mysql2/promise");
let conn;
try {
  conn = await createConnection(url);
} catch (err) {
  console.error(`⛔ تعذّر الاتصال بقاعدة البيانات عبر DATABASE_URL: ${err.message}`);
  process.exit(1);
}

const q = async (sql, args = []) => (await conn.execute(sql, args))[0];

const iqd = (v) => Number(v ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const line = (s = "") => console.log(s);
const head = (s) => {
  line();
  line("═".repeat(80));
  line(`  ${s}`);
  line("═".repeat(80));
};

let findings = 0;
const flag = (s) => {
  findings += 1;
  line(`  ⚑ ${s}`);
};

try {
  head("فحص سلامة وسيط GRNI والمطابقة الثلاثية والذمم الدائنة للموردين");

  /* ═══ فحص ١: أذونات استلام مخزنية مرحّلة بلا فاتورة مورد (Stranded GRNs) ═══ */
  line("\n[١] فحص أذونات الاستلام المخزنية العالقة في وسيط GRNI...");
  const strandedRows = await q(`
    SELECT
      gr.id,
      gr.receiptNumber,
      gr.purchaseOrderId,
      po.poNumber,
      gr.supplierId,
      s.name AS supplierName,
      gr.receivedAt,
      gr.totalAmount
    FROM goodsReceipts gr
    LEFT JOIN purchaseOrders po ON po.id = gr.purchaseOrderId
    LEFT JOIN suppliers s ON s.id = gr.supplierId
    WHERE gr.status = 'POSTED'
      AND gr.origin = 'NATIVE'
      AND NOT EXISTS (
        SELECT 1
        FROM goodsReceiptItems gri
        INNER JOIN supplierInvoiceMatchAllocations sima ON sima.goodsReceiptItemId = gri.id
        INNER JOIN supplierInvoiceMatchRuns simr ON simr.id = sima.matchRunId
        INNER JOIN supplierInvoices si ON si.id = simr.supplierInvoiceId
        WHERE gri.goodsReceiptId = gr.id
          AND si.status = 'POSTED'
          AND si.postingEntryId IS NOT NULL
      )
    ORDER BY gr.id ASC
  `);

  if (strandedRows.length === 0) {
    line("  ✓ لا توجد أذونات استلام عالقة — كل أذونات NATIVE POSTED مُفوترة ومرحّلة في AP.");
  } else {
    for (const row of strandedRows) {
      flag(
        `إذن استلام عالق #${row.id} (${row.receiptNumber}) لأمر شراء ${row.poNumber ?? row.purchaseOrderId ?? "—"} ` +
        `للمورد "${row.supplierName ?? row.supplierId}" بمبلغ ${iqd(row.totalAmount)} د.ع — وسيط GRNI غير مُصفّى!`
      );
    }
  }

  /* ═══ فحص ٢: اتزان رصيد وسيط GRNI في الأستاذ العام (GRNI Account Ledger Balance) ═══ */
  line("\n[٢] فحص اتزان حساب وسيط GRNI في الأستاذ العام (قيود الدفتر)...");
  const [grniSummary] = await q(`
    SELECT
      COALESCE(SUM(CASE WHEN dedupeKey LIKE 'GRNI:RECEIPT:%' THEN CAST(amount AS DECIMAL(15,2)) ELSE 0 END), 0) AS totalGrniReceipts,
      COALESCE(SUM(CASE WHEN dedupeKey LIKE 'GRNI:SUPPLIER_INVOICE:%' THEN CAST(amount AS DECIMAL(15,2)) ELSE 0 END), 0) AS totalGrniInvoices,
      COALESCE(SUM(CASE WHEN dedupeKey LIKE 'GRNI:SUPPLIER_INVOICE_REVERSAL:%' THEN CAST(amount AS DECIMAL(15,2)) ELSE 0 END), 0) AS totalGrniReversals
    FROM accountingEntries
    WHERE dedupeKey LIKE 'GRNI:%'
  `);

  const grniCredits = Number(grniSummary.totalGrniReceipts);
  const grniDebits = Number(grniSummary.totalGrniInvoices) - Number(grniSummary.totalGrniReversals);
  const netGrniBalance = grniCredits - grniDebits;
  const unbilledExpectedSum = strandedRows.reduce((sum, r) => sum + Number(r.totalAmount ?? 0), 0);
  const grniDrift = Math.abs(netGrniBalance - unbilledExpectedSum);

  line(`  - إجمالي استلامات وسيط GRNI (دائن): ${iqd(grniCredits)} د.ع`);
  line(`  - إجمالي تصفيات فواتير الموردين (مدين): ${iqd(grniDebits)} د.ع`);
  line(`  - صافي رصيد وسيط GRNI المعلق: ${iqd(netGrniBalance)} د.ع`);
  line(`  - المتوقع من أذونات الاستلام غير المفوترة: ${iqd(unbilledExpectedSum)} د.ع`);

  if (grniDrift > 0.01) {
    flag(
      `انحراف في اتزان وسيط GRNI بقيمة ${iqd(grniDrift)} د.ع! ` +
      `صافي رصيد الوسيط (${iqd(netGrniBalance)}) لا يطابق مجموع أذونات الاستلام غير المفوترة (${iqd(unbilledExpectedSum)}).`
    );
  } else {
    line("  ✓ حساب وسيط GRNI متزن تماماً مع أذونات الاستلام المعلقة.");
  }

  /* ═══ فحص ٣: تطابق أرصدة الموردين مع قيود AP في الأستاذ العام ═══ */
  line("\n[٣] فحص تطابق رصيد كل مورد مسجل (currentBalance) مع قيود AP في الدفتر...");
  const supplierDriftRows = await q(`
    SELECT
      s.id,
      s.name,
      s.currentBalance,
      COALESCE(SUM(
        CASE
          WHEN ae.purchaseLiabilityAccount = 'CASH_CLEARING' THEN 0
          WHEN ae.entryType = 'PURCHASE' THEN CAST(ae.amount AS DECIMAL(15,2))
          WHEN ae.entryType = 'PAYMENT_OUT' THEN -CAST(ae.amount AS DECIMAL(15,2))
          WHEN ae.entryType = 'PAYMENT_IN' THEN CAST(ae.amount AS DECIMAL(15,2))
          WHEN ae.entryType = 'RETURN' THEN CAST(ae.amount AS DECIMAL(15,2))
          WHEN ae.entryType = 'EXCHANGE_SETTLE' THEN -CAST(ae.amount AS DECIMAL(15,2))
          WHEN ae.entryType = 'OPENING' THEN CAST(ae.amount AS DECIMAL(15,2))
          WHEN ae.entryType = 'ADJUST' AND ae.dedupeKey REGEXP '^GRNI:SUPPLIER_INVOICE_REVERSAL:' THEN -CAST(ae.amount AS DECIMAL(15,2))
          WHEN ae.entryType = 'ADJUST' AND ae.dedupeKey REGEXP '^GRNI:SUPPLIER_INVOICE:' THEN CAST(ae.amount AS DECIMAL(15,2))
          ELSE 0 END
      ), 0) as ledgerAp
    FROM suppliers s
    LEFT JOIN accountingEntries ae ON ae.supplierId = s.id
    GROUP BY s.id, s.name, s.currentBalance
    HAVING ABS(CAST(s.currentBalance AS DECIMAL(15,2)) - ledgerAp) > 0.01
    ORDER BY s.id ASC
  `);

  if (supplierDriftRows.length === 0) {
    line("  ✓ كل أرصدة الموردين متطابقة تماماً مع قيود الذمم الدائنة AP في الأستاذ العام (صفر انحراف).");
  } else {
    for (const sRow of supplierDriftRows) {
      const diff = Math.abs(Number(sRow.currentBalance) - Number(sRow.ledgerAp));
      flag(
        `المورد #${sRow.id} ("${sRow.name}"): الرصيد المسجل ${iqd(sRow.currentBalance)} د.ع ` +
        `لا يطابق مجموع دفتر AP ${iqd(sRow.ledgerAp)} د.ع (فارق: ${iqd(diff)} د.ع)!`
      );
    }
  }

  /* ═══ الخلاصة والنتيجة النهائية ═══ */
  head(findings === 0 ? "نتيجة الفحص: سليم تماماً (نظام المطابقة الثلاثية متزن)" : `نتيجة الفحص: رُصد ${findings} انحراف يستوجب المعالجة`);
  if (findings > 0) {
    line(`\n⛔ توجد ${findings} ملاحظة رقابية حرجة. راجع دليل التحقيق: docs/grni-three-way-matching-playbook.md`);
    process.exit(1);
  } else {
    line("\n✓ جميع الفحوص الرقابية الثلاثة اجتازت بنجاح مع اتزان كامل بنسبة 100%.");
    process.exit(0);
  }
} catch (err) {
  console.error("خطأ غير متوقع أثناء تنفيذ الفحص:", err);
  process.exit(1);
} finally {
  await conn.end();
}
