// نافذة اعتماد المدير لبيعٍ يتجاوز سقف الائتمان/الخصم.
// تدعم ثلاثة مسارات:
//  1. مسح باركود شارة المدير (Scan)
//  2. إدخال رمز PIN السريع مع اسم المستخدم/البريد (PIN)
//  3. البريد وكلمة المرور الكلاسيكي (Password)

import { useState, useRef, useEffect } from "react";
import { AlertTriangle, ScanLine, KeyRound, Lock, CheckCircle2 } from "lucide-react";
import { PasswordInput } from "@/components/form/PasswordInput";
import { useModalFocus } from "./useModalFocus";
import type { PosColors as C } from "./posShared";
import type { ManagerApprovalInput } from "@shared/managerApproval";
import { trpc } from "@/lib/trpc";

export interface CreditApprovalDialogProps {
  C: C;
  message: string;
  mgrEmail?: string;
  setMgrEmail?: (s: string) => void;
  mgrPwd?: string;
  setMgrPwd?: (s: string) => void;
  isPending: boolean;
  onApprove: (approval?: ManagerApprovalInput) => void;
  onCancel: () => void;
  branchId?: number;
}

type TabType = "BARCODE" | "PIN" | "PASSWORD";

export function CreditApprovalDialog({
  C,
  message,
  mgrEmail: propEmail = "",
  setMgrEmail: propSetEmail,
  mgrPwd: propPwd = "",
  setMgrPwd: propSetPwd,
  isPending,
  onApprove,
  onCancel,
  branchId,
}: CreditApprovalDialogProps) {
  const modalRef = useModalFocus<HTMLDivElement>();
  const [activeTab, setActiveTab] = useState<TabType>("BARCODE");

  // State for Barcode
  const [barcode, setBarcode] = useState("");
  const barcodeInputRef = useRef<HTMLInputElement>(null);

  // State for PIN
  const [pinIdentifier, setPinIdentifier] = useState("");
  const [pinCode, setPinCode] = useState("");
  const pinIdentInputRef = useRef<HTMLInputElement>(null);
  const pinCodeInputRef = useRef<HTMLInputElement>(null);

  // State for Password
  const [localEmail, setLocalEmail] = useState(propEmail);
  const [localPwd, setLocalPwd] = useState(propPwd);

  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifiedManager, setVerifiedManager] = useState<{ id: number; name: string } | null>(null);
  const isSubmittingRef = useRef(false);

  const verifyMutation = trpc.sales.verifyManager.useMutation({
    onSuccess: (data) => {
      setVerifiedManager({ id: data.managerId, name: data.name });
      setVerifyError(null);
    },
    onError: (err) => {
      isSubmittingRef.current = false;
      setVerifyError(err.message);
      setVerifiedManager(null);
      barcodeInputRef.current?.select();
    },
  });

  // إعادة فتح إمكانية الإرسال تلقائياً بمجرد انتهاء حالة التعليق أو انتهاء الطلب
  useEffect(() => {
    if (!isPending && !verifyMutation.isPending) {
      isSubmittingRef.current = false;
    }
  }, [isPending, verifyMutation.isPending]);

  const setEmail = (val: string) => {
    isSubmittingRef.current = false;
    setLocalEmail(val);
    propSetEmail?.(val);
  };

  const setPwd = (val: string) => {
    isSubmittingRef.current = false;
    setLocalPwd(val);
    propSetPwd?.(val);
  };

  useEffect(() => {
    isSubmittingRef.current = false;
    if (activeTab === "BARCODE") {
      setTimeout(() => barcodeInputRef.current?.focus(), 50);
    } else if (activeTab === "PIN") {
      setTimeout(() => pinIdentInputRef.current?.focus(), 50);
    }
  }, [activeTab]);

  function submitApproval(approval: ManagerApprovalInput) {
    if (isSubmittingRef.current || isPending || verifyMutation.isPending) return;
    isSubmittingRef.current = true;
    setVerifyError(null);
    verifyMutation.mutate(
      { approval, branchId },
      {
        onSuccess: (data) => {
          setVerifiedManager({ id: data.managerId, name: data.name });
          onApprove(approval);
        },
        onError: (err) => {
          isSubmittingRef.current = false;
          setVerifyError(err.message);
          setVerifiedManager(null);
          barcodeInputRef.current?.select();
        },
      }
    );
  }

  function handleBarcodeSubmit() {
    if (isSubmittingRef.current) return;
    const cleanMatch = barcode.trim().match(/MGR-\d+-\d+/i);
    const code = cleanMatch ? cleanMatch[0].toUpperCase() : barcode.trim();
    if (!code) return;
    submitApproval({ barcode: code });
  }

  function handlePinSubmit() {
    if (isSubmittingRef.current) return;
    const p = pinCode.trim();
    const ident = pinIdentifier.trim();
    if (!p || !ident) return;
    submitApproval({ pin: p, identifier: ident });
  }

  function handlePasswordSubmit() {
    if (isSubmittingRef.current) return;
    const e = localEmail.trim();
    const p = localPwd;
    if (!e || !p) return;
    submitApproval({ email: e, password: p });
  }

  const busy = isPending || verifyMutation.isPending;

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgb(0 0 0/.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        direction: "rtl",
        fontFamily: "'Cairo', system-ui, sans-serif",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="موافقة مدير مطلوبة"
        style={{
          background: C.card,
          borderRadius: 16,
          padding: "24px 28px",
          width: 400,
          boxShadow: "0 20px 56px rgb(0 0 0/.3)",
          animation: "popIn .2s ease",
        }}
      >
        <div
          style={{
            fontWeight: 800,
            fontSize: 16,
            marginBottom: 4,
            color: C.amber,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <AlertTriangle aria-hidden size={18} /> موافقة مدير مطلوبة
        </div>
        <div style={{ fontSize: 13, color: C.mutedFg, marginBottom: 14 }}>{message}</div>

        {/* أشرطة التبويب */}
        <div
          role="tablist"
          style={{
            display: "flex",
            background: C.muted,
            borderRadius: 8,
            padding: 3,
            marginBottom: 16,
            gap: 3,
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "BARCODE"}
            onClick={() => { setActiveTab("BARCODE"); setVerifyError(null); }}
            style={{
              flex: 1,
              height: 36,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
              fontSize: 12,
              fontWeight: activeTab === "BARCODE" ? 800 : 600,
              borderRadius: 6,
              border: "none",
              cursor: "pointer",
              background: activeTab === "BARCODE" ? C.card : "transparent",
              color: activeTab === "BARCODE" ? C.fg : C.mutedFg,
              boxShadow: activeTab === "BARCODE" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
            }}
          >
            <ScanLine size={14} aria-hidden /> مسح الشارة
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "PIN"}
            onClick={() => { setActiveTab("PIN"); setVerifyError(null); }}
            style={{
              flex: 1,
              height: 36,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
              fontSize: 12,
              fontWeight: activeTab === "PIN" ? 800 : 600,
              borderRadius: 6,
              border: "none",
              cursor: "pointer",
              background: activeTab === "PIN" ? C.card : "transparent",
              color: activeTab === "PIN" ? C.fg : C.mutedFg,
              boxShadow: activeTab === "PIN" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
            }}
          >
            <KeyRound size={14} aria-hidden /> رمز PIN
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "PASSWORD"}
            onClick={() => { setActiveTab("PASSWORD"); setVerifyError(null); }}
            style={{
              flex: 1,
              height: 36,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
              fontSize: 12,
              fontWeight: activeTab === "PASSWORD" ? 800 : 600,
              borderRadius: 6,
              border: "none",
              cursor: "pointer",
              background: activeTab === "PASSWORD" ? C.card : "transparent",
              color: activeTab === "PASSWORD" ? C.fg : C.mutedFg,
              boxShadow: activeTab === "PASSWORD" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
            }}
          >
            <Lock size={14} aria-hidden /> كلمة المرور
          </button>
        </div>

        {/* عرض الخطأ إن وُجد */}
        {verifyError && (
          <div
            style={{
              background: C.dangerSoft,
              border: `1px solid ${C.danger}`,
              color: C.danger,
              padding: "8px 12px",
              borderRadius: 8,
              fontSize: 12,
              marginBottom: 12,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <AlertTriangle size={15} aria-hidden />
            <span>{verifyError}</span>
          </div>
        )}

        {/* رسالة نجاح التحقق المسبق */}
        {verifiedManager && (
          <div
            style={{
              background: "rgba(34, 197, 94, 0.1)",
              border: "1px solid rgb(34, 197, 94)",
              color: "rgb(22, 101, 52)",
              padding: "8px 12px",
              borderRadius: 8,
              fontSize: 12,
              marginBottom: 12,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <CheckCircle2 size={15} aria-hidden />
            <span>تم التحقق من المدير: {verifiedManager.name}</span>
          </div>
        )}

        {/* التبويب الأول: مسح الشارة */}
        {activeTab === "BARCODE" && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 700, display: "block", marginBottom: 5, color: C.fg }}>
              رمز باركود الشارة
            </label>
            <input
              ref={barcodeInputRef}
              type="text"
              dir="ltr"
              value={barcode}
              placeholder="امسح شارة المدير هنا أو اكتب الرمز"
              onFocus={(e) => e.target.select()}
              onChange={(e) => {
                const val = e.target.value;
                setBarcode(val);
                isSubmittingRef.current = false;
                const match = val.trim().match(/MGR-\d+-\d+/i);
                if (match && !isSubmittingRef.current) {
                  submitApproval({ barcode: match[0].toUpperCase() });
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && barcode.trim()) {
                  e.preventDefault();
                  handleBarcodeSubmit();
                }
              }}
              style={{
                width: "100%",
                height: 44,
                border: `1.5px solid ${C.border}`,
                borderRadius: 8,
                background: C.muted,
                color: C.fg,
                fontFamily: "inherit",
                fontSize: 14,
                padding: "0 12px",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            <div style={{ fontSize: 11, color: C.mutedFg, marginTop: 4 }}>
              وجّه الماسح الضوئي إلى شارة المدير لاعتماد البيع فوراً.
            </div>
          </div>
        )}

        {/* التبويب الثاني: رمز PIN */}
        {activeTab === "PIN" && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 13, fontWeight: 700, display: "block", marginBottom: 5, color: C.fg }}>
                اسم المستخدم أو البريد للمدير
              </label>
              <input
                ref={pinIdentInputRef}
                type="text"
                dir="ltr"
                value={pinIdentifier}
                placeholder="manager_username أو البريد"
                onChange={(e) => {
                  isSubmittingRef.current = false;
                  setPinIdentifier(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (pinCode.trim()) {
                      handlePinSubmit();
                    } else {
                      pinCodeInputRef.current?.focus();
                    }
                  }
                }}
                style={{
                  width: "100%",
                  height: 44,
                  border: `1.5px solid ${C.border}`,
                  borderRadius: 8,
                  background: C.muted,
                  color: C.fg,
                  fontFamily: "inherit",
                  fontSize: 14,
                  padding: "0 12px",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 700, display: "block", marginBottom: 5, color: C.fg }}>
                رمز PIN (4 - 8 أرقام)
              </label>
              <input
                ref={pinCodeInputRef}
                type="password"
                inputMode="numeric"
                dir="ltr"
                maxLength={8}
                value={pinCode}
                placeholder="••••"
                onChange={(e) => {
                  isSubmittingRef.current = false;
                  setPinCode(e.target.value.replace(/\D/g, ""));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && pinIdentifier.trim() && pinCode.trim()) {
                    e.preventDefault();
                    handlePinSubmit();
                  }
                }}
                style={{
                  width: "100%",
                  height: 44,
                  border: `1.5px solid ${C.border}`,
                  borderRadius: 8,
                  background: C.muted,
                  color: C.fg,
                  fontFamily: "inherit",
                  fontSize: 16,
                  padding: "0 12px",
                  outline: "none",
                  boxSizing: "border-box",
                  letterSpacing: 4,
                }}
              />
            </div>
          </div>
        )}

        {/* التبويب الثالث: كلمة المرور */}
        {activeTab === "PASSWORD" && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 13, fontWeight: 700, display: "block", marginBottom: 5, color: C.fg }}>
                بريد المدير
              </label>
              <input
                type="email"
                dir="ltr"
                value={localEmail}
                placeholder="manager@alroya.local"
                onChange={(e) => setEmail(e.target.value)}
                style={{
                  width: "100%",
                  height: 44,
                  border: `1.5px solid ${C.border}`,
                  borderRadius: 8,
                  background: C.muted,
                  color: C.fg,
                  fontFamily: "inherit",
                  fontSize: 14,
                  padding: "0 12px",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>
            <div onKeyDown={(e) => { if (e.key === "Enter" && localEmail && localPwd) handlePasswordSubmit(); }}>
              <label style={{ fontSize: 13, fontWeight: 700, display: "block", marginBottom: 5, color: C.fg }}>
                كلمة المرور
              </label>
              <PasswordInput value={localPwd} onChange={setPwd} autoComplete="current-password" />
            </div>
          </div>
        )}

        {/* الأزرار */}
        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <button
            disabled={
              busy ||
              (activeTab === "BARCODE" && !barcode.trim()) ||
              (activeTab === "PIN" && (!pinIdentifier.trim() || !pinCode.trim())) ||
              (activeTab === "PASSWORD" && (!localEmail.trim() || !localPwd))
            }
            onClick={() => {
              if (activeTab === "BARCODE") handleBarcodeSubmit();
              else if (activeTab === "PIN") handlePinSubmit();
              else handlePasswordSubmit();
            }}
            style={{
              flex: 1,
              height: 46,
              background:
                busy ||
                (activeTab === "BARCODE" && !barcode.trim()) ||
                (activeTab === "PIN" && (!pinIdentifier.trim() || !pinCode.trim())) ||
                (activeTab === "PASSWORD" && (!localEmail.trim() || !localPwd))
                  ? C.muted
                  : C.primary,
              color:
                busy ||
                (activeTab === "BARCODE" && !barcode.trim()) ||
                (activeTab === "PIN" && (!pinIdentifier.trim() || !pinCode.trim())) ||
                (activeTab === "PASSWORD" && (!localEmail.trim() || !localPwd))
                  ? C.mutedFg
                  : C.primaryFg,
              border: "none",
              borderRadius: 8,
              fontFamily: "inherit",
              fontSize: 14,
              fontWeight: 700,
              cursor:
                busy ||
                (activeTab === "BARCODE" && !barcode.trim()) ||
                (activeTab === "PIN" && (!pinIdentifier.trim() || !pinCode.trim())) ||
                (activeTab === "PASSWORD" && (!localEmail.trim() || !localPwd))
                  ? "not-allowed"
                  : "pointer",
            }}
          >
            {busy ? "جارٍ الاعتماد…" : "اعتمد وأكمل البيع"}
          </button>
          <button
            onClick={onCancel}
            style={{
              height: 46,
              padding: "0 18px",
              background: C.card,
              border: `1.5px solid ${C.border}`,
              borderRadius: 8,
              fontFamily: "inherit",
              fontSize: 14,
              fontWeight: 700,
              cursor: "pointer",
              color: C.fg,
            }}
          >
            إلغاء
          </button>
        </div>
      </div>
    </div>
  );
}
