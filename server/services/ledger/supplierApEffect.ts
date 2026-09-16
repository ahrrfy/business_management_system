// المصدر الواحد لأثر قيدِ الدفتر على ذمّة المورّد (AP) — يوحّد النموذجين:
//   • القديم: قيد `entryType='PURCHASE'` يدائن AP (مسار receivePurchase + شراء الأصول/الأمانة…).
//   • الحديث (حوكمة المشتريات PR #923): مسار GRNI يرحّل بقيود `entryType='ADJUST'`؛ القيدُ الذي
//     يمسّ AP فعلاً هو **فاتورة المورّد** (`postSupplierInvoiceGrniTx`): GRNI → AP، بينما قيد
//     استلام البضاعة (`GRNI:RECEIPT`) يمسّ GRNI لا AP فيجب استثناؤه من حساب الذمّة.
//
// أيّ قارئٍ لرصيد المورّد (reconcile · كشف الحساب · أعمار الذمم · الرصيد المُرحَّل · تفصيل الأعمار)
// يجب أن يمرّ من هنا.

import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  GRNI_SUPPLIER_INVOICE_FORWARD_PREFIX,
  GRNI_SUPPLIER_INVOICE_REVERSAL_PREFIX,
} from "@shared/grniDedupe";

type ApOp = SQL | SQLWrapper;

export const GRNI_SUPPLIER_INVOICE_FORWARD_REGEXP = `^${GRNI_SUPPLIER_INVOICE_FORWARD_PREFIX}`;
export const GRNI_SUPPLIER_INVOICE_REVERSAL_REGEXP = `^${GRNI_SUPPLIER_INVOICE_REVERSAL_PREFIX}`;

export interface ApEntryCols {
  entryType: ApOp;
  amount: ApOp;
  liabilityAccount: ApOp;
  dedupeKey: ApOp;
}

/**
 * CASH_CLEARING is an operational clearing liability, not supplier AP.
 * It must not change the supplier's balance or appear in AP aging.
 */
export function supplierApEffectSql(
  cols: ApEntryCols,
  opts: { includeOpening?: boolean } = {},
): SQL {
  const includeOpening = opts.includeOpening ?? true;
  const amt = sql`CAST(${cols.amount} AS DECIMAL(15,2))`;
  return sql`CASE
    WHEN ${cols.liabilityAccount} = 'CASH_CLEARING' THEN 0
    WHEN ${cols.entryType} = 'PURCHASE'        THEN ${amt}
    WHEN ${cols.entryType} = 'PAYMENT_OUT'     THEN -${amt}
    WHEN ${cols.entryType} = 'PAYMENT_IN'      THEN ${amt}
    WHEN ${cols.entryType} = 'RETURN'          THEN ${amt}
    WHEN ${cols.entryType} = 'EXCHANGE_SETTLE' THEN -${amt}
    ${includeOpening ? sql`WHEN ${cols.entryType} = 'OPENING' THEN ${amt}` : sql``}
    WHEN ${cols.entryType} = 'ADJUST' AND ${cols.dedupeKey} REGEXP ${GRNI_SUPPLIER_INVOICE_REVERSAL_REGEXP} THEN -${amt}
    WHEN ${cols.entryType} = 'ADJUST' AND ${cols.dedupeKey} REGEXP ${GRNI_SUPPLIER_INVOICE_FORWARD_REGEXP}  THEN ${amt}
    ELSE 0 END`;
}

/** CASH_CLEARING purchases are excluded from supplier invoice recognition. */
export function isSupplierApRecognitionSql(
  cols: Pick<ApEntryCols, "entryType" | "liabilityAccount" | "dedupeKey">,
): SQL {
  return sql`(
    (${cols.entryType} = 'PURCHASE' AND (${cols.liabilityAccount} IS NULL OR ${cols.liabilityAccount} <> 'CASH_CLEARING'))
    OR (${cols.entryType} = 'ADJUST' AND ${cols.dedupeKey} REGEXP ${GRNI_SUPPLIER_INVOICE_FORWARD_REGEXP})
  )`;
}

export function isSupplierApLedgerEntrySql(
  cols: Pick<ApEntryCols, "entryType" | "dedupeKey">,
  opts: { includeOpening?: boolean } = {},
): SQL {
  const includeOpening = opts.includeOpening ?? true;
  const legacyTypes = includeOpening
    ? sql`${cols.entryType} IN ('PURCHASE','RETURN','PAYMENT_IN','PAYMENT_OUT','EXCHANGE_SETTLE','OPENING')`
    : sql`${cols.entryType} IN ('PURCHASE','RETURN','PAYMENT_IN','PAYMENT_OUT','EXCHANGE_SETTLE')`;
  return sql`(
    ${legacyTypes}
    OR (${cols.entryType} = 'ADJUST' AND ${cols.dedupeKey} REGEXP ${GRNI_SUPPLIER_INVOICE_FORWARD_REGEXP})
    OR (${cols.entryType} = 'ADJUST' AND ${cols.dedupeKey} REGEXP ${GRNI_SUPPLIER_INVOICE_REVERSAL_REGEXP})
  )`;
}
