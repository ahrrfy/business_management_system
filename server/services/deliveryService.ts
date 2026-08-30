// خدمة التوصيل (COD) — جهات التوصيل وعهدها — نقطة الدخول العامة.
//
// النموذج المحاسبي (٣ سجلّات لا تختلط): نقد الدرج / عهدة جهة التوصيل / ذمّة العميل (AR).
// الإسناد يسجّل تعرّض COD تشغيلياً فقط. عند إثبات التسليم والتحصيل تنتقل الذمّة إلى عهدة الجهة،
// ثم يحوّل التوريد العهدة إلى نقد الدرج. حالة الطرد مستقلة تماماً عن حالته المالية.
//
// أُعيد تنظيم المنطق (كان ٧٧١ سطراً في ملف واحد) إلى وحدات متماسكة تحت server/services/delivery/*
// هذا الملف يعيد تصدير الواجهة العامة كي تبقى المستدعيات مستقرة بينما يتوزع التنفيذ على وحدات واضحة.
//
// خريطة الوحدات:
//   types       — عقد التوصيل (الفاعلان داخليان، DeliveryPartyKind عام).
//   numbering   — ترقيم الإرسالية/دفعة الترحيل (ذرّي عبر GET_LOCK).
//   parties     — CRUD جهات التوصيل.
//   dispatch    — إنشاء إرسالية ASSIGNED من أمر جاهز أو فاتورة، بلا ختم تسليم مبكر.
//   courier     — قبول/استلام/خروج/تسليم فعلي وتحويل COD المحصّل إلى عهدة.
//   remittance  — توريد COD الموثق بأسطر غير قابلة للاستبدال.
//   returns     — إرجاع إرسالية (عكس SALE + مخزون + التعرض/العهدة + العربون).
//   settle      — تسوية عهدة قديمة، شطب عجز، واسترداد مبلغ مشطوب.
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
  listDeliveryPartyMembers,
  addDeliveryPartyMember,
  removeDeliveryPartyMember,
  reassignDeliveryConsignment,
} from "./delivery/parties";
export type { DispatchInput } from "./delivery/dispatch";
export { dispatchToDelivery } from "./delivery/dispatch";
export type { RemittanceLineInput, RemittanceInput } from "./delivery/remittance";
export { recordDeliveryRemittance } from "./delivery/remittance";
export { returnConsignment } from "./delivery/returns";
export type { SettleInput, WriteOffInput, RecoverWriteOffInput } from "./delivery/settle";
export { settleDeliveryBalance, writeOffDeliveryShortfall, recoverDeliveryWriteOff } from "./delivery/settle";
// كشف شركة التوصيل (١٩/٨): مستند التسوية الموحّد — يقود التسليم والتحصيل والتوريد معاً.
export {
  recordCompanyStatement,
  // ٢٢/٨ — إثبات تسليم بلا نقد (لا سند توريد) + إثبات يدوي استثنائي بموافقة مدير:
  recordDeliveryProof,
  recordManualDeliveryProof,
  recordStaffDeliveryConfirmation,
} from "./delivery/companyStatement";
export type {
  CompanyStatementInput,
  CompanyStatementResult,
  DeliveryProofInput,
  DeliveryProofResult,
  ManualDeliveryProofInput,
} from "./delivery/companyStatement";
export {
  countReadyForDispatch,
  listReadyForDispatch,
  listInTransitConsignments,
  listOpenConsignments,
  listConsignmentsForParty,
  listPartyRemittances,
  getDeliveryPartyStatement,
  getDeliveryPartyFinancials,
  getPartyStoreInTransit,
  // ٢٢/٨ — قراءات جديدة لحملة حياة الطلب:
  getConsignmentTimeline,
  listPartyObligations,
  // Slice DFP1 (٣٠/٨/٢٦) — قائمة الجهات المتأخّرة (SLA على عمر الطرود المفتوحة).
  listStaleParties,
} from "./delivery/queries";
// ٥/٨: إسناد فاتورةٍ قائمة (بيع مباشر بلا أمر شغل) للتوصيل — كان مستحيلاً بنيوياً.
export type { DispatchInvoiceInput } from "./delivery/dispatchInvoice";
export { dispatchInvoiceToDelivery } from "./delivery/dispatchInvoice";
export { payDeliveryFee, payPartyDeliveryFees } from "./delivery/fees";
export type { PayPartyDeliveryFeesInput, PayPartyDeliveryFeesResult } from "./delivery/fees";
// ٢٢/٨ — قناة الموظف المستندية لتقدّم الطرد (خروج جماعي + تعذّر بيد الموظف):
export { staffHandoverConsignments, staffMarkFailed } from "./delivery/staffTransition";
export type {
  StaffHandoverInput,
  StaffHandoverResult,
  StaffMarkFailedInput,
  StaffMarkFailedResult,
} from "./delivery/staffTransition";
// courier (١٢/٧): شاشة المندوب الذاتية «توصيلاتي» — عزل ذاتي عبر deliveryParties.userId.
export type { MyDeliveryRow, MyDeliveriesResult, ConfirmDeliveryResult, ConfirmConsignmentResult, FailDeliveryResult } from "./delivery/courier";
export { resolveCourierPartyId, listMyDeliveries, confirmCourierDelivery, confirmConsignmentDelivery, transitionConsignmentParcel, failCourierDelivery } from "./delivery/courier";
