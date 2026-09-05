/**
 * **لوحة جهات التوصيل والتسوية اليوميّة** — العقد المشترك بين الخادم (م١-خادم:
 * `server/services/delivery/board.ts` و`dailySettlement.ts`) والواجهة (م١-عميل: لوحة الخمسة
 * أعمدة + شاشة التسوية اليوميّة). برنامج v2 «السهل الممتنع»، الموجة م١.
 *
 * ⛔ الأشكال أدناه **عقدٌ حرفيّ** يستورده الطرفان — أيّ تغييرٍ في حقلٍ يُغيَّر هنا وحده ويُقرأ
 * من الجانبين. الأموال سلاسلُ `decimal(2)` (لا `number`) كسائر عقود المستودع (§٥).
 *
 * ## الأعمدة الخمسة (لكلّ جهة)
 * دلاءُ الطرود من `deliveryConsignments.parcelStatus` — حالةُ الطرد **الفيزيائيّة**، لا حالةُ
 * الإغلاق الماليّ (`consignmentStatus`) ولا حالةُ النقد (`moneyStatus`):
 *   · `assigned`            ASSIGNED | ACCEPTED | PICKED_UP — خرج من المكتبة ولم يخرج للزبون.
 *   · `inTransit`           OUT_FOR_DELIVERY — في الطريق إلى الزبون.
 *   · `deliveredUnremitted` DELIVERED مع moneyStatus UNSETTLED | PARTIAL — وصل الزبون والنقد لم يُورَّد.
 *   · `returned`            RETURNED خلال آخر ٣٠ يوماً.
 *   · `cancelled`           CANCELLED خلال آخر ٣٠ يوماً.
 *
 * ## النقد بيد الجهة — مصدران يُعرَضان معاً (الطرح الظلّيّ، الخطّة §١٠)
 *   · `cashInHandLedger` مشتقٌّ من دفتر التوصيل الإلحاقيّ (`deliveryLedgerEntries`):
 *       Σ(COD_COLLECTED + SHORTFALL_ASSIGNED + COD_RECOVERED) − Σ(COD_REMITTED + COD_WRITTEN_OFF)
 *   · `cashInHandStored` العمود المخزَّن `deliveryParties.currentBalance` (المرجع القائم اليوم).
 *   · `cashInHandDrift`  = ledger − stored. الصفرُ هو الصحّة؛ وغيرُه انحرافٌ تُظهره الواجهة شارةً
 *     بدل أن يُبتلَع — وهو ما يقرّر متى يُقلَب العلَم `courierLedgerDerived` إلى `ON`.
 *
 * `feesOwed` و`net` بحسب `shared/partyExposure.ts` (الدالّة النقيّة `computePartyExposure`).
 */

export type PartyBoardBucket = { count: number; amount: string };

export type PartyBoardRow = {
  partyId: number;
  partyName: string;
  partyType: "INDIVIDUAL" | "COMPANY";
  assigned: PartyBoardBucket;            // parcelStatus ASSIGNED|ACCEPTED|PICKED_UP
  inTransit: PartyBoardBucket;           // OUT_FOR_DELIVERY
  deliveredUnremitted: PartyBoardBucket; // DELIVERED & moneyStatus UNSETTLED|PARTIAL
  returned: PartyBoardBucket;            // parcelStatus RETURNED خلال آخر ٣٠ يوماً
  cancelled: PartyBoardBucket;           // parcelStatus CANCELLED خلال آخر ٣٠ يوماً
  cashInHandLedger: string;              // مشتقّ من deliveryLedgerEntries
  cashInHandStored: string;              // deliveryParties.currentBalance (ظلّ)
  cashInHandDrift: string;               // ledger − stored
  feesOwed: string; net: string;         // بحسب partyExposure
  staleOpenParcels: number;              // أقدم من maxOpenParcelAgeDays
};

export type SettlementPreviewLine = {
  consignmentId: number;
  consignmentNumber: string;
  invoiceNumber: string;
  customerName: string;
  codAmount: string;
  collectedAmount: string;
  remaining: string;
  parcelStatus: string;
};

export type SettlementPreview = {
  partyId: number;
  branchId: number;
  /** Σ المتبقّي الحيّ على الطرود المُسلَّمة غير المورَّدة — «المتوقَّع محسوبٌ سلفاً». */
  expectedCash: string;
  /** أجرةُ الجهة المستحقّة من الدفتر (FEE_EARNED − FEE_REFUNDED − FEE_PAID − FEE_OFFSET ≥ 0) — تُصرف بسندٍ مستقلّ، لا تُخصَم من التوريد (D8). */
  feeDue: string;
  /** استقطاعاتُ كشف الشركة المعروفة سلفاً — صفرٌ في المعاينة (تُدخَل لحظة التوريد إن وُجدت). */
  deductions: string;
  /** = expectedCash − deductions: ما يجب أن يُعدّ في الدرج. */
  net: string;
  lines: SettlementPreviewLine[];
  /** طرودٌ أُعلن رجوعُها ولم تُستلَم فعلياً بعد — تُذكّر المستلِم بما يجب أن يعود مع النقد. */
  returnsAwaitingReceipt: number;
};

export type SettleDailyResult = {
  remittanceId: number;
  status: "BALANCED" | "SHORT";
  shortfallTotal: string;
  receiptId: number | null;
};
