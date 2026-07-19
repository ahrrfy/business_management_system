// قسم «تسليم نقد للخزينة» داخل نافذة إغلاق الوردية (treasury-stage2 — الواجهة).
// مصدر حقيقة واحد يُشارَك بين الأوضاع الثلاثة (POS/PrintPOS/Reception): تسليمُ نقدٍ من درج
// الوردية إلى الخزينة الإدارية بيد مديرٍ/إداريٍّ مستلِم (يطابق تحقّق cashHandoverService:
// المستلِم admin/manager نشط، المبلغ موجب). القسم اختياريّ؛ لا يُرسَل handover إلا إذا اكتمل
// (مبلغ موجب + مستلِم) — و handoverIncomplete يمنع الإغلاق عند مبلغٍ بلا مستلِم كي لا يُسقَط صامتاً.
import { useId } from "react";
import { D, round2 } from "@/lib/money";

/** الحدّ الأدنى من رموز ألوان الكاشير التي يحتاجها القسم (متوافق بنيوياً مع POS_COLORS/LIGHT). */
export interface PosTokens {
  card: string;
  border: string;
  muted: string;
  mutedFg: string;
  fg: string;
  primary: string;
  danger: string;
}

export interface HandoverRecipient {
  id: number;
  name: string;
}

export interface ShiftHandoverValue {
  amount: string;
  handoverTo: number | null;
  notes: string;
}

export const emptyHandover: ShiftHandoverValue = { amount: "", handoverTo: null, notes: "" };

/** مبلغٌ موجب أُدخِل بلا اختيار مستلِم ⇒ التسليم ناقص (يُحظر الإغلاق حتى لا يُسقَط صامتاً). */
export function handoverIncomplete(v: ShiftHandoverValue): boolean {
  return D(v.amount || 0).gt(0) && !v.handoverTo;
}

/** حمولة handover لـshifts.close، أو undefined إن لم يُدخَل تسليمٌ مكتمِل. */
export function buildHandoverPayload(
  v: ShiftHandoverValue,
): { amount: string; handoverTo: number; notes?: string } | undefined {
  const amt = D(v.amount || 0);
  if (!amt.gt(0) || !v.handoverTo) return undefined;
  const notes = v.notes.trim();
  return { amount: round2(amt).toFixed(2), handoverTo: v.handoverTo, notes: notes || undefined };
}

export function ShiftHandoverSection({
  C,
  recipients,
  value,
  onChange,
  disabled,
  loading,
}: {
  C: PosTokens;
  recipients: HandoverRecipient[];
  value: ShiftHandoverValue;
  onChange: (v: ShiftHandoverValue) => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  const amtId = useId();
  const selId = useId();
  const notesId = useId();
  const needsRecipient = handoverIncomplete(value);

  const fieldBase: React.CSSProperties = {
    width: "100%",
    border: `1.5px solid ${C.border}`,
    borderRadius: 8,
    background: C.card,
    color: C.fg,
    fontFamily: "inherit",
    padding: "0 12px",
    outline: "none",
    boxSizing: "border-box",
  };

  return (
    <div style={{ marginTop: 14, padding: "12px 14px", background: C.muted, border: `1px solid ${C.border}`, borderRadius: 10 }}>
      <div style={{ fontSize: 12.5, fontWeight: 800, color: C.fg, marginBottom: 8 }}>تسليم نقد للخزينة (اختياري)</div>
      <div style={{ display: "grid", gap: 8 }}>
        <div>
          <label htmlFor={amtId} style={{ fontSize: 12, color: C.mutedFg, display: "block", marginBottom: 4 }}>المبلغ المُسلَّم (د.ع)</label>
          <input
            id={amtId}
            value={value.amount}
            onChange={(e) => onChange({ ...value, amount: e.target.value.replace(/[^\d.]/g, "") })}
            dir="ltr"
            inputMode="decimal"
            placeholder="0"
            disabled={disabled}
            style={{ ...fieldBase, height: 40, fontSize: 15, fontWeight: 700, textAlign: "right" }}
          />
        </div>
        <div>
          <label htmlFor={selId} style={{ fontSize: 12, color: C.mutedFg, display: "block", marginBottom: 4 }}>المستلِم (مدير/إداري)</label>
          <select
            id={selId}
            value={value.handoverTo ?? ""}
            disabled={disabled || loading}
            onChange={(e) => onChange({ ...value, handoverTo: e.target.value ? Number(e.target.value) : null })}
            style={{ ...fieldBase, height: 40, fontSize: 14, borderColor: needsRecipient ? C.danger : C.border }}
          >
            <option value="">{loading ? "جارٍ التحميل…" : "— اختر المستلِم —"}</option>
            {recipients.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          {needsRecipient && <div style={{ fontSize: 11.5, color: C.danger, marginTop: 3 }}>اختر المستلِم لتسجيل التسليم.</div>}
        </div>
        <div>
          <label htmlFor={notesId} style={{ fontSize: 12, color: C.mutedFg, display: "block", marginBottom: 4 }}>ملاحظة (اختياري)</label>
          <input
            id={notesId}
            value={value.notes}
            onChange={(e) => onChange({ ...value, notes: e.target.value })}
            disabled={disabled}
            maxLength={500}
            style={{ ...fieldBase, height: 36, fontSize: 13 }}
          />
        </div>
      </div>
    </div>
  );
}
