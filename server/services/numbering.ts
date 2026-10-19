import { like, sql } from "drizzle-orm";
import {
  cashTransfers,
  consignmentNotes,
  deliveryConsignments,
  deliveryRemittances,
  exchangeTransactions,
  giftVouchers,
  goodsReceiptReversals,
  goodsReceipts,
  productionOrders,
  purchaseOrders,
  quotations,
  receipts,
  reservations,
  stockTransfers,
  supplierInvoices,
} from "../../drizzle/schema";
import type { Tx } from "../db";
import { toDateStr } from "./money";

/**
 * أرضيّة كل عدّاد — أوّل رقمٍ يُنتَج هو `floor + 1`. النطاقان متباعدان عمداً كي يُميَّز نوع
 * المستند بالنظر: الفواتير من ١٠٠٠١، وأوامر الشغل من ٥٠٠١.
 */
const COUNTER_FLOORS: Record<string, number> = {
  invoice: 10000,
  workOrder: 5000,
  unified_transaction: 100000,
  online_order: 100000,
};

interface PrefixFloorSpec {
  table: any;
  column: any;
  prefix: string;
}

const DAILY_BRANCH_COUNTER_SPECS: ReadonlyArray<{
  keyPrefix: string;
  docPrefix: string;
  table: any;
  column: any;
}> = [
  { keyPrefix: "consignment", docPrefix: "CN", table: deliveryConsignments, column: deliveryConsignments.consignmentNumber },
  { keyPrefix: "remittance", docPrefix: "DR", table: deliveryRemittances, column: deliveryRemittances.remittanceNumber },
  { keyPrefix: "purchase_order", docPrefix: "PO", table: purchaseOrders, column: purchaseOrders.poNumber },
  { keyPrefix: "grn", docPrefix: "GRN", table: goodsReceipts, column: goodsReceipts.receiptNumber },
  { keyPrefix: "grr", docPrefix: "GRR", table: goodsReceiptReversals, column: goodsReceiptReversals.reversalNumber },
  { keyPrefix: "supplier_invoice", docPrefix: "SIN", table: supplierInvoices, column: supplierInvoices.invoiceNumber },
  { keyPrefix: "quotation", docPrefix: "QUO", table: quotations, column: quotations.quoteNumber },
  { keyPrefix: "reservation", docPrefix: "RES", table: reservations, column: reservations.reservationNumber },
  { keyPrefix: "voucher_receipt", docPrefix: "RV", table: receipts, column: receipts.voucherNumber },
  { keyPrefix: "voucher_payment", docPrefix: "PV", table: receipts, column: receipts.voucherNumber },
  { keyPrefix: "cash_drop", docPrefix: "CD", table: receipts, column: receipts.referenceNumber },
  { keyPrefix: "treasury_funding", docPrefix: "TF", table: receipts, column: receipts.referenceNumber },
  { keyPrefix: "cash_transfer", docPrefix: "CT", table: cashTransfers, column: cashTransfers.transferNumber },
  { keyPrefix: "cash_handover", docPrefix: "CH", table: receipts, column: receipts.referenceNumber },
  { keyPrefix: "exchange", docPrefix: "EX", table: exchangeTransactions, column: exchangeTransactions.txnNumber },
  { keyPrefix: "gift", docPrefix: "GFT", table: giftVouchers, column: giftVouchers.giftNumber },
  { keyPrefix: "production_order", docPrefix: "PRD", table: productionOrders, column: productionOrders.docNumber },
  { keyPrefix: "consign_note", docPrefix: "CSN", table: consignmentNotes, column: consignmentNotes.noteNumber },
];

function resolvePrefixFloorSpec(counterKey: string): PrefixFloorSpec | null {
  for (const spec of DAILY_BRANCH_COUNTER_SPECS) {
    const match = new RegExp(`^${spec.keyPrefix}[_:](\\d+)[_:](\\d{8})$`).exec(counterKey);
    if (match) {
      return {
        table: spec.table,
        column: spec.column,
        prefix: `${spec.docPrefix}-${match[1]}-${match[2]}-`,
      };
    }
  }
  const voucherColonMatch = /^voucher:(RV|PV):(\d+):(\d{8})$/.exec(counterKey);
  if (voucherColonMatch) {
    return {
      table: receipts,
      column: receipts.voucherNumber,
      prefix: `${voucherColonMatch[1]}-${voucherColonMatch[2]}-${voucherColonMatch[3]}-`,
    };
  }
  const transferMatch = /^stock_transfer[_:](\d{4})$/.exec(counterKey);
  if (transferMatch) {
    return {
      table: stockTransfers,
      column: stockTransfers.transferNumber,
      prefix: `TRF-${transferMatch[1]}-`,
    };
  }
  return null;
}

/**
 * يستخرج أعلى لاحقة رقمية قائمة فعلياً في جدول المستندات لنفس البادئة (بلا قفل FOR UPDATE
 * لمنع أقفال الفجوات والجمود المتبادل)، على غرار cashTransferService وcashHandoverService.
 * يضمن هذا عدم تصادم العدّاد مع مستندات أُنشئت قبل ترحيل العدّادات أو تراجعت معاملتها.
 */
async function resolveExistingCounterFloor(tx: Tx, counterKey: string): Promise<number> {
  const spec = resolvePrefixFloorSpec(counterKey);
  if (!spec || typeof (tx as any).select !== "function") return 0;
  const rows: Array<{ n: string | null }> = await (tx as any)
    .select({ n: spec.column })
    .from(spec.table)
    .where(like(spec.column, `${spec.prefix}%`));
  let maxSeq = 0;
  for (const row of rows) {
    const suffix = String(row.n ?? "").slice(spec.prefix.length);
    const seqMatch = /^(\d+)(?:-|$)/.exec(suffix);
    if (!seqMatch) continue;
    const seq = Number.parseInt(seqMatch[1], 10);
    if (Number.isSafeInteger(seq) && seq > maxSeq) maxSeq = seq;
  }
  return maxSeq;
}

/**
 * حجزٌ ذرّيّ لرقمٍ تسلسليّ من عدّاد المستندات (هجرة 0211).
 *
 * عمليةٌ واحدة: `INSERT … ON DUPLICATE KEY UPDATE lastValue = LAST_INSERT_ID(GREATEST(lastValue + 1, floor + 1))`
 * — MySQL يضبط `LAST_INSERT_ID` للجلسة بالقيمة الجديدة، فنقرؤها بلا مسحٍ ولا قفلٍ صريح على جدول المستندات.
 */
export async function nextCounterValue(tx: Tx, counterKey: string): Promise<number> {
  // أرضيّة البدء تعيش في الكود + أعلى رقم قائم فعلياً في جدول المستندات لنفس البادئة:
  // يمنع ER_DUP_ENTRY عندما تكون هناك مستندات سابقة في نفس اليوم/الشهر قبل بدء العدّاد أو بعد تراجع معاملة.
  const staticFloor = COUNTER_FLOORS[counterKey] ?? 0;
  const dynamicFloor = await resolveExistingCounterFloor(tx, counterKey);
  const floor = Math.max(staticFloor, dynamicFloor);
  // `LAST_INSERT_ID(expr)` تضبط قيمة الجلسة **وتُعيدها** — فالفرعان (إدراجٌ أوّل / زيادةٌ على
  // قائم) يضبطانها معاً في عبارةٍ ذرّيّةٍ واحدة، بلا قفلٍ على جدول الهدف.
  await tx.execute(sql`
    INSERT INTO documentCounters (counterKey, lastValue)
    VALUES (${counterKey}, LAST_INSERT_ID(${floor + 1}))
    ON DUPLICATE KEY UPDATE lastValue = LAST_INSERT_ID(GREATEST(lastValue + 1, ${floor + 1}))
  `);
  const res: any = await tx.execute(sql`SELECT LAST_INSERT_ID() AS v`);
  const row = Array.isArray(res) ? res[0]?.[0] : res?.rows?.[0];
  const value = Number(row?.v ?? 0);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`document counter "${counterKey}" returned an invalid value`);
  }
  return value;
}

/**
 * رقم الفاتورة — **عددٌ تسلسليّ قصير** يبدأ من 10001 (طلب المالك ١٨/٨).
 *
 * كان `INV-{فرع}-{YYYYMMDD}-{تسلسل}`: يُملى هاتفياً بصعوبة ويُكتب يدوياً بخطأ. الرقم الجديد
 * يُقرأ ويُملى بلا لبس، والفرعُ والتاريخ حقلان معروضان على المستند لا جزءٌ من الرقم.
 *
 * الباركود يبقى **بادئياً** (`INV-10023` في Code128 وفي حمولة QR) — بهذا يفصل النظام رقمَ
 * العرض عن رمز الآلة: العين ترى رقماً قصيراً، والماسح يعرف نوع المستند من بادئته فيوجّهه
 * صحيحاً. الأرقام التاريخية تبقى كما هي وتبقى قابلة للبحث.
 *
 * `branchId` يبقى في التوقيع (مستدعون كثر يمرّرونه) وإن لم يعد يدخل الرقم: العدّاد عالميّ
 * لأنّ `invoices.invoiceNumber` قيدُه الفريد عالميّ أصلاً — عدّادٌ لكل فرعٍ كان سيتصادم.
 *
 * ⚠️ **ترتيب الأقفال القانوني (فحص الحمل ٣٠/٨/٢٦):** صفّ العدّاد قفلٌ X **عالميّ مشترك** بين
 * كل مسارات الترقيم ويبقى محجوزاً حتى COMMIT. الترتيب الواجب على كل مسارٍ يُرقّم مستنداً هو:
 *
 *     وردية (shifts) ← عميل (customers) ← عدّاد (documentCounters) ← بقيّة المستند
 *
 * فأيّ صفٍّ مشتركٍ يُقفَل أو يُحدَّث في المعاملة يجب أن يُقفَل **قبل** استدعاء هذه الدالة، وبهذا
 * الترتيب بين الصفوف المشتركة نفسها. قلبُ أيّ زوجٍ منه أنتج ABBA فعلياً: البيع (عميل ← عدّاد)
 * مقابل توزيع التوصيل (عدّاد ← عميل)، والبيع (وردية ← عميل) مقابل التسليم (عميل ← وردية).
 *
 * ⚠️ **`assertCreditLimit` يقفل صفّ العميل** — فهو نقطة قفلٍ لا مجرّد تحقّق، ويجب أن يقع بعد
 * قفل الوردية. هذه بالذات فاتت في التقويم الأوّل وأمسكها Codex على #901.
 *
 * المواضع المُقوَّمة: sale/create.ts وprintSaleService.ts (أصلاً صحيحة)، وworkOrder/deliver.ts
 * (أُعيد ترتيبه كاملاً)، وdelivery/dispatch.ts (قفل عميلٍ صريحٍ قبل الترقيم؛ ورديته تُقرأ
 * بلا قفل أصلاً فلا زوجَ {وردية،عميل} فيه).
 */
export async function nextInvoiceNumber(tx: Tx, _branchId: number): Promise<string> {
  return String(await nextCounterValue(tx, "invoice"));
}

/**
 * حجزٌ ذرّيّ لرقم المعاملة الموحّد (R1).
 * يبدأ من 100001 (أرضية 100000) من عدّاد `unified_transaction` العالمي في `documentCounters`.
 * يُورَّث الرقم الأساسي تلقائياً لجميع المستندات والحركات الناتجة عنها.
 */
export async function nextTransactionTrackingNumber(tx: Tx): Promise<string> {
  const floorCheck: any = await tx.execute(sql`
    SELECT lastValue FROM documentCounters WHERE counterKey = 'unified_transaction_floor' LIMIT 1
  `);
  const floorRow = Array.isArray(floorCheck) ? floorCheck[0]?.[0] : floorCheck?.rows?.[0];
  if (!floorRow) {
    await tx.execute(sql`
      INSERT INTO documentCounters (counterKey, lastValue)
      SELECT 'unified_transaction_floor', GREATEST(
        100000 + COALESCE(MAX(id), 0),
        COALESCE(MAX(CASE WHEN orderNumber REGEXP '^ORD-[0-9]+$' THEN CAST(SUBSTRING(orderNumber, 5) AS UNSIGNED) ELSE 0 END), 0),
        COALESCE((SELECT MAX(CAST(SUBSTRING_INDEX(invoiceNumber, '-', 1) AS UNSIGNED)) FROM invoices WHERE invoiceNumber REGEXP '^[0-9]{6,}(-[0-9]+)?$'), 0),
        COALESCE((SELECT MAX(CAST(SUBSTRING_INDEX(orderNumber, '-', 1) AS UNSIGNED)) FROM workOrders WHERE orderNumber REGEXP '^[0-9]{6,}(-[0-9]+)?$'), 0),
        COALESCE((SELECT MAX(CAST(SUBSTRING_INDEX(draftNumber, '-', 1) AS UNSIGNED)) FROM receptionDrafts WHERE draftNumber REGEXP '^[0-9]{6,}(-[0-9]+)?$'), 0)
      )
      FROM onlineOrders
      ON DUPLICATE KEY UPDATE lastValue = lastValue
    `);
    await tx.execute(sql`
      INSERT INTO documentCounters (counterKey, lastValue)
      SELECT 'unified_transaction', GREATEST(
        100000 + COALESCE(MAX(id), 0),
        COALESCE(MAX(CASE WHEN orderNumber REGEXP '^ORD-[0-9]+$' THEN CAST(SUBSTRING(orderNumber, 5) AS UNSIGNED) ELSE 0 END), 0),
        COALESCE((SELECT MAX(CAST(SUBSTRING_INDEX(invoiceNumber, '-', 1) AS UNSIGNED)) FROM invoices WHERE invoiceNumber REGEXP '^[0-9]{6,}(-[0-9]+)?$'), 0),
        COALESCE((SELECT MAX(CAST(SUBSTRING_INDEX(orderNumber, '-', 1) AS UNSIGNED)) FROM workOrders WHERE orderNumber REGEXP '^[0-9]{6,}(-[0-9]+)?$'), 0),
        COALESCE((SELECT MAX(CAST(SUBSTRING_INDEX(draftNumber, '-', 1) AS UNSIGNED)) FROM receptionDrafts WHERE draftNumber REGEXP '^[0-9]{6,}(-[0-9]+)?$'), 0)
      )
      FROM onlineOrders
      ON DUPLICATE KEY UPDATE lastValue = GREATEST(lastValue, VALUES(lastValue))
    `);
  }
  return String(await nextCounterValue(tx, "unified_transaction"));
}

export { formatDocumentNumber } from "../../shared/documentNumber";

/**
 * بضاعة الأمانة (ش٢): رقم سند حركة أمانة يوميّ لكل فرع — CSN-{branchId}-{YYYYMMDD}-{seq}.
 * حجز ذرّي عبر عدّاد documentCounters لمنع سباقات التزامن.
 */
export async function nextConsignmentNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `CSN-${branchId}-${ymd}-`;
  const counterKey = `consign_note_${branchId}_${ymd}`;
  const seq = await nextCounterValue(tx, counterKey);
  return prefix + String(seq).padStart(5, "0");
}
