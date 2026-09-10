/**
 * حقل «مرجع العملية» للدفع غير النقدي (بطاقة/تحويل/محفظة) — رقم إشعار جهاز الدفع أو
 * رقم التحويل كما يظهر على شاشة الجهاز/التطبيق.
 *
 * لا يَكفي إدخال النص: زر التأكيد ينشئ محاولةً خادمية INITIATED ثم يثبتها CONFIRMED،
 * ولا تسمح الشاشة بإتمام البيع حتى ترتبط بهوية تلك المحاولة. الحقل يخفي نفسه للنقدي.
 */
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { paymentMethodLabel } from "@/lib/paymentMethod";

/** توكنات الألوان التي يحتاجها الحقل — مشتركة بين POS (متغيّرات CSS) وPrintPOS (كائنات LIGHT/DARK). */
export interface PaymentReferenceColors {
  border: string;
  muted: string;
  mutedFg: string;
  fg: string;
  amber: string;
  success: string;
}

const PLACEHOLDER: Record<string, string> = {
  CARD: "رقم إشعار جهاز الدفع",
  TRANSFER: "رقم إشعار التحويل",
  WALLET: "رقم عملية المحفظة",
};

export function PaymentReferenceField({ value, onChange, method, confirmed, confirming, onConfirm, colors, style, inputId }: {
  value: string;
  onChange: (v: string) => void;
  /** طريقة الدفع الحالية — الحقل لا يُرسم إطلاقاً للنقدي. */
  method: string;
  colors: PaymentReferenceColors;
  /** تنسيق الحاوية الخارجية (padding/هوامش حسب لوحة كل شاشة). */
  style?: React.CSSProperties;
  /** معرّف عنصر الإدخال — يلزم تمييزه عند تركيب الشاشة لأكثر من كاشير/حوار. */
  inputId?: string;
  /** true فقط حين تطابق محاولة CONFIRMED الخادمية الطريقة+المرجع+المبلغ الحالي. */
  confirmed: boolean;
  confirming: boolean;
  onConfirm: () => void;
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
      <div style={{ display: "flex", gap: 5, marginTop: 3 }}>
        <input
          id={id}
          dir="ltr"
          inputMode="text"
          autoComplete="off"
          maxLength={100}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={confirming}
          placeholder={PLACEHOLDER[method] ?? "مرجع العملية"}
          style={{
            flex: 1, minWidth: 0, height: 32, boxSizing: "border-box",
            border: `1.5px solid ${confirmed ? C.success : empty ? C.amber : C.border}`,
            borderRadius: 7, background: C.muted, color: C.fg,
            fontFamily: "inherit", fontSize: 13, fontWeight: 700,
            padding: "0 8px", outline: "none", direction: "ltr", textAlign: "left",
          }}
        />
        <button
          type="button"
          disabled={empty || confirming || confirmed}
          onClick={onConfirm}
          style={{
            height: 32, padding: "0 10px", borderRadius: 7,
            border: `1.5px solid ${confirmed ? C.success : C.border}`,
            background: confirmed ? C.muted : empty || confirming ? C.muted : C.fg,
            color: confirmed ? C.success : empty || confirming ? C.mutedFg : C.muted,
            fontFamily: "inherit", fontSize: 11.5, fontWeight: 800,
            cursor: empty || confirming || confirmed ? "not-allowed" : "pointer",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 4, flexShrink: 0,
          }}
        >
          {confirming
            ? <><Loader2 aria-hidden size={14} className="animate-spin" /> تأكيد…</>
            : confirmed
              ? <><CheckCircle2 aria-hidden size={14} /> مؤكّد</>
              : <>تأكيد النجاح</>}
        </button>
      </div>
      {!confirmed && (
        <div role="alert" style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2, fontSize: 10.5, color: C.amber, fontWeight: 700, lineHeight: 1.3 }}>
          <AlertTriangle aria-hidden size={12} style={{ flexShrink: 0 }} />
          <span>{empty
            ? `أدخل رقم الإشعار أولاً — لا يكتمل بيع ${paymentMethodLabel(method)} من دونه.`
            : "تحقّق من نجاح العملية لدى المزوّد، ثم ثبّت التأكيد."}</span>
        </div>
      )}
    </div>
  );
}
