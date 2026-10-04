import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ScanLine, KeyRound, Lock, AlertTriangle } from "lucide-react";
import type { ManagerApprovalInput } from "@shared/managerApproval";
export type { ManagerApprovalInput };

/** حوار اعتماد المدير (مسح باركود الشارة، رمز PIN السريع، أو كلمة المرور) — يُتحقَّق خادمياً عبر verifyManagerApproval.
 *  الافتراضيّ نصّ تجاوز الخصم (>١٠٪)؛ ويُعاد استعماله بعنوانٍ/وصفٍ مخصّصين لأيّ اعتماد
 *  مديريّ آخر (مثل ردّ العربون النقديّ عبر وردية) بتمرير title/description. */
export function ManagerApprovalDialog({
  pct,
  title,
  description,
  onApprove,
  onCancel,
  zIndexClass,
}: {
  pct?: number;
  title?: string;
  description?: string;
  onApprove: (approval: ManagerApprovalInput) => void;
  onCancel: () => void;
  zIndexClass?: string;
}) {
  const [tab, setTab] = useState<"BARCODE" | "PIN" | "PASSWORD">("BARCODE");
  const barcodeRef = useRef<HTMLInputElement>(null);
  const pinIdentRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);

  // Barcode
  const [barcode, setBarcode] = useState("");

  // PIN
  const [identifier, setIdentifier] = useState("");
  const [pin, setPin] = useState("");

  // Password
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const hasApprovedRef = useRef(false);

  const heading = title ?? `اعتماد مدير — خصم ${pct}٪`;
  const desc =
    description ??
    "العمليات الحساسة تتطلب موافقة المدير (مسح شارة الباركود، رمز PIN السريع، أو كلمة المرور).";

  useEffect(() => {
    hasApprovedRef.current = false;
    if (tab === "BARCODE") {
      setTimeout(() => barcodeRef.current?.focus(), 50);
    } else if (tab === "PIN") {
      setTimeout(() => pinIdentRef.current?.focus(), 50);
    }
  }, [tab]);

  function handleBarcodeSubmit() {
    if (hasApprovedRef.current) return;
    const cleanMatch = barcode.trim().match(/MGR-\d+-\d+/i);
    const code = cleanMatch ? cleanMatch[0].toUpperCase() : barcode.trim();
    if (!code) return;
    hasApprovedRef.current = true;
    onApprove({ barcode: code });
    setTimeout(() => { hasApprovedRef.current = false; }, 600);
  }

  function handlePinSubmit() {
    if (hasApprovedRef.current) return;
    const p = pin.trim();
    const ident = identifier.trim();
    if (!p || !ident) return;
    hasApprovedRef.current = true;
    onApprove({ pin: p, identifier: ident });
    setTimeout(() => { hasApprovedRef.current = false; }, 600);
  }

  function handlePasswordSubmit() {
    if (hasApprovedRef.current) return;
    const e = email.trim();
    if (!e || !password) return;
    hasApprovedRef.current = true;
    onApprove({ email: e, password });
    setTimeout(() => { hasApprovedRef.current = false; }, 600);
  }

  return (
    <div
      className={cn("fixed inset-0 grid place-items-center bg-black/50 p-4", zIndexClass ?? "z-[95]")}
      dir="rtl"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm space-y-3 rounded-2xl bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-amber-500/10 text-amber-600">
            <AlertTriangle className="size-4" aria-hidden />
          </div>
          <h3 className="text-sm font-extrabold">{heading}</h3>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">{desc}</p>

        {/* أزرار التبويب */}
        <div className="flex rounded-lg bg-muted p-1 text-xs gap-1" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "BARCODE"}
            onClick={() => setTab("BARCODE")}
            className={cn(
              "flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md font-bold transition-all",
              tab === "BARCODE" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <ScanLine className="size-3.5" aria-hidden />
            <span>مسح الشارة</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "PIN"}
            onClick={() => setTab("PIN")}
            className={cn(
              "flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md font-bold transition-all",
              tab === "PIN" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <KeyRound className="size-3.5" aria-hidden />
            <span>رمز PIN</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "PASSWORD"}
            onClick={() => setTab("PASSWORD")}
            className={cn(
              "flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md font-bold transition-all",
              tab === "PASSWORD" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Lock className="size-3.5" aria-hidden />
            <span>كلمة المرور</span>
          </button>
        </div>

        {/* محتوى التبويبات */}
        {tab === "BARCODE" && (
          <div className="space-y-2 pt-1">
            <label className="text-xs font-bold text-foreground">رمز شارة المدير</label>
            <Input
              ref={barcodeRef}
              value={barcode}
              onFocus={(e) => e.target.select()}
              onChange={(e) => {
                const val = e.target.value;
                setBarcode(val);
                hasApprovedRef.current = false;
                const match = val.trim().match(/MGR-\d+-\d+/i);
                if (match && !hasApprovedRef.current) {
                  hasApprovedRef.current = true;
                  onApprove({ barcode: match[0].toUpperCase() });
                  setTimeout(() => { hasApprovedRef.current = false; }, 600);
                }
              }}
              placeholder="امسح باركود الشارة هنا"
              dir="ltr"
              className="h-10 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter" && barcode.trim()) {
                  e.preventDefault();
                  handleBarcodeSubmit();
                }
              }}
            />
            <p className="text-[10px] text-muted-foreground">وجّه الماسح الضوئي إلى شارة المدير لاعتماد الطلب فوراً.</p>
          </div>
        )}

        {tab === "PIN" && (
          <div className="space-y-2 pt-1">
            <label className="text-xs font-bold text-foreground">اسم المستخدم أو البريد</label>
            <Input
              ref={pinIdentRef}
              value={identifier}
              onChange={(e) => {
                hasApprovedRef.current = false;
                setIdentifier(e.target.value);
              }}
              placeholder="اسم المستخدم أو البريد"
              dir="ltr"
              className="h-10 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (pin.trim()) {
                    handlePinSubmit();
                  } else {
                    pinRef.current?.focus();
                  }
                }
              }}
            />
            <label className="text-xs font-bold text-foreground">رمز PIN (4 - 8 أرقام)</label>
            <Input
              ref={pinRef}
              value={pin}
              type="password"
              inputMode="numeric"
              maxLength={8}
              onChange={(e) => {
                hasApprovedRef.current = false;
                setPin(e.target.value.replace(/\D/g, ""));
              }}
              placeholder="••••"
              dir="ltr"
              className="h-10 text-base tracking-widest"
              onKeyDown={(e) => {
                if (e.key === "Enter" && identifier.trim() && pin.trim()) {
                  e.preventDefault();
                  handlePinSubmit();
                }
              }}
            />
          </div>
        )}

        {tab === "PASSWORD" && (
          <div className="space-y-2 pt-1">
            <label className="text-xs font-bold text-foreground">بريد المدير</label>
            <Input
              value={email}
              onChange={(e) => {
                hasApprovedRef.current = false;
                setEmail(e.target.value);
              }}
              placeholder="manager@alroya.local"
              dir="ltr"
              className="h-10 text-sm"
              autoComplete="off"
            />
            <label className="text-xs font-bold text-foreground">كلمة المرور</label>
            <Input
              value={password}
              onChange={(e) => {
                hasApprovedRef.current = false;
                setPassword(e.target.value);
              }}
              type="password"
              placeholder="كلمة المرور"
              dir="ltr"
              className="h-10 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter" && email.trim() && password) {
                  e.preventDefault();
                  handlePasswordSubmit();
                }
              }}
            />
          </div>
        )}

        {/* الإجراءات */}
        <div className="flex gap-2 pt-2">
          <Button variant="outline" className="flex-1" onClick={onCancel}>
            إلغاء
          </Button>
          <Button
            className="flex-1"
            disabled={
              (tab === "BARCODE" && !barcode.trim()) ||
              (tab === "PIN" && (!identifier.trim() || !pin.trim())) ||
              (tab === "PASSWORD" && (!email.trim() || !password))
            }
            onClick={() => {
              if (tab === "BARCODE") handleBarcodeSubmit();
              else if (tab === "PIN") handlePinSubmit();
              else handlePasswordSubmit();
            }}
          >
            اعتماد
          </Button>
        </div>
      </div>
    </div>
  );
}
