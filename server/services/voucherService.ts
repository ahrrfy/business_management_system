// سندات قبض/صرف مستقلّة (B1) — receipts بلا فاتورة بل بطرف مستقلّ (راتب، إيجار، دفعة لعميل، …).
// سند قبض (RV): direction='IN'، طرف يدفع للمحلّ (مثل مورد يَستلم دفعة، عميل يَدفع توقعاً).
// سند صرف (PV): direction='OUT'، المحلّ يَدفع لطرف (مثل راتب موظف، إيجار، دفعة لمورّد).
//
// التأثيرات:
//   - receipts row (مع voucherNumber فريد + partyType/partyId + description + voucherCategoryId + …)
//   - accountingEntries (PAYMENT_IN لـRV، PAYMENT_OUT لـPV)  ⇐ يُؤجَّل إن كانت الموافقة مُعلَّقة
//   - currentBalance للطرف (إن كان CUSTOMER أو SUPPLIER): ينقص لـCUSTOMER عند IN، يزيد عند OUT.
//   - shiftId يُشتقّ تلقائياً من وردية الموظّف المفتوحة (تسوية الصندوق).
//
// vouchers-pro (٣٠/٦/٢٦):
//   - Maker-Checker: مبالغ > VOUCHER_APPROVAL_THRESHOLD ⇒ approvalStatus=PENDING_APPROVAL ⇒ لا قيد/لا
//     رصيد/لا تأثير على الصندوق حتى approveVoucher() بواسطة مديرٍ آخر (SOD).
//   - signatureHash: SHA-256 على (id|amount|partyId|paymentMethod|voucherDate|createdBy|approvalStatus)
//     يُحسب بعد الاعتماد ويُحفظ ⇒ أي تَلاعب لاحق بـDB قابل للكشف.
//   - voucherCategoryId: اختياري مَوصى به للسندات OTHER (إيجار/راتب/خدمات/…) للتجميع في التَقارير.
//   - referenceNumber إلزامي لـTRANSFER؛ cardLastFour إلزامي لـCARD.
//   - attachmentUrl إلزامي فوق VOUCHER_ATTACHMENT_THRESHOLD.
//
// الذرّية: كلّها داخل withTx ⇒ rollback كامل عند أي خطأ.
//
// أُعيد تنظيم المنطق (كان ٧٩٦ سطراً في ملف واحد) إلى وحدات متماسكة تحت server/services/voucher/*
// **بلا أي تغيير سلوكي**: نفس الدوال والتواقيع. هذا الملف يعيد تصدير الواجهة العامة فقط كي تبقى
// كل المستدعيات (voucherRouter.ts والاختبارات) بلا أي تعديل.
//
// خريطة الوحدات:
//   types       — عقد السندات (PaymentMethod/PartyType داخليان، الباقي عام).
//   thresholds  — عتبات الاعتماد وإلزام المُرفق.
//   helpers     — البصمة/الترقيم/حلّ الدور/ملكية الفرع/التحقّق من الفئة — داخلية.
//   create      — إنشاء سند (Maker-Checker + idempotency).
//   approval    — اعتماد/رفض سند مُعلَّق (SOD-04).
//   cancel      — إلغاء سند (إيصال تعويضي + قيد معاكس).
//   queries     — القائمة + سند منفرد + الأخيرة لنفس الطرف.

export type { VoucherInput, VoucherResult } from "./voucher/types";
export { getApprovalThreshold, getAttachmentThreshold } from "./voucher/thresholds";
export { createVoucher } from "./voucher/create";
export type { ApproveVoucherResult, RejectVoucherResult } from "./voucher/approval";
export { approveVoucher, rejectVoucher } from "./voucher/approval";
export type { CancelVoucherResult } from "./voucher/cancel";
export { cancelVoucher } from "./voucher/cancel";
export type { ListVouchersInput } from "./voucher/queries";
export { listVouchers, getVoucher, recentVouchersForParty } from "./voucher/queries";
