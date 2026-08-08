import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** حوار اعتماد المدير (بريد + كلمة مرور) — يُتحقَّق خادمياً عبر verifyManagerApproval.
 *  الافتراضيّ نصّ تجاوز الخصم (>١٠٪)؛ ويُعاد استعماله بعنوانٍ/وصفٍ مخصّصين لأيّ اعتماد
 *  مديريّ آخر (مثل ردّ العربون النقديّ عبر وردية) بتمرير title/description. */
export function ManagerApprovalDialog({ pct, title, description, onApprove, onCancel }: {
  pct?: number;
  title?: string;
  description?: string;
  onApprove: (email: string, password: string) => void;
  onCancel: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const heading = title ?? `اعتماد مدير — خصم ${pct}٪`;
  const desc =
    description ??
    "الخصم فوق ١٠٪ يحتاج مديراً (تُفحص البيانات على الخادم لحظة إتمام الطلب وتُسجَّل باسمه).";
  return (
    <div className="fixed inset-0 z-[95] grid place-items-center bg-black/50 p-4" dir="rtl" onClick={onCancel}>
      <div className="w-full max-w-xs space-y-3 rounded-2xl bg-card p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-extrabold">{heading}</h3>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {desc}
        </p>
        <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="بريد المدير" dir="ltr" className="h-10 text-sm" autoComplete="off" />
        <Input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="كلمة المرور" dir="ltr" className="h-10 text-sm" autoComplete="new-password" />
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onCancel}>إلغاء</Button>
          <Button className="flex-1" disabled={!email.trim() || !password} onClick={() => onApprove(email.trim(), password)}>
            اعتماد
          </Button>
        </div>
      </div>
    </div>
  );
}
