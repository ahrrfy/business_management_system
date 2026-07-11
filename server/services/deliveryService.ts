// خدمة التوصيل (COD) — جهات التوصيل وعهدها — نقطة الدخول العامة.
//
// النموذج المحاسبي (٣ سجلّات لا تختلط): نقد الدرج / عهدة جهة التوصيل / ذمّة العميل (AR).
// الإيراد يُعترف مرّة واحدة بقيد SALE عند الإرسال؛ COD يُوقَف على عهدة الجهة (currentBalance) لا على AR
// (فاتورة COD بـcustomerId=NULL ⇒ مطابقة AR لا تتلوّث). التسوية بخصم الأجرة وتوريد الصافي (D8).
//
// أُعيد تنظيم المنطق (كان ٧٧١ سطراً في ملف واحد) إلى وحدات متماسكة تحت server/services/delivery/*
// **بلا أي تغيير سلوكي**: نفس الدوال والتواقيع. هذا الملف يعيد تصدير الواجهة العامة فقط كي تبقى
// كل المستدعيات (deliveryRouter.ts والاختبارات) بلا أي تعديل.
//
// خريطة الوحدات:
//   types       — عقد التوصيل (الفاعلان داخليان، DeliveryPartyKind عام).
//   numbering   — ترقيم الإرسالية/دفعة الترحيل (ذرّي عبر GET_LOCK).
//   parties     — CRUD جهات التوصيل.
//   dispatch    — READY → DELIVERED + إرسالية (فاتورة COD + SALE + عهدة).
//   remittance  — ترحيل (D8): خصم الأجرة وتوريد الصافي.
//   returns     — إرجاع إرسالية (عكس SALE + مخزون + عهدة + عربون).
//   settle      — تسوية عهدة نقداً + شطب عجز.
//   queries     — قراءات الشاشة (جاهز للإرسال، إرساليات، كشف حساب).

export type { DeliveryPartyKind } from "./delivery/types";
export { nextConsignmentNumber, nextRemittanceNumber } from "./delivery/numbering";
export type { CreateDeliveryPartyInput, UpdateDeliveryPartyInput, ListPartiesOpts } from "./delivery/parties";
export {
  createDeliveryParty,
  updateDeliveryParty,
  setDeliveryPartyActive,
  listDeliveryParties,
  getDeliveryParty,
  listCourierAccounts,
} from "./delivery/parties";
export type { DispatchInput } from "./delivery/dispatch";
export { dispatchToDelivery } from "./delivery/dispatch";
export type { RemittanceLineInput, RemittanceInput } from "./delivery/remittance";
export { recordDeliveryRemittance } from "./delivery/remittance";
export { returnConsignment } from "./delivery/returns";
export type { SettleInput, WriteOffInput } from "./delivery/settle";
export { settleDeliveryBalance, writeOffDeliveryShortfall } from "./delivery/settle";
export {
  listReadyForDispatch,
  listOpenConsignments,
  listConsignmentsForParty,
  getDeliveryPartyStatement,
} from "./delivery/queries";
// courier (١٢/٧): شاشة المندوب الذاتية «توصيلاتي» — عزل ذاتي عبر deliveryParties.userId.
export type { MyDeliveryRow, MyDeliveriesResult, ConfirmDeliveryResult } from "./delivery/courier";
export { resolveCourierPartyId, listMyDeliveries, confirmCourierDelivery } from "./delivery/courier";
