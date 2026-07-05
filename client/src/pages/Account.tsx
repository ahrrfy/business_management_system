import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PASSWORD_MIN_LEN, isStrongPassword } from "@shared/const";
import { trpc } from "@/lib/trpc";
import { confirm as confirmDialog } from "@/lib/confirm";
import { fmtDateTime } from "@/lib/date";
import { describeUserAgent } from "@/lib/userAgent";
import { useState } from "react";
import { useLocation } from "wouter";
import { AlertTriangle, Monitor, Bell, BellOff } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { notify } from "@/lib/notify";
import { isPushSupported, getPermissionState, subscribeToPush, unsubscribeFromPushBrowser } from "@/lib/push";
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

  const sessions = trpc.auth.mySessions.useQuery();
  const revokeOne = trpc.auth.revokeSession.useMutation({
    onSuccess: async () => { await utils.auth.mySessions.invalidate(); },
  });

  // إشعارات الدفع — للمدير/الأدمن حصراً (يطابق RBAC لوحة MorningBrief).
  const elevated = me.data?.role === "admin" || me.data?.role === "manager";
  const pushKey = trpc.push.publicKey.useQuery(undefined, { enabled: elevated });
  const pushStatus = trpc.push.myStatus.useQuery(undefined, { enabled: elevated });
  const pushSubscribeMut = trpc.push.subscribe.useMutation({
    onSuccess: async () => { await utils.push.myStatus.invalidate(); notify.ok("تمّ تفعيل إشعارات برنامج اليوم على هذا الجهاز"); },
    onError: (e) => notify.err(e.message || "تعذّر التفعيل"),
  });
  const pushUnsubMut = trpc.push.unsubscribe.useMutation({
    onSuccess: async () => { await utils.push.myStatus.invalidate(); notify.ok("تمّ إيقاف الإشعارات على هذا الجهاز"); },
    onError: (e) => notify.err(e.message || "تعذّر الإيقاف"),
  });
  const [pushBusy, setPushBusy] = useState(false);

  async function enablePush() {
    if (!pushKey.data?.enabled || !pushKey.data.publicKey) {
      notify.err("الإشعارات غير مُهيّأة على الخادم.");
      return;
    }
    setPushBusy(true);
    try {
      const sub = await subscribeToPush(pushKey.data.publicKey);
      await pushSubscribeMut.mutateAsync(sub);
    } catch (e) {
      notify.err(e instanceof Error ? e.message : "تعذّر التفعيل");
    } finally {
      setPushBusy(false);
    }
  }

  async function disablePush() {
    setPushBusy(true);
    try {
      const endpoint = await unsubscribeFromPushBrowser();
      if (endpoint) await pushUnsubMut.mutateAsync({ endpoint });
      else notify.ok("لا اشتراك نشط على هذا الجهاز");
    } catch (e) {
      notify.err(e instanceof Error ? e.message : "تعذّر الإيقاف");
    } finally {
      setPushBusy(false);
    }
  }

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
    <div className="space-y-4">
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
        <CardContent className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div><div className="text-muted-foreground text-xs">الاسم</div><div>{me.data?.name ?? "—"}</div></div>
          <div><div className="text-muted-foreground text-xs">البريد</div><div className="font-mono" dir="ltr">{me.data?.email ?? "—"}</div></div>
          <div><div className="text-muted-foreground text-xs">الدور</div><div>{me.data ? (ROLE_LABEL[me.data.role] ?? me.data.role) : "—"}</div></div>
        </CardContent>
      </Card>

      {/* إشعارات الدفع — للمدير/الأدمن حصراً، وحين يكون المتصفّح يدعم Push. */}
      {elevated && pushKey.data?.enabled && isPushSupported() && (
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Bell className="size-4" aria-hidden /> إشعارات برنامج اليوم</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              يصلك إشعار صباحي (07:00 بغداد) بأعداد المتابعات اليوم — تذكيرات ذمم + وعود مستحقّة + أوامر شغل متأخّرة. بلا أسماء عملاء (تظهر أعداد فقط في شريط الإشعارات).
            </p>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xs text-muted-foreground">
                {pushStatus.data
                  ? pushStatus.data.activeCount > 0
                    ? `مفعّل على ${pushStatus.data.activeCount} جهاز/متصفّح`
                    : "غير مفعّل على هذا الحساب"
                  : "…"}
              </span>
              <span className="text-xs text-muted-foreground">
                {getPermissionState() === "granted" ? "إذن الإشعارات: مُمنوح" :
                 getPermissionState() === "denied" ? "إذن الإشعارات: مرفوض (فعّله من إعدادات المتصفّح)" :
                 "إذن الإشعارات: لم يُطلَب بعد"}
              </span>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button size="sm" onClick={enablePush} disabled={pushBusy || getPermissionState() === "denied"} className="gap-1">
                <Bell className="size-3.5" aria-hidden />
                {pushBusy ? "جارٍ…" : "تفعيل على هذا الجهاز"}
              </Button>
              <Button size="sm" variant="outline" onClick={disablePush} disabled={pushBusy} className="gap-1">
                <BellOff className="size-3.5" aria-hidden />
                إيقاف على هذا الجهاز
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 items-start lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">تغيير كلمة المرور</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="old">كلمة المرور الحالية</Label>
                <Input id="old" type="password" dir="ltr" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="new">كلمة المرور الجديدة</Label>
                <Input id="new" type="password" dir="ltr" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="٨ أحرف على الأقل، حرف ورقم" />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="confirm">تأكيد كلمة المرور</Label>
                <Input id="confirm" type="password" dir="ltr" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </div>
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

      <Card>
        <CardHeader><CardTitle className="text-base">الجلسات النشطة</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            الأجهزة المسجَّل دخولها حالياً بحسابك. جلسات ما قبل آخر تسجيل خروج جماعي لا تظهر هنا.
          </p>
          {sessions.isLoading && <p className="text-sm text-muted-foreground">جارٍ التحميل…</p>}
          {!sessions.isLoading && (sessions.data?.length ?? 0) === 0 && (
            <p className="text-sm text-muted-foreground">لا جلسات مسجَّلة (ربما دخلتَ قبل تفعيل هذه الميزة).</p>
          )}
          <div className="space-y-2">
            {sessions.data?.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                <div className="flex items-start gap-3 min-w-0">
                  <Monitor aria-hidden className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="font-medium flex items-center gap-2">
                      {describeUserAgent(s.userAgent)}
                      {s.isCurrent && (
                        <span className="text-xs rounded-full bg-money-positive/15 text-money-positive px-2 py-0.5">هذا الجهاز</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground" dir="ltr">
                      {s.ipAddress ?? "—"} · آخر نشاط: {fmtDateTime(s.lastSeenAt)} · دخول: {fmtDateTime(s.createdAt)}
                    </div>
                  </div>
                </div>
                {!s.isCurrent && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={revokeOne.isPending}
                    onClick={async () => {
                      if (!(await confirmDialog({
                        variant: "danger",
                        title: "إنهاء هذه الجلسة",
                        description: "سيُسجَّل خروج هذا الجهاز فوراً. هل تتابع؟",
                        confirmText: "إنهاء الجلسة",
                      }))) return;
                      revokeOne.mutate({ sessionId: s.id });
                    }}
                  >
                    إنهاء
                  </Button>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
