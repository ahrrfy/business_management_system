// نافذة اعتماد المدير لبيعٍ يتجاوز سقف الائتمان/الخصم.
// استُخرج حرفياً من client/src/pages/POS.tsx (برنامج v2 «السهل الممتنع» م١ — PR-A) بلا تغيير
// سلوكيّ: الصفحةُ العملاقة (٣٧٨٣ سطراً) قُسِّمت مكوّنياً كي تنزل تحت خطّ أساس `check:page-size`
// ومقياس الاحتكاك D4، وتبقى كلّ الحالة المالية عند الأب (POS.tsx) وتصل عبر props.

import { AlertTriangle } from "lucide-react";
import { PasswordInput } from "@/components/form/PasswordInput";
import { useModalFocus } from "./useModalFocus";
import type { PosColors as C } from "./posShared";

export interface CreditApprovalDialogProps {
  C: C;
  message: string;
  mgrEmail: string; setMgrEmail: (s: string) => void;
  mgrPwd: string;   setMgrPwd:   (s: string) => void;
  isPending: boolean;
  onApprove: () => void;
  onCancel: () => void;
}

export function CreditApprovalDialog({ C, message, mgrEmail, setMgrEmail, mgrPwd, setMgrPwd, isPending, onApprove, onCancel }: CreditApprovalDialogProps) {
  const modalRef = useModalFocus<HTMLDivElement>();
  return (
    <div onClick={onCancel}
      style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgb(0 0 0/.45)", display: "flex", alignItems: "center", justifyContent: "center", direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif" }}>
      <div onClick={(e) => e.stopPropagation()} ref={modalRef} role="dialog" aria-modal="true" aria-label="موافقة مدير مطلوبة"
        style={{ background: C.card, borderRadius: 16, padding: "24px 28px", width: 380, boxShadow: "0 20px 56px rgb(0 0 0/.3)", animation: "popIn .2s ease" }}>
        <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 4, color: C.amber, display: "inline-flex", alignItems: "center", gap: 6 }}><AlertTriangle aria-hidden size={18} /> موافقة مدير مطلوبة</div>
        <div style={{ fontSize: 13, color: C.mutedFg, marginBottom: 18 }}>{message}</div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 13, fontWeight: 700, display: "block", marginBottom: 5, color: C.fg }}>بريد المدير</label>
          <input
            type="email" dir="ltr" value={mgrEmail} placeholder="manager@alroya.local"
            onChange={(e) => setMgrEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && mgrEmail && mgrPwd) onApprove(); }}
            style={{ width: "100%", height: 44, border: `1.5px solid ${C.border}`, borderRadius: 8, background: C.muted, color: C.fg, fontFamily: "inherit", fontSize: 14, padding: "0 12px", outline: "none", boxSizing: "border-box" }}
          />
        </div>
        {/* PasswordInput الموحّد (عين إظهار/إخفاء — نفس مكوّن شاشة الدخول) بدل input نصيّ عارٍ.
            Enter يعتمد ويُكمل — يُلتقط على الحاوية لأن المكوّن لا يكشف onKeyDown. */}
        <div style={{ marginBottom: 12 }} onKeyDown={(e) => { if (e.key === "Enter" && mgrEmail && mgrPwd) onApprove(); }}>
          <label style={{ fontSize: 13, fontWeight: 700, display: "block", marginBottom: 5, color: C.fg }}>كلمة المرور</label>
          <PasswordInput value={mgrPwd} onChange={setMgrPwd} autoComplete="current-password" />
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
          <button
            disabled={!mgrEmail || !mgrPwd || isPending}
            onClick={onApprove}
            style={{ flex: 1, height: 46, background: !mgrEmail || !mgrPwd || isPending ? C.muted : C.primary, color: !mgrEmail || !mgrPwd || isPending ? C.mutedFg : C.primaryFg, border: "none", borderRadius: 8, fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: !mgrEmail || !mgrPwd || isPending ? "not-allowed" : "pointer" }}>
            {isPending ? "جارٍ…" : "اعتمد وأكمل البيع"}
          </button>
          <button onClick={onCancel}
            style={{ height: 46, padding: "0 18px", background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 8, fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: "pointer", color: C.fg }}>
            إلغاء
          </button>
        </div>
      </div>
    </div>
  );
}
