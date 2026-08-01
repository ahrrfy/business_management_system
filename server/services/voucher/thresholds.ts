// عَتبة Maker-Checker (اعتماد) — قابلة للتجاوز عبر متغيّرات البيئة.
//
// ملاحظة (٣١/٧، قرار المالك): **لا مُرفق إلزامي في النظام كله** — أُلغيت عَتبة إلزام المُرفق
// (VOUCHER_ATTACHMENT_THRESHOLD_IQD) تماماً. المُرفق يبقى مُتاحاً واختيارياً في كل الشاشات.

/** عَتبة Maker-Checker: مبالغ ≥ هذه القيمة (IQD) تَحتاج موافقة مدير ثانٍ.
 *  الافتراضي ١.٠٠٠.٠٠٠ IQD — قابل للتجاوز عبر ENV VOUCHER_APPROVAL_THRESHOLD_IQD. */
export function getApprovalThreshold(): number {
  const raw = process.env.VOUCHER_APPROVAL_THRESHOLD_IQD;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1_000_000;
}
