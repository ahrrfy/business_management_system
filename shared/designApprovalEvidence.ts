/**
 * **دليلُ قرار اعتماد التصميم — قاموسٌ واحد** (١/٩/٢٦).
 *
 * كانت التسمياتُ العربية محبوسةً داخل `TaskDetail.tsx` وحدها، فأيُّ شاشةٍ ثانية تعرض القرار
 * كانت ستُعيد كتابتها — وهو أصلُ «القواميس المنجرفة» الذي أُغلق مراراً (§٥، `invoiceStatus`).
 *
 * **قرار المالك (١/٩/٢٦): لا رفعَ لملفّ التصميم كي يُعتمد.** الرفعُ كان يملأ الخادمَ بصورٍ
 * base64 داخل قاعدة البيانات (حتى ٢ ميغابايت × ١٠ لكلّ أمر) بلا فائدةٍ تشغيليّة، والشاشةُ
 * كانت تحجب زرَّ الطلب حتى تُحفَظ «نسخةُ تصميم» — بينما الخادمُ يُثبّت النسخةَ تلقائياً
 * (`ensureCurrentDesignRevisionTx`) ولو كانت بلا صورةٍ واحدة. فالحجبُ كان في الشاشة وحدها.
 *
 * ولمّا كانت الموافقةُ الغالبة تقع **شفهياً عند الكاونتر أو بالهاتف**، فمرجعُ الدليل يُبنى
 * هنا نصّاً صادقاً يحمل الطلبَ والعميلَ والنسخة — لا «أخرى» عمياء تُفرغ السجلَّ من معناه.
 */

export const DESIGN_APPROVAL_EVIDENCE_TYPES = [
  "WHATSAPP_MESSAGE",
  "CUSTOMER_SIGNATURE",
  "EMAIL",
  "ATTACHMENT",
  "OTHER",
] as const;

export type DesignApprovalEvidenceTypeKey = (typeof DESIGN_APPROVAL_EVIDENCE_TYPES)[number];

export const DESIGN_APPROVAL_EVIDENCE_LABELS: Record<DesignApprovalEvidenceTypeKey, string> = {
  WHATSAPP_MESSAGE: "رسالة واتساب",
  CUSTOMER_SIGNATURE: "توقيع العميل",
  EMAIL: "بريد إلكتروني",
  ATTACHMENT: "مرفق محفوظ",
  OTHER: "موافقة شفهية / دليل آخر",
};

export function designApprovalEvidenceLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return (
    DESIGN_APPROVAL_EVIDENCE_LABELS[value as DesignApprovalEvidenceTypeKey] ?? value
  );
}

/** أقصرُ مرجعٍ يقبله الخادم (`normalizedRequiredText`). */
export const DESIGN_APPROVAL_REFERENCE_MIN = 3;
export const DESIGN_APPROVAL_REFERENCE_MAX = 500;
export const DESIGN_APPROVAL_REASON_MIN = 3;

/** أسبابٌ جاهزة — نقرةٌ بدل كتابة، والحقلُ الحرّ يبقى لما لا يُحصى. */
export const DESIGN_APPROVAL_REASONS = [
  "وافق العميل على التصميم",
  "طابق العميل الأسماء والمقاسات",
  "أكّد العميل بالهاتف",
] as const;

export const DESIGN_REJECTION_REASONS = [
  "طلب العميل تعديل التصميم",
  "خطأ في الأسماء أو الإملاء",
  "المقاس أو اللون غير مطابق",
] as const;

export interface DesignApprovalEvidenceContext {
  orderNumber: string;
  revision: number;
  customerName?: string | null;
  /** توقيعٌ زمنيّ محليّ يمرَّر من المستدعي — الوحدةُ نقيّةٌ بلا ساعة. */
  stampedAt?: string | null;
}

/**
 * مرجعُ الدليل الافتراضيّ: يُملأ بنقرةٍ ويبقى **قابلاً للتحرير**. يحمل ما يُعيد بناءَ الواقعة:
 * أيُّ أمرٍ، أيُّ نسخة، أيُّ عميل، ومتى — بلا ملفٍّ مرفوع.
 *
 * ⛔ **النصُّ يتبع القرار** (مراجعة Codex P1): مرجعٌ مبدوءٌ بـ«موافقة العميل» على سجلٍّ حالتُه
 * `REJECTED` يُوثّق قبولاً لم يقع — وهو أخطرُ من غياب الدليل، لأنّه يبدو إثباتاً. والحقلُ
 * مُهيَّأٌ سلفاً فيُقبَل كما هو غالباً، فلا يُعوَّل على تصحيح المراجع له.
 */
export function designApprovalEvidenceReference(
  decision: "APPROVED" | "REJECTED",
  ctx: DesignApprovalEvidenceContext,
): string {
  const head = decision === "APPROVED"
    ? `موافقة العميل على نسخة التصميم ${ctx.revision}`
    : `رفض العميل نسخة التصميم ${ctx.revision}`;
  const parts = [head, `أمر ${ctx.orderNumber}`];
  const customer = ctx.customerName?.trim();
  if (customer) parts.push(customer);
  const stamp = ctx.stampedAt?.trim();
  if (stamp) parts.push(stamp);
  return parts.join(" — ");
}

/** غلافُ توافقٍ لمسار الموافقة وحده. */
export function defaultDesignApprovalEvidenceReference(
  ctx: DesignApprovalEvidenceContext,
): string {
  return designApprovalEvidenceReference("APPROVED", ctx);
}
