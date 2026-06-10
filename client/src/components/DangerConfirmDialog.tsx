import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEffect, useState } from "react";

/**
 * حوار تأكيد للعمليات المدمّرة (استعادة/تصفير). حماية قصوى:
 *  - كتابة رمز تأكيد يطابق اسم القاعدة بالضبط.
 *  - إعادة إدخال كلمة مرور المدير.
 *  - تحذيرات صريحة + تنبيه أن نسخة أمان تلقائية ستؤخذ أولاً.
 *  - مفتاح اختياري لإعادة البذرة (للتصفير).
 */
export function DangerConfirmDialog(props: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  /** رمز التأكيد المطلوب (اسم القاعدة). */
  confirmToken: string;
  /** نقاط تحذير تُعرض كقائمة. */
  warnings?: string[];
  actionLabel: string;
  pending?: boolean;
  showSeedToggle?: boolean;
  onConfirm: (args: { password: string; seed: boolean; confirm: string }) => void;
}) {
  const { open, onOpenChange, title, description, confirmToken, warnings, actionLabel, pending, showSeedToggle, onConfirm } = props;
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [seed, setSeed] = useState(false);

  // تصفير الحقول عند كل فتح/إغلاق.
  useEffect(() => {
    if (!open) { setTyped(""); setPassword(""); setSeed(false); }
  }, [open]);

  const tokenOk = typed.trim() === confirmToken && confirmToken.length > 0;
  const canConfirm = tokenOk && password.length > 0 && !pending;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!pending) onOpenChange(o); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-destructive">⚠ {title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {warnings && warnings.length > 0 && (
            <ul className="text-xs text-destructive list-disc ps-5 space-y-1">
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            🛡 ستُؤخذ نسخة احتياطية تلقائية للحالة الراهنة قبل التنفيذ (تتوقّف العملية إن فشلت النسخة).
          </p>

          <div className="space-y-1">
            <Label htmlFor="dc-token">اكتب اسم القاعدة للتأكيد: <code dir="ltr" className="font-mono text-foreground">{confirmToken}</code></Label>
            <Input id="dc-token" dir="ltr" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={confirmToken} autoComplete="off" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dc-pwd">كلمة مرور المدير</Label>
            <Input id="dc-pwd" type="password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          </div>
          {showSeedToggle && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={seed} onChange={(e) => setSeed(e.target.checked)} />
              إعادة بيانات العيّنة بعد التصفير (admin + فروع + منتجات عيّنة)
            </label>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>إلغاء</Button>
          <Button variant="destructive" onClick={() => onConfirm({ password, seed, confirm: typed.trim() })} disabled={!canConfirm}>
            {pending ? "جارٍ التنفيذ…" : actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
