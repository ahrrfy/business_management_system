/**
 * حقل «مرجع العملية» للدفع غير النقدي (بطاقة/تحويل/محفظة) — رقم إشعار جهاز الدفع أو
 * رقم التحويل كما يظهر على شاشة الجهاز/التطبيق.
 *
 * إلزامي **بصرياً** فقط: إطار كهرماني + رسالة تحذير ما دام فارغاً، لكنه **لا يمنع إتمام
 * البيع** — قرار متحفّظ: لا نُفشل بيعاً جارياً أمام الزبون لغياب رقم؛ الرسالة توضّح أنّ
 * الرقم يلزم لمطابقة مبيعات البطاقة/التحويل مع كشف حساب المصرف لاحقاً.
 *
 * القيمة تُرسَل في `payment.reference` وتُحفظ خادمياً في `receipts.referenceNumber`.
 * الحقل يخفي نفسه للدفع النقدي (لا مرجع للنقد).
 */
import { AlertTriangle } from "lucide-react";
import { paymentMethodLabel } from "@/lib/paymentMethod";

/** توكنات الألوان التي يحتاجها الحقل — مشتركة بين POS (متغيّرات CSS) وPrintPOS (كائنات LIGHT/DARK). */
export interface PaymentReferenceColors {
  border: string;
  muted: string;
  mutedFg: string;
  fg: string;
  amber: string;
}

const PLACEHOLDER: Record<string, string> = {
  CARD: "رقم إشعار جهاز الدفع",
  TRANSFER: "رقم إشعار التحويل",
  WALLET: "رقم عملية المحفظة",
};

export function PaymentReferenceField({ value, onChange, method, colors, style, inputId }: {
  value: string;
  onChange: (v: string) => void;
  /** طريقة الدفع الحالية — الحقل لا يُرسم إطلاقاً للنقدي. */
  method: string;
  colors: PaymentReferenceColors;
  /** تنسيق الحاوية الخارجية (padding/هوامش حسب لوحة كل شاشة). */
  style?: React.CSSProperties;
  /** معرّف عنصر الإدخال — يلزم تمييزه عند تركيب الشاشة لأكثر من كاشير/حوار. */
  inputId?: string;
}) {
  if (method === "CASH") return null;
  const C = colors;
  const empty = value.trim() === "";
  const id = inputId ?? "payment-reference";
  return (
    <div style={style}>
      <label htmlFor={id} style={{ display: "block", fontSize: 11.5, color: C.mutedFg, fontWeight: 700, marginBottom: 4 }}>
        مرجع العملية — {paymentMethodLabel(method)}
      </label>
      <input
        id={id}
        dir="ltr"
        inputMode="text"
        autoComplete="off"
        maxLength={100}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={PLACEHOLDER[method] ?? "مرجع العملية"}
        style={{
          width: "100%", height: 40, boxSizing: "border-box",
          border: `1.5px solid ${empty ? C.amber : C.border}`,
          borderRadius: 8, background: C.muted, color: C.fg,
          fontFamily: "inherit", fontSize: 14, fontWeight: 700,
          padding: "0 10px", outline: "none", direction: "ltr", textAlign: "left",
        }}
      />
      {empty && (
        <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 4, marginTop: 3, fontSize: 11, color: C.amber, fontWeight: 700, lineHeight: 1.5 }}>
          <AlertTriangle aria-hidden size={12} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>أدخل رقم الإشعار — يلزم لمطابقة مبيعات {paymentMethodLabel(method)} مع كشف الحساب. يمكن إتمام البيع بدونه لكن ستصعب المطابقة.</span>
        </div>
      )}
    </div>
  );
}
