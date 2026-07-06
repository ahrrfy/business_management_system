import { PasswordInput } from "@/components/form/PasswordInput";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { translateLoginError } from "@/lib/loginErrors";
import { trpc } from "@/lib/trpc";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";

const LAST_COMPANY_CODE_KEY = "erp.lastCompanyCode";
const REMEMBER_KEY = "erp.rememberMe";

export default function Login() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [companyCode, setCompanyCode] = useState("");
  // «تذكّرني» = جلسة ٣٠ يوماً بدل ١٢ ساعة (الخادم يدعمها أصلاً — authRouter.login.remember).
  // الخيار نفسه يُتذكَّر محلياً كي لا يعيد المستخدم تفعيله كل مرّة.
  const [remember, setRemember] = useState(() => {
    try { return localStorage.getItem(REMEMBER_KEY) === "1"; } catch { return false; }
  });
  const [error, setError] = useState("");

  // مرحلة المصادقة الثنائية: بعد نجاح كلمة المرور لمستخدم مفعِّل 2FA يعيد الخادم تذكرة
  // قصيرة العمر (٥ دقائق) بدل الجلسة — تُحفظ في الذاكرة فقط (لا كوكي/localStorage).
  const [step, setStep] = useState<"credentials" | "otp">("credentials");
  const [ticket, setTicket] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");

  // نظام أحادي الشركة (لا CONTROL_DATABASE_URL على الخادم) ⇒ الحقل مخفيّ تماماً وشاشة
  // الدخول كما كانت قبل تعدد الشركات بلا أي فرق. لا يظهر إلا إذا فعّل المالك تعدد الشركات.
  const tenancyMode = trpc.auth.tenancyMode.useQuery();
  const multiTenant = tenancyMode.data?.multiTenant ?? false;

  // تذكّر آخر رمز شركة استُعمل بنجاح (تيسير الدخول المتكرّر لنفس الجهاز).
  useEffect(() => {
    if (multiTenant) {
      const saved = localStorage.getItem(LAST_COMPANY_CODE_KEY);
      if (saved) setCompanyCode(saved);
    }
  }, [multiTenant]);

  async function finishLogin(data: { mustChangePassword: boolean }) {
    if (multiTenant && companyCode.trim()) {
      localStorage.setItem(LAST_COMPANY_CODE_KEY, companyCode.trim());
    }
    // refetch (not invalidate): force-await the fresh session so the route
    // guard sees the authenticated user immediately, avoiding a redirect race.
    await utils.auth.me.refetch();
    // كلمة مرور مؤقتة تستوجب التغيير الفوري → وجّه لصفحة الحساب
    if (data.mustChangePassword) {
      navigate("/account?mustChange=1");
    } else {
      navigate("/");
    }
  }

  const login = trpc.auth.login.useMutation({
    onSuccess: async (data) => {
      if (data.requiresTwoFactor) {
        // كلمة المرور صحيحة و2FA مفعّلة ⇒ مرحلة الرمز.
        setTicket(data.ticket);
        setOtp("");
        setRecoveryCode("");
        setUseRecovery(false);
        setStep("otp");
        return;
      }
      await finishLogin(data);
    },
    onError: (e) => setError(translateLoginError(e.message)),
  });

  const verify2fa = trpc.auth.twoFactorVerify.useMutation({
    onSuccess: async (data) => {
      if (data.recoveryCodesRemaining != null && data.recoveryCodesRemaining <= 3) {
        // تنبيه غير حاجز — تظهر التفاصيل في «حسابي».
        console.warn(`رموز الاسترداد المتبقية: ${data.recoveryCodesRemaining}`);
      }
      await finishLogin(data);
    },
    onError: (e) => {
      setError(translateLoginError(e.message));
      setOtp("");
      // تذكرة منتهية ⇒ عودة تلقائية لمرحلة الاعتماد.
      if (e.message.includes("انتهت مهلة التحقق")) {
        setStep("credentials");
        setTicket(null);
      }
    },
  });

  function submitOtp(code?: string) {
    if (!ticket) return;
    setError("");
    if (useRecovery) {
      if (!recoveryCode.trim()) return;
      verify2fa.mutate({ ticket, recoveryCode: recoveryCode.trim() });
    } else {
      const c = (code ?? otp).trim();
      if (c.length !== 6) return;
      verify2fa.mutate({ ticket, code: c });
    }
  }

  function backToCredentials() {
    setStep("credentials");
    setTicket(null);
    setOtp("");
    setRecoveryCode("");
    setUseRecovery(false);
    setError("");
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-center text-xl">نظام إدارة الأعمال — الرؤية العربية</CardTitle>
        </CardHeader>
        <CardContent>
          {step === "credentials" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setError("");
              try { localStorage.setItem(REMEMBER_KEY, remember ? "1" : "0"); } catch { /* ignore */ }
              login.mutate({
                identifier: identifier.trim(),
                password,
                remember,
                ...(multiTenant ? { companyCode: companyCode.trim() } : {}),
              });
            }}
            className="space-y-4"
          >
            {multiTenant && (
              <div className="space-y-2">
                <Label htmlFor="companyCode">رمز الشركة</Label>
                <Input
                  id="companyCode"
                  type="text"
                  dir="ltr"
                  autoComplete="organization"
                  value={companyCode}
                  onChange={(e) => setCompanyCode(e.target.value)}
                  required
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="identifier">البريد الإلكتروني أو اسم المستخدم</Label>
              {/* name + autoComplete ⇒ متصفح الهاتف يعرض حفظ/تعبئة بيانات الدخول */}
              <Input id="identifier" name="username" type="text" dir="ltr" autoComplete="username" autoCapitalize="none" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">كلمة المرور</Label>
              <PasswordInput id="password" name="password" autoComplete="current-password" value={password} onChange={setPassword} required />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="remember"
                checked={remember}
                onCheckedChange={(v) => setRemember(v === true)}
              />
              <Label htmlFor="remember" className="text-sm font-normal cursor-pointer">
                تذكّرني على هذا الجهاز (٣٠ يوماً)
              </Label>
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={login.isPending}>
              {login.isPending ? "جارٍ الدخول…" : "دخول"}
            </Button>
          </form>
          ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitOtp();
            }}
            className="space-y-4"
          >
            <p className="text-sm text-muted-foreground text-center">
              {useRecovery
                ? "أدخل أحد رموز الاسترداد التي حفظتها عند تفعيل المصادقة الثنائية."
                : "أدخل الرمز من تطبيق المصادقة (Google Authenticator) على هاتفك."}
            </p>
            {useRecovery ? (
              <div className="space-y-2">
                <Label htmlFor="recoveryCode">رمز الاسترداد</Label>
                <Input
                  id="recoveryCode"
                  type="text"
                  dir="ltr"
                  autoComplete="one-time-code"
                  placeholder="XXXXX-XXXXX"
                  value={recoveryCode}
                  onChange={(e) => setRecoveryCode(e.target.value)}
                  autoFocus
                  required
                />
              </div>
            ) : (
              <div dir="ltr" className="flex justify-center">
                <InputOTP
                  maxLength={6}
                  pattern={REGEXP_ONLY_DIGITS}
                  inputMode="numeric"
                  autoFocus
                  value={otp}
                  onChange={setOtp}
                  onComplete={(v: string) => submitOtp(v)}
                  disabled={verify2fa.isPending}
                >
                  <InputOTPGroup>
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <InputOTPSlot key={i} index={i} className="h-11 w-10 text-lg" />
                    ))}
                  </InputOTPGroup>
                </InputOTP>
              </div>
            )}
            {error && <p role="alert" className="text-sm text-destructive text-center">{error}</p>}
            <Button type="submit" className="w-full" disabled={verify2fa.isPending}>
              {verify2fa.isPending ? "جارٍ التحقق…" : "تأكيد"}
            </Button>
            <div className="flex items-center justify-between text-sm">
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => { setUseRecovery((v) => !v); setError(""); }}
              >
                {useRecovery ? "استخدم رمز التطبيق" : "فقدت هاتفك؟ استخدم رمز استرداد"}
              </button>
              <button type="button" className="text-muted-foreground hover:underline" onClick={backToCredentials}>
                رجوع
              </button>
            </div>
          </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
