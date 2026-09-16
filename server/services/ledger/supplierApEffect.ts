// المصدر الواحد لأثر قيدِ الدفتر على ذمّة المورّد (AP) — يوحّد النموذجين:
//   • القديم: قيد `entryType='PURCHASE'` يدائن AP (مسار receivePurchase + شراء الأصول/الأمانة…).
//   • الحديث (حوكمة المشتريات PR #923): مسار GRNI يرحّل بقيود `entryType='ADJUST'`؛ القيدُ الذي
//     يمسّ AP فعلاً هو **فاتورة المورّد** (`postSupplierInvoiceGrniTx`): GRNI → AP، بينما قيد
//     استلام البضاعة (`GRNI:RECEIPT`) يمسّ GRNI لا AP فيجب استثناؤه من حساب الذمّة.
//
// لماذا `dedupeKey` لا `postingProfile`؟ عمود `postingProfile` **لا يُملأ إلّا حين يكون الدفتر
// المزدوج مفعَّلاً** (OFF افتراضياً في الإنتاج — راجع ledgerService.postEntry) ⇒ يكون NULL على
// كل قيود الإنتاج فلا يصلح مميِّزاً. أمّا `dedupeKey` فيُكتب دائماً على قيود GRNI ببادئةٍ ثابتة.
// نطابقه بـ`REGEXP` لا `LIKE` كي يُعامَل `_` حرفاً حقيقياً لا محرفَ بدلٍ (LIKE wildcard).
//
// أيّ قارئٍ لرصيد المورّد (reconcile · كشف الحساب · أعمار الذمم · الرصيد المُرحَّل · تفصيل الأعمار)
// يجب أن يمرّ من هنا، وإلّا انحرف عن الرصيد المخزَّن كما حدث بعد هجرة GRNI (أوامر شراء حديثة
// تختفي من الكشف ورصيدها صحيح، وreconcile يُنذر انحرافاً كاذباً). راجع الذاكرة
// [[supplier-statement-grni-adjust-blindness-2026-09-11]].

import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  GRNI_SUPPLIER_INVOICE_FORWARD_PREFIX,
  GRNI_SUPPLIER_INVOICE_REVERSAL_PREFIX,
} from "@shared/grniDedupe";

type ApOp = SQL | SQLWrapper;

// أنماط REGEXP مشتقّة من بادئات dedupeKey المشتركة (المصدر الوحيد في @shared/grniDedupe).
// نستعمل REGEXP لا LIKE كي يُعامَل `_` حرفاً حقيقياً لا محرفَ بدل. بادئاتنا بلا محارف regex خاصّة
// عدا لا شيء (`:`/`_`/الحروف كلّها حرفيّة)، فالبادئة نفسها نمطٌ صالح مسبوقٌ بـ`^`.
/** REGEXP لقيد فاتورة المورّد GRNI (يدائن AP، أثرٌ موجب). */
export const GRNI_SUPPLIER_INVOICE_FORWARD_REGEXP = `^${GRNI_SUPPLIER_INVOICE_FORWARD_PREFIX}`;
/** REGEXP لعكس فاتورة المورّد GRNI (يَدين AP، أثرٌ سالب). */
export const GRNI_SUPPLIER_INVOICE_REVERSAL_REGEXP = `^${GRNI_SUPPLIER_INVOICE_REVERSAL_PREFIX}`;

/** أعمدة القيد اللازمة — تُمرَّر إمّا كأعمدة Drizzle (`accountingEntries.amount`) أو كأجزاء
 *  SQL خام لسياق الاسم المستعار (`sql\`ae.amount\``)؛ كلاهما `SQLWrapper` صالحٌ في قالب sql. */
export interface ApEntryCols {
  entryType: ApOp;
  amount: ApOp;
  liabilityAccount: ApOp;
  dedupeKey: ApOp;
}

/**
 * أثر القيد الموقَّع على ذمّة المورّد (موجب = يزيد ما ندين به له).
 * يطابق تماماً صيغة `reconcileSupplierBalances` للأنواع الستّة القديمة، ويضيف قيدَي GRNI الحديثين.
 * @param opts.includeOpening افتراضياً true؛ مرِّر false حين يُحسَب OPENING منفصلاً (الرصيد المُرحَّل).
 */
export function supplierApEffectSql(cols: ApEntryCols, opts: { includeOpening?: boolean } = {}): SQL {
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

/** هل القيد **اعترافُ شراءٍ** يدائن AP (فاتورةٌ ندين بها)؟ = PURCHASE القديم أو فاتورة GRNI الحديثة.
 *  يُستعمل لاشتقاق «قيمة الفاتورة» و«تاريخ الاعتراف» في الكشف/الأعمار. */
export function isSupplierApRecognitionSql(
  cols: Pick<ApEntryCols, "entryType" | "liabilityAccount" | "dedupeKey">,
): SQL {
  return sql`(
    (${cols.entryType} = 'PURCHASE' AND (${cols.liabilityAccount} IS NULL OR ${cols.liabilityAccount} <> 'CASH_CLEARING'))
    OR (${cols.entryType} = 'ADJUST' AND ${cols.dedupeKey} REGEXP ${GRNI_SUPPLIER_INVOICE_FORWARD_REGEXP})
  )`;
}

/** هل يشارك القيدُ في دفتر ذمّة المورّد أصلاً؟ (لتصفية القيود المسحوبة قبل جمعها).
 *  @param opts.includeOpening افتراضياً true. */
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
