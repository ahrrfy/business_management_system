import { PasswordInput } from "@/components/form/PasswordInput";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { notify } from "@/lib/notify";
import { qrCodeDataUrl } from "@/lib/printing/qr";
import { trpc } from "@/lib/trpc";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { Copy, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * شاشة إلزام تفعيل المصادقة الثنائية (قرار المالك ٢٣/٧): تُعرَض حاجبةً للأدمن/المدير الذي لم يُفعّل 2FA
 * (راية me.mustEnroll2FA). لا وصول للنظام حتى التفعيل. نفس تدفّق «حسابي»: كلمة المرور ← مسح QR + رمز ←
 * حفظ رموز الاسترداد. عند الانتهاء يُبطَل استعلام me فتُرفَع الراية ويُفتَح النظام. مخرجٌ آمن: «تسجيل الخروج».
 */
export function ForceTwoFactorEnroll() {
  const utils = trpc.useUtils();
  type Step = "password" | "qr" | "codes";
  const [step, setStep] = useState<Step>("password");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [secret, setSecret] = useState("");
  const [otpauthUri, setOtpauthUri] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

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

  const setupStart = trpc.auth.twoFactorSetupStart.useMutation({
    onSuccess: (d) => {
      setSecret(d.secretB32);
      setOtpauthUri(d.otpauthUri);
      setOtp("");
      setStep("qr");
    },
    onError: (e) => notify.err(e.message),
  });
  const setupConfirm = trpc.auth.twoFactorSetupConfirm.useMutation({
    onSuccess: (d) => {
      setRecoveryCodes(d.recoveryCodes);
      setStep("codes");
      notify.ok("فُعِّلت المصادقة الثنائية — احفظ رموز الاسترداد الآن");
    },
    onError: (e) => { setOtp(""); notify.err(e.message); },
  });
  const logout = trpc.auth.logout.useMutation({
    onSuccess: () => { window.location.href = "/login"; },
    onError: () => { window.location.href = "/login"; },
  });

  const busy = setupStart.isPending || setupConfirm.isPending;

  async function copyText(text: string, okMsg: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify.ok(okMsg);
    } catch {
      notify.err("تعذّر النسخ — انسخ يدوياً");
    }
  }

  async function finish() {
    // إبطال me ⇒ mustEnroll2FA=false ⇒ يُرفع الحجب ويُعرَض النظام.
    await utils.auth.me.invalidate();
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="size-4" aria-hidden /> تفعيل المصادقة الثنائية مطلوب
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            حسابك يتطلّب تفعيل المصادقة الثنائية (2FA) لحماية إضافية قبل استعمال النظام. أكمِل الخطوات للمتابعة.
          </p>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {step === "password" && (
            <form
              onSubmit={(e) => { e.preventDefault(); if (password) setupStart.mutate({ password }); }}
              className="space-y-3"
            >
              <div>
                <label className="block text-xs text-muted-foreground mb-1">كلمة المرور الحالية</label>
                <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" disabled={busy} />
              </div>
              <Button type="submit" className="w-full" disabled={busy || !password}>متابعة</Button>
            </form>
          )}

          {step === "qr" && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">امسح الرمز بتطبيق مصادقة (Google Authenticator مثلاً)، ثم أدخِل الرمز المكوّن من ٦ أرقام.</p>
              {qrDataUrl && (
                <div className="flex justify-center">
                  <img src={qrDataUrl} alt="رمز QR للمصادقة الثنائية" className="rounded border" width={220} height={220} />
                </div>
              )}
              <div className="flex items-center justify-center gap-2 text-xs">
                <span className="text-muted-foreground">أو أدخِل المفتاح يدوياً:</span>
                <code dir="ltr" className="rounded bg-muted px-2 py-0.5 tabular-nums">{secret}</code>
                <Button type="button" size="icon" variant="ghost" className="size-6" onClick={() => copyText(secret, "نُسِخ المفتاح")}>
                  <Copy className="size-3" aria-hidden />
                </Button>
              </div>
              <div dir="ltr" className="flex justify-center">
                <InputOTP
                  maxLength={6}
                  pattern={REGEXP_ONLY_DIGITS}
                  inputMode="numeric"
                  value={otp}
                  onChange={setOtp}
                  onComplete={(v) => setupConfirm.mutate({ code: v })}
                  disabled={busy}
                >
                  <InputOTPGroup>
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <InputOTPSlot key={i} index={i} className="h-10 w-9" />
                    ))}
                  </InputOTPGroup>
                </InputOTP>
              </div>
              <Button type="button" className="w-full" disabled={busy || otp.length !== 6} onClick={() => setupConfirm.mutate({ code: otp })}>
                تأكيد وتفعيل
              </Button>
            </div>
          )}

          {step === "codes" && (
            <div className="space-y-3">
              <p className="text-xs text-money-positive">فُعِّلت المصادقة الثنائية. احفظ رموز الاسترداد التالية في مكانٍ آمن — تُعرَض مرّة واحدة فقط.</p>
              <div className="grid grid-cols-2 gap-1.5 rounded border p-2" dir="ltr">
                {recoveryCodes.map((c) => (
                  <code key={c} className="tabular-nums text-center text-sm">{c}</code>
                ))}
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" className="flex-1 gap-1" onClick={() => copyText(recoveryCodes.join("\n"), "نُسِخت رموز الاسترداد")}>
                  <Copy className="size-3" aria-hidden /> نسخ الرموز
                </Button>
                <Button type="button" className="flex-1" onClick={finish}>حفظتُ الرموز — دخول النظام</Button>
              </div>
            </div>
          )}

          <div className="border-t pt-3 text-center">
            <button type="button" className="text-xs text-muted-foreground underline" onClick={() => logout.mutate()} disabled={logout.isPending}>
              تسجيل الخروج
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
