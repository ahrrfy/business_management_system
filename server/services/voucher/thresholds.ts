// عتبات Maker-Checker (اعتماد) وإلزام المُرفق — قابلة للتجاوز عبر متغيّرات البيئة.

/** عَتبة Maker-Checker: مبالغ ≥ هذه القيمة (IQD) تَحتاج موافقة مدير ثانٍ.
 *  الافتراضي ١.٠٠٠.٠٠٠ IQD — قابل للتجاوز عبر ENV VOUCHER_APPROVAL_THRESHOLD_IQD. */
export function getApprovalThreshold(): number {
  const raw = process.env.VOUCHER_APPROVAL_THRESHOLD_IQD;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1_000_000;
}

/** عَتبة إلزام المُرفق: سند ≥ هذه القيمة (IQD) يَلزمه attachmentUrl.
 *  الافتراضي ٢٥٠.٠٠٠ IQD — قابل للتجاوز عبر ENV VOUCHER_ATTACHMENT_THRESHOLD_IQD. */
export function getAttachmentThreshold(): number {
  const raw = process.env.VOUCHER_ATTACHMENT_THRESHOLD_IQD;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 250_000;
}
