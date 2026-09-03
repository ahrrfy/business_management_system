/**
 * cashReceiptSourceDocument — **من أيّ مستندٍ نشأ هذا الإيصال النقديّ** (٢/٩/٢٦).
 *
 * ═══════════════════════ لماذا وُجد هذا الملفّ ═══════════════════════
 * شاشتا تتبّع النقد الضائع كانتا تسمّيان **المفهوم نفسه** بقاموسَين محلّيَّين:
 *  · `client/src/pages/CashOrphanReport.tsx` — ثلاثُ قيم (`EXPENSE`/`VOUCHER`/`OTHER`)،
 *    مصدرُها `CashOrphanRow["source"]` في [`server/services/reportsTreasuryService.ts`].
 *  · `client/src/pages/CashRemediation.tsx` — ستُّ قيم (`EXPENSE`/`INVOICE`/`WORK_ORDER`/
 *    `RESERVATION`/`VOUCHER`/`RECEIPT`)، مصدرُها `sourceOf` في
 *    [`server/services/cashRemediation/classifier.ts`].
 *
 * والتعدادان ليسا متنافيَين بل **سلّمٌ واحدٌ بعمقَين**: كلاهما يقرأ صفَّ `receipts` نفسه —
 * مصروفٌ مرتبط ⇒ `EXPENSE`، ورقمُ سندٍ ⇒ `VOUCHER`. غير أنّ شاشة التشخيص تُفكّك ما قبل ذلك
 * (فاتورة/أمر شغل/حجز/إيصالٌ منفرد) بينما تقريرُ اليتيم يجمعه كلَّه في `OTHER`.
 * ⇒ الاتّحادُ أدناه يخدم الشاشتين بلا تغييرِ لفظٍ في أيٍّ منهما.
 *
 * ولماذا هذا مهمٌّ هنا بالذات: الشاشتان هما شاشتا **ملاحقة الدينار الضائع**، والموظّف يقارنهما
 * صفّاً بصفّ. لفظان لمستندٍ واحد يجعلانه يظنّهما مستندَين، فيعالج أحدهما ويترك الآخر —
 * وهو نقضُ المبدأ الحاكم: «لا دينار يضيع بصمت أو ليس له مسار أو تبويب».
 *
 * ⛔ **ليس هذا قاموس [`shared/documentActions.ts`](./documentActions.ts)** (`DOCUMENT_KIND_AR`)
 * ولا يُوحَّد معه رغم تصادُف `WORK_ORDER` نصّاً: ذاك يعدّ المستندات التي يقبل كلٌّ منها
 * **شريطَ أفعال** (تعديل/إلغاء/عكس/تصحيح) فمفاتيحُه `SALE_INVOICE` و`GOODS_RECEIPT`
 * و`PURCHASE_RETURN`، وهذا يعدّ ما **يُنشئ إيصالاً نقدياً** فمفاتيحُه `EXPENSE` و`VOUCHER`
 * و`RESERVATION`. عمودان مختلفان ومجموعتا قيمٍ لا تتقاطعان إلّا في مفتاحٍ واحد.
 *
 * ⛔ ولا يُعاد تسمية مفتاح: المفاتيح مشتقّةٌ من أعمدة `receipts` (`expenseId`/`invoiceId`/
 * `workOrderId`/`reservationId`/`voucherNumber`) في الخادم، لا من نصٍّ مخزَّن.
 */

export const CASH_RECEIPT_SOURCE_DOCUMENTS = [
  "EXPENSE",
  "VOUCHER",
  "INVOICE",
  "WORK_ORDER",
  "RESERVATION",
  "RECEIPT",
  "OTHER",
] as const;

export type CashReceiptSourceDocument =
  (typeof CASH_RECEIPT_SOURCE_DOCUMENTS)[number];

/**
 * التسميات العربية — منقولةٌ **حرفياً** من القاموسَين المحلّيَّين اللذين حلّت محلّهما،
 * فلا يتغيّر لفظٌ يراه الموظّف بهذا التوحيد.
 *
 * `RECEIPT` = «إيصال منفرد» عن قصد: إيصالٌ لا يسنده مستندُ عملٍ أصلاً — وتمييزُه عن
 * «إيصال» المجرَّد هو نصفُ التشخيص في شاشة الأرصدة السالبة.
 */
export const CASH_RECEIPT_SOURCE_LABEL_AR: Readonly<
  Record<CashReceiptSourceDocument, string>
> = Object.freeze({
  EXPENSE: "مصروف",
  VOUCHER: "سند",
  INVOICE: "فاتورة",
  WORK_ORDER: "أمر شغل",
  RESERVATION: "حجز",
  RECEIPT: "إيصال منفرد",
  OTHER: "أخرى",
});

export function isCashReceiptSourceDocument(
  value: unknown,
): value is CashReceiptSourceDocument {
  return (
    typeof value === "string" &&
    (CASH_RECEIPT_SOURCE_DOCUMENTS as readonly string[]).includes(value)
  );
}
