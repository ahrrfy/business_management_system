import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PASSWORD_MIN_LEN, isStrongPassword } from "@shared/const";
import { trpc } from "@/lib/trpc";
import { confirm as confirmDialog } from "@/lib/confirm";
import { useState } from "react";
import { useLocation } from "wouter";
import { AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ROLE_LABEL } from "./Users";

export default function Account() {
  const [location, navigate] = useLocation();
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  // هل أُحيل المستخدم لهنا بسبب كلمة مرور مؤقتة تستوجب التغيير؟
  const mustChange = new URLSearchParams(location.split("?")[1] ?? "").get("mustChange") === "1"
    || !!(me.data as any)?.mustChangePassword;

  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const change = trpc.auth.changePassword.useMutation({
    onSuccess: async () => {
      setDone("تمّ تغيير كلمة المرور بنجاح.");
      setOldPassword(""); setNewPassword(""); setConfirm("");
      await utils.auth.me.refetch();
      // بعد تغيير كلمة المرور المؤقتة نوجّه للوحة الرئيسية
      if (mustChange) navigate("/");
    },
    onError: (e) => setError(e.message),
  });

  const revoke = trpc.auth.revokeMySessions.useMutation({
    onSuccess: async () => { await utils.auth.me.invalidate(); navigate("/login"); },
  });

  function submit() {
    setError(""); setDone("");
    if (!oldPassword) return setError("أدخل كلمة المرور الحالية.");
    if (!isStrongPassword(newPassword))
      return setError(`كلمة المرور الجديدة يجب أن تكون ${PASSWORD_MIN_LEN} أحرف على الأقل وتحتوي حرفاً ورقماً.`);
    if (newPassword !== confirm) return setError("تأكيد كلمة المرور لا يطابق.");
    if (newPassword === oldPassword) return setError("كلمة المرور الجديدة يجب أن تختلف عن الحالية.");
    change.mutate({ oldPassword, newPassword });
  }

  return (
    <div className="space-y-4 max-w-xl">
      <PageHeader title="حسابي" />

      {mustChange && (
        <div className="rounded-lg border border-[var(--stock-low)] badge-stock-low p-4 text-sm flex gap-3 items-start">
          <AlertTriangle aria-hidden className="size-5 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold mb-1">كلمة المرور مؤقتة — يجب تغييرها الآن</p>
            <p className="text-xs opacity-80">أُنشئ حسابك بكلمة مرور مؤقتة. غيّرها أدناه قبل استخدام النظام.</p>
          </div>
        </div>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">بيانات الحساب</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 text-sm">
          <div><div className="text-muted-foreground text-xs">الاسم</div><div>{me.data?.name ?? "—"}</div></div>
          <div><div className="text-muted-foreground text-xs">البريد</div><div className="font-mono" dir="ltr">{me.data?.email ?? "—"}</div></div>
          <div><div className="text-muted-foreground text-xs">الدور</div><div>{me.data ? (ROLE_LABEL[me.data.role] ?? me.data.role) : "—"}</div></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">تغيير كلمة المرور</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="old">كلمة المرور الحالية</Label>
            <Input id="old" type="password" dir="ltr" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new">كلمة المرور الجديدة</Label>
            <Input id="new" type="password" dir="ltr" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="٨ أحرف على الأقل، حرف ورقم" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="confirm">تأكيد كلمة المرور</Label>
            <Input id="confirm" type="password" dir="ltr" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {done && <p className="text-sm text-money-positive">{done}</p>}

          <Button onClick={submit} disabled={change.isPending}>
            {change.isPending ? "جارٍ التغيير…" : "تغيير كلمة المرور"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">الأمان</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            إنهاء كل الجلسات النشطة على جميع الأجهزة. ستحتاج لتسجيل الدخول من جديد.
          </p>
          <Button variant="outline" onClick={async () => { if (!(await confirmDialog({ variant: "danger", title: "إنهاء كل الجلسات", description: "سيُسجَّل خروجك من كل الأجهزة فوراً وتحتاج للدخول من جديد. اكتب «إنهاء» للتأكيد.", confirmText: "إنهاء الجلسات", requireText: "إنهاء" }))) return; revoke.mutate(); }} disabled={revoke.isPending}>
            {revoke.isPending ? "…" : "تسجيل الخروج من كل الأجهزة"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
