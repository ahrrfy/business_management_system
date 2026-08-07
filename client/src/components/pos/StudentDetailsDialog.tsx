// إدخال بيع الاشتراك فقط: رقم الاشتراك + اسم الطالب + هاتفه.
// لا عقد ولا تاريخ انتهاء ولا ربط بمنصة أو ملف طالب؛ اللقطة تُحفظ مع الفاتورة حصراً.
import { notify } from "@/lib/notify";
import { GraduationCap, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type StudentSnapshot = {
  studentName: string;
  studentPhone: string;
};

export type SubscriptionSaleCapture = {
  providerReference: string;
  student: StudentSnapshot;
};

const C = {
  bg: "var(--pos-bg)", card: "var(--pos-card)", border: "var(--pos-border)",
  muted: "var(--pos-muted)", mutedFg: "var(--pos-muted-fg)", fg: "var(--pos-fg)",
  primary: "var(--pos-primary)", primaryFg: "var(--pos-primary-fg)", overlay: "var(--pos-overlay)",
} as const;

const fieldStyle: React.CSSProperties = {
  width: "100%", height: 48, padding: "0 12px", borderRadius: 10,
  border: `1.5px solid ${C.border}`, background: C.card, color: C.fg,
  fontSize: 16, fontFamily: "inherit", outline: "none", fontWeight: 700,
};

function iraqPhoneFromInput(value: string): string {
  const national = value
    .replace(/\D/g, "")
    .replace(/^00964/, "")
    .replace(/^964/, "")
    .replace(/^0+/, "")
    .slice(0, 10);
  return national ? `+964${national}` : "+964";
}

export function StudentDetailsDialog({
  open,
  cardName,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  cardName: string;
  onCancel: () => void;
  onConfirm: (capture: SubscriptionSaleCapture) => void;
}) {
  const [providerReference, setProviderReference] = useState("");
  const [studentName, setStudentName] = useState("");
  const [studentPhone, setStudentPhone] = useState("+964");
  const refInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const phoneInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setProviderReference("");
    setStudentName("");
    setStudentPhone("+964");
    setTimeout(() => refInput.current?.focus(), 40);
  }, [open]);

  function submit() {
    const reference = providerReference.trim().replace(/\s+/g, "");
    const name = studentName.trim();
    const phone = iraqPhoneFromInput(studentPhone);
    if (!reference) return notify.err("رقم الاشتراك أو ID مطلوب قبل الإضافة للسلة");
    if (!name) return notify.err("اسم الطالب مطلوب");
    if (phone.replace(/^\+964/, "").length !== 10) return notify.err("أدخل رقم هاتف الطالب العراقي كاملاً");
    onConfirm({ providerReference: reference, student: { studentName: name, studentPhone: phone } });
  }

  function next(e: React.KeyboardEvent<HTMLInputElement>, target?: React.RefObject<HTMLInputElement | null>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (target?.current) target.current.focus();
    else submit();
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="بيانات بيع الاشتراك"
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}
      style={{ position: "fixed", inset: 0, background: C.overlay, zIndex: 62, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
    >
      <div style={{ width: "min(520px, 100%)", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 14, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 16px", borderBottom: `1px solid ${C.border}`, background: C.card }}>
          <GraduationCap aria-hidden size={20} color={C.primary} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 900, fontSize: 16, color: C.fg }}>إضافة الاشتراك للسلة</div>
            <div style={{ fontSize: 12, color: C.mutedFg, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cardName}</div>
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={onCancel} aria-label="إغلاق" style={{ width: 40, height: 40, border: "none", background: "none", cursor: "pointer", color: C.mutedFg, display: "grid", placeItems: "center" }}>
            <X aria-hidden size={20} />
          </button>
        </div>

        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 13 }}>
          <p style={{ margin: 0, padding: 10, borderRadius: 9, background: C.muted, color: C.mutedFg, fontSize: 12.5, lineHeight: 1.6 }}>
            نحفظ هذه البيانات مع الفاتورة فقط. لا يوجد ربط أو تحقق من المنصة التعليمية.
          </p>
          <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 13, fontWeight: 800, color: C.fg }}>
            رقم الاشتراك أو ID
            <input ref={refInput} value={providerReference} maxLength={120} onChange={(e) => setProviderReference(e.target.value)} onKeyDown={(e) => next(e, nameInput)} placeholder="امسح الرقم أو اكتبه" dir="ltr" style={fieldStyle} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 13, fontWeight: 800, color: C.fg }}>
            اسم الطالب
            <input ref={nameInput} value={studentName} maxLength={200} onChange={(e) => setStudentName(e.target.value)} onKeyDown={(e) => next(e, phoneInput)} dir="auto" style={fieldStyle} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 13, fontWeight: 800, color: C.fg }}>
            رقم هاتف الطالب
            <input
              ref={phoneInput}
              value={studentPhone}
              onChange={(e) => setStudentPhone(iraqPhoneFromInput(e.target.value))}
              onKeyDown={(e) => next(e)}
              placeholder="+9647xxxxxxxxx"
              dir="ltr"
              inputMode="tel"
              maxLength={14}
              style={fieldStyle}
            />
          </label>
        </div>

        <div style={{ display: "flex", gap: 8, padding: 16, borderTop: `1px solid ${C.border}`, background: C.card }}>
          <button onClick={onCancel} style={{ flex: 1, height: 48, borderRadius: 10, border: `1.5px solid ${C.border}`, background: C.card, color: C.fg, fontFamily: "inherit", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>إلغاء</button>
          <button onClick={submit} style={{ flex: 2, height: 48, borderRadius: 10, border: "none", background: C.primary, color: C.primaryFg, fontFamily: "inherit", fontSize: 15, fontWeight: 900, cursor: "pointer" }}>حفظ وإضافة للسلة</button>
        </div>
      </div>
    </div>
  );
}
