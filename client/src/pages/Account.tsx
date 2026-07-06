import { PasswordInput } from "@/components/form/PasswordInput";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { PASSWORD_POLICY_MSG, isStrongPassword } from "@shared/const";
import { trpc } from "@/lib/trpc";
import { confirm as confirmDialog } from "@/lib/confirm";
import { fmtDateTime } from "@/lib/date";
import { qrCodeDataUrl } from "@/lib/printing/qr";
import { describeUserAgent } from "@/lib/userAgent";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { AlertTriangle, Copy, Monitor, Bell, BellOff, ShieldCheck, ShieldOff } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MyPerformanceCard } from "@/components/account/MyPerformanceCard";
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
    if (!isStrongPassword(newPassword)) return setError(PASSWORD_POLICY_MSG);
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

      {/* أدائي — ذاتي بحت (وحدة الأهداف والعمولات)؛ تختفي لمن لا موظف/خطة/هدف له. */}
      <MyPerformanceCard />

      {/* إشعارات الدفع — للمدير/الأدمن حصراً. gap-audit (بند medium مؤجَّل): البطاقة كانت تختفي
          صامتةً كلياً حين VAPID غير مضبوطة أو المتصفّح لا يدعم Push — الآن تظهر بحالة معطَّلة
          مُفسِّرة (المدير يعرف أن الميزة موجودة ولماذا لا تعمل بدل «أين ذهبت البطاقة؟»). */}
      {elevated && pushKey.data && (!pushKey.data.enabled || !isPushSupported()) && (
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><BellOff className="size-4" aria-hidden /> إشعارات برنامج اليوم</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {!pushKey.data.enabled
              ? "الإشعارات غير مفعَّلة على الخادم (مفاتيح VAPID غير مضبوطة في إعدادات التشغيل) — راجع مدير النظام لتفعيلها."
              : "متصفّحك الحالي لا يدعم إشعارات الدفع (Web Push) — جرّب متصفّحاً حديثاً أو ثبّت التطبيق على الشاشة الرئيسية."}
          </CardContent>
        </Card>
      )}
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
          <CardContent>
            {/* form حقيقي + autocomplete ⇒ مدير كلمات المرور في المتصفح يعرض تحديث الكلمة المحفوظة */}
            <form
              className="space-y-3"
              onSubmit={(e) => { e.preventDefault(); submit(); }}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="old">كلمة المرور الحالية</Label>
                  <PasswordInput id="old" name="current-password" autoComplete="current-password" value={oldPassword} onChange={setOldPassword} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new">كلمة المرور الجديدة</Label>
                  <PasswordInput id="new" name="new-password" autoComplete="new-password" value={newPassword} onChange={setNewPassword} />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="confirm">تأكيد كلمة المرور</Label>
                  <PasswordInput id="confirm" name="confirm-password" autoComplete="new-password" value={confirm} onChange={setConfirm} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{PASSWORD_POLICY_MSG}</p>

              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              {done && <p className="text-sm text-money-positive">{done}</p>}

              <Button type="submit" disabled={change.isPending}>
                {change.isPending ? "جارٍ التغيير…" : "تغيير كلمة المرور"}
              </Button>
            </form>
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

      <TwoFactorCard />

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

/**
 * بطاقة «المصادقة الثنائية» — تفعيل اختياري عبر Google Authenticator وأشباهه.
 * ثلاث خطوات: كلمة المرور ← مسح QR + تأكيد برمز ← حفظ رموز الاسترداد (تُعرَض مرّة واحدة).
 * الإدارة بعد التفعيل: إعادة توليد الرموز (برمز) / تعطيل (كلمة مرور + رمز).
 */
function TwoFactorCard() {
  const utils = trpc.useUtils();
  const status = trpc.auth.twoFactorStatus.useQuery();

  type Step = "idle" | "password" | "qr" | "codes" | "disable" | "regen";
  const [step, setStep] = useState<Step>("idle");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [secret, setSecret] = useState("");
  const [otpauthUri, setOtpauthUri] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [disableRecovery, setDisableRecovery] = useState("");
  const [useDisableRecovery, setUseDisableRecovery] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (otpauthUri) {
      qrCodeDataUrl(otpauthUri, { size: 220, margin: 1 })
        .then((url) => { if (!cancelled) setQrDataUrl(url); })
        .catch(() => { if (!cancelled) setQrDataUrl(""); });
    } else {
      setQrDataUrl("");
    }
    return () => { cancelled = true; };
  }, [otpauthUri]);

  function resetFlow() {
    setStep("idle");
    setPassword("");
    setOtp("");
    setSecret("");
    setOtpauthUri("");
    setRecoveryCodes([]);
    setDisableRecovery("");
    setUseDisableRecovery(false);
  }

  const setupStart = trpc.auth.twoFactorSetupStart.useMutation({
    onSuccess: (d) => {
      setSecret(d.secretB32);
      setOtpauthUri(d.otpauthUri);
      setPassword("");
      setOtp("");
      setStep("qr");
    },
    onError: (e) => notify.err(e.message),
  });
  const setupConfirm = trpc.auth.twoFactorSetupConfirm.useMutation({
    onSuccess: async (d) => {
      setRecoveryCodes(d.recoveryCodes);
      setStep("codes");
      await utils.auth.twoFactorStatus.invalidate();
      notify.ok("فُعِّلت المصادقة الثنائية — احفظ رموز الاسترداد الآن");
    },
    onError: (e) => { setOtp(""); notify.err(e.message); },
  });
  const disableMut = trpc.auth.twoFactorDisable.useMutation({
    onSuccess: async () => {
      resetFlow();
      await utils.auth.twoFactorStatus.invalidate();
      notify.ok("عُطِّلت المصادقة الثنائية");
    },
    onError: (e) => { setOtp(""); notify.err(e.message); },
  });
  const regenMut = trpc.auth.twoFactorRegenerateCodes.useMutation({
    onSuccess: async (d) => {
      setRecoveryCodes(d.recoveryCodes);
      setOtp("");
      setStep("codes");
      await utils.auth.twoFactorStatus.invalidate();
      notify.ok("وُلِّدت رموز استرداد جديدة — القديمة لم تعد صالحة");
    },
    onError: (e) => { setOtp(""); notify.err(e.message); },
  });

  async function copyText(text: string, okMsg: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify.ok(okMsg);
    } catch {
      notify.err("تعذّر النسخ — انسخ يدوياً");
    }
  }

  const enabled = status.data?.enabled ?? false;
  const cryptoReady = status.data?.cryptoReady ?? false;
  const busy = setupStart.isPending || setupConfirm.isPending || disableMut.isPending || regenMut.isPending;

  const otpSlots = (onComplete: (v: string) => void) => (
    <div dir="ltr" className="flex justify-center">
      <InputOTP
        maxLength={6}
        pattern={REGEXP_ONLY_DIGITS}
        inputMode="numeric"
        value={otp}
        onChange={setOtp}
        onComplete={onComplete}
        disabled={busy}
      >
        <InputOTPGroup>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <InputOTPSlot key={i} index={i} className="h-10 w-9" />
          ))}
        </InputOTPGroup>
      </InputOTP>
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="size-4" aria-hidden /> المصادقة الثنائية (2FA)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {status.isLoading ? (
          <p className="text-muted-foreground">جارٍ التحميل…</p>
        ) : enabled ? (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs rounded-full bg-money-positive/15 text-money-positive px-2 py-0.5">مفعّلة</span>
              {status.data?.enabledAt && (
                <span className="text-xs text-muted-foreground">منذ {fmtDateTime(status.data.enabledAt)}</span>
              )}
              <span className="text-xs text-muted-foreground">
                رموز الاسترداد المتبقية: {status.data?.recoveryCodesRemaining ?? 0}
              </span>
            </div>
            {(status.data?.recoveryCodesRemaining ?? 0) <= 3 && step !== "codes" && (
              <p className="text-xs text-[var(--stock-low)]">
                رموز الاسترداد المتبقية قليلة — أعد توليدها واحفظها في مكان آمن.
              </p>
            )}
            {step === "idle" && (
              <div className="flex gap-2 flex-wrap">
                <Button size="sm" variant="outline" onClick={() => { setOtp(""); setStep("regen"); }}>
                  إعادة توليد رموز الاسترداد
                </Button>
                <Button size="sm" variant="outline" className="text-destructive" onClick={() => { setPassword(""); setOtp(""); setDisableRecovery(""); setUseDisableRecovery(false); setStep("disable"); }}>
                  <ShieldOff className="size-3.5" aria-hidden /> تعطيل
                </Button>
              </div>
            )}
            {step === "regen" && (
              <div className="space-y-3 rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">أدخل الرمز الحالي من تطبيق المصادقة لتوليد ١٠ رموز استرداد جديدة (تُبطل القديمة كلها).</p>
                {otpSlots((v) => regenMut.mutate({ code: v }))}
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy || otp.length !== 6} onClick={() => regenMut.mutate({ code: otp })}>
                    {regenMut.isPending ? "جارٍ…" : "توليد"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={resetFlow}>إلغاء</Button>
                </div>
              </div>
            )}
            {step === "disable" && (
              <div className="space-y-3 rounded-lg border border-destructive/40 p-3">
                <p className="text-xs text-muted-foreground">
                  لتعطيل المصادقة الثنائية أدخل كلمة مرورك + {useDisableRecovery ? "رمز استرداد" : "الرمز من التطبيق"}.
                </p>
                <div className="space-y-1 max-w-xs">
                  <Label htmlFor="disable-pw">كلمة المرور</Label>
                  <PasswordInput id="disable-pw" autoComplete="current-password" value={password} onChange={setPassword} />
                </div>
                {useDisableRecovery ? (
                  <div className="space-y-1 max-w-xs">
                    <Label htmlFor="disable-rc">رمز الاسترداد</Label>
                    <Input id="disable-rc" dir="ltr" placeholder="XXXXX-XXXXX" value={disableRecovery} onChange={(e) => setDisableRecovery(e.target.value)} />
                  </div>
                ) : (
                  otpSlots(() => undefined)
                )}
                <button type="button" className="text-xs text-primary hover:underline" onClick={() => setUseDisableRecovery((v) => !v)}>
                  {useDisableRecovery ? "استخدم رمز التطبيق" : "فقدت هاتفك؟ استخدم رمز استرداد"}
                </button>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy || !password || (useDisableRecovery ? !disableRecovery.trim() : otp.length !== 6)}
                    onClick={() =>
                      disableMut.mutate(
                        useDisableRecovery
                          ? { password, recoveryCode: disableRecovery.trim() }
                          : { password, code: otp }
                      )
                    }
                  >
                    {disableMut.isPending ? "جارٍ…" : "تعطيل المصادقة الثنائية"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={resetFlow}>إلغاء</Button>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="text-muted-foreground">
              حماية إضافية لحسابك: عند الدخول يُطلب — إضافةً لكلمة المرور — رمزٌ متغيّر من تطبيق
              مصادقة على هاتفك (Google Authenticator أو ما يشبهه). التفعيل اختياري.
            </p>
            {!cryptoReady && (
              <p className="text-xs text-[var(--stock-low)]">
                غير متاحة حالياً: يتطلّب التفعيل ضبط مفتاح التشفير على الخادم — راجع مدير النظام.
              </p>
            )}
            {step === "idle" && (
              <Button size="sm" disabled={!cryptoReady} onClick={() => { setPassword(""); setStep("password"); }}>
                <ShieldCheck className="size-3.5" aria-hidden /> تفعيل المصادقة الثنائية
              </Button>
            )}
            {step === "password" && (
              <form
                className="space-y-3 rounded-lg border p-3 max-w-sm"
                onSubmit={(e) => { e.preventDefault(); if (password) setupStart.mutate({ password }); }}
              >
                <div className="space-y-1">
                  <Label htmlFor="tfa-pw">أكّد كلمة مرورك للمتابعة</Label>
                  <PasswordInput id="tfa-pw" autoComplete="current-password" value={password} onChange={setPassword} />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" type="submit" disabled={busy || !password}>
                    {setupStart.isPending ? "جارٍ…" : "متابعة"}
                  </Button>
                  <Button size="sm" variant="ghost" type="button" onClick={resetFlow}>إلغاء</Button>
                </div>
              </form>
            )}
            {step === "qr" && (
              <div className="space-y-3 rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">
                  ١) افتح تطبيق المصادقة على هاتفك واختر «إضافة حساب» ثم امسح هذا الرمز:
                </p>
                <div className="flex justify-center">
                  {qrDataUrl ? (
                    <img src={qrDataUrl} alt="رمز QR لإعداد المصادقة الثنائية" width={220} height={220} className="rounded-md border bg-white p-2" />
                  ) : (
                    <div className="h-[220px] w-[220px] animate-pulse rounded-md bg-muted" />
                  )}
                </div>
                <div className="flex items-center justify-center gap-2 text-xs">
                  <span className="text-muted-foreground">أو أدخل السرّ يدوياً:</span>
                  <code dir="ltr" className="rounded bg-muted px-2 py-0.5 font-mono select-all">{secret}</code>
                  <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => copyText(secret, "نُسخ السرّ")}>
                    <Copy className="size-3" aria-hidden />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">٢) أدخل الرمز الظاهر في التطبيق لتأكيد الربط:</p>
                {otpSlots((v) => setupConfirm.mutate({ code: v }))}
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy || otp.length !== 6} onClick={() => setupConfirm.mutate({ code: otp })}>
                    {setupConfirm.isPending ? "جارٍ…" : "تأكيد التفعيل"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={resetFlow}>إلغاء</Button>
                </div>
              </div>
            )}
          </>
        )}

        {step === "codes" && recoveryCodes.length > 0 && (
          <div className="space-y-3 rounded-lg border border-[var(--stock-low)] p-3">
            <p className="text-xs font-semibold">
              رموز الاسترداد — تُعرض مرّة واحدة فقط. احفظها في مكان آمن (كل رمز يُستخدم مرّة واحدة
              للدخول عند فقدان الهاتف، بلا رسائل نصية).
            </p>
            <div dir="ltr" className="grid grid-cols-2 gap-1 font-mono text-sm sm:grid-cols-5">
              {recoveryCodes.map((c) => (
                <code key={c} className="rounded bg-muted px-2 py-1 text-center select-all">{c}</code>
              ))}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => copyText(recoveryCodes.join("\n"), "نُسخت الرموز")}>
                <Copy className="size-3.5" aria-hidden /> نسخ الكل
              </Button>
              <Button size="sm" onClick={resetFlow}>تم — حفظتها</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
