import { PasswordInput } from "@/components/form/PasswordInput";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { translateLoginError } from "@/lib/loginErrors";
import { saveOfflineProfile } from "@/lib/offline/pinLock";
import { studioOfflineProfileInput } from "@/lib/productStudio/coldOfflinePolicy";
import { saveStudioDraftIdentity } from "@/lib/productStudio/studioDrafts";
import { resetSessionForLogin } from "@/lib/offline/sessionBoundary";
import { trpc } from "@/lib/trpc";
import { useQueryClient } from "@tanstack/react-query";
import { INTERNAL_ORIGIN, isPublicHost } from "@/lib/siteHosts";
import { useEffect, useState, useMemo, Suspense, lazy } from "react";

const TwoFactorForm = lazy(() => import("@/components/auth/TwoFactorForm"));
const LoginShowcase = lazy(() => import("@/components/auth/LoginShowcase"));
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  ShieldCheck,
  Building2,
  Lock,
  User,
  KeyRound,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  FileCheck2,
  Fingerprint,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

const LAST_COMPANY_CODE_KEY = "erp.lastCompanyCode";
const REMEMBER_KEY = "erp.rememberMe";
const SAVED_IDENTIFIER_KEY = "erp.savedIdentifier";

export default function Login() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  const [identifier, setIdentifier] = useState(() => {
    try {
      if (localStorage.getItem(REMEMBER_KEY) === "1") {
        return localStorage.getItem(SAVED_IDENTIFIER_KEY) || "";
      }
    } catch {
      // ignore
    }
    return "";
  });
  const [password, setPassword] = useState("");
  const [companyCode, setCompanyCode] = useState("");
  const [remember, setRemember] = useState(() => {
    try {
      return localStorage.getItem(REMEMBER_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [error, setError] = useState("");
  const [capsLockActive, setCapsLockActive] = useState(false);
  const [baghdadTime, setBaghdadTime] = useState("");
  const [mouseCoord, setMouseCoord] = useState({ x: 0, y: 0 });

  // تحية ترحيبية إنسانية مخصصة حسب توقيت بغداد
  const greeting = useMemo(() => {
    try {
      const now = new Date();
      const hour = parseInt(
        now.toLocaleTimeString("en-US", { timeZone: "Asia/Baghdad", hour: "numeric", hour12: false }),
        10
      );
      if (hour >= 5 && hour < 12) return "صباح الخير والبركة";
      if (hour >= 12 && hour < 17) return "طاب يومكم بكل خير";
      if (hour >= 17 && hour < 24) return "مساء الخير والمسرة";
      return "أهلاً وسهلاً بكم في منظومة الرؤية";
    } catch {
      return "أهلاً وسهلاً بكم في منظومة الرؤية";
    }
  }, []);

  // تحديث توقيت بغداد الحي كل ثانية لإضفاء نبض حقيقي للمنظومة
  useEffect(() => {
    const updateTime = () => {
      try {
        const now = new Date();
        setBaghdadTime(
          now.toLocaleTimeString("ar-IQ", {
            timeZone: "Asia/Baghdad",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            numberingSystem: "latn",
          })
        );
      } catch {
        // ignore
      }
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);
    return () => clearInterval(timer);
  }, []);

  const [step, setStep] = useState<"credentials" | "otp" | "reset">("credentials");
  const [ticket, setTicket] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [resetDone, setResetDone] = useState(false);

  const tenancyMode = trpc.auth.tenancyMode.useQuery();
  const multiTenant = tenancyMode.data?.multiTenant ?? false;

  useEffect(() => {
    if (multiTenant) {
      const saved = localStorage.getItem(LAST_COMPANY_CODE_KEY);
      if (saved) setCompanyCode(saved);
    }
  }, [multiTenant]);

  // رصد زر Caps Lock لتنبيه المستخدم وتفادي أخطاء الإدخال غير المقصودة
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (typeof e.getModifierState === "function") {
        setCapsLockActive(e.getModifierState("CapsLock"));
      }
    };
    window.addEventListener("keydown", handleKey);
    window.addEventListener("keyup", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("keyup", handleKey);
    };
  }, []);

  // تتبع حركة الفأرة لإضفاء عمق بارالاكس ثلاثي الأبعاد وتفاعل حي للقمرة
  const handleMouseMove = (e: React.MouseEvent) => {
    if (typeof window === "undefined") return;
    const x = (e.clientX / window.innerWidth) * 2 - 1;
    const y = (e.clientY / window.innerHeight) * 2 - 1;
    setMouseCoord({ x, y });
  };

  async function finishLogin(data: { mustChangePassword: boolean }) {
    if (multiTenant && companyCode.trim()) {
      localStorage.setItem(LAST_COMPANY_CODE_KEY, companyCode.trim());
    }
    const freshMe = await utils.client.auth.me.query();
    if (freshMe?.id) {
      await resetSessionForLogin(queryClient, Number(freshMe.id));
    }
    utils.auth.me.setData(undefined, freshMe);
    if (freshMe?.id && (typeof navigator === "undefined" || navigator.onLine)) {
      await saveStudioDraftIdentity(Number(freshMe.id)).catch(() => undefined);
      await saveOfflineProfile(studioOfflineProfileInput(freshMe)).catch(() => undefined);
    }
    const role = freshMe?.role;
    if (
      role !== "courier" &&
      typeof window !== "undefined" &&
      isPublicHost(window.location.hostname)
    ) {
      window.location.replace(`${INTERNAL_ORIGIN}/login`);
      return;
    }
    if (data.mustChangePassword) {
      navigate("/account?mustChange=1");
    } else if (role === "courier") {
      navigate("/my-deliveries");
    } else {
      navigate("/");
    }
  }

  const login = trpc.auth.login.useMutation({
    onSuccess: async (data) => {
      if (data.requiresTwoFactor) {
        setTicket(data.ticket);
        setStep("otp");
        return;
      }
      await finishLogin(data);
    },
    onError: (e) => setError(translateLoginError(e.message)),
  });

  const resetPassword = trpc.auth.resetPasswordWithToken.useMutation({
    onSuccess: () => {
      setResetDone(true);
      setResetToken("");
      setNewPassword("");
      setConfirmPassword("");
      setError("");
    },
    onError: (e) => setError(e.message),
  });

  function backToCredentials() {
    setStep("credentials");
    setTicket(null);
    setResetDone(false);
    setError("");
  }

  return (
    <div
      onMouseMove={handleMouseMove}
      className="min-h-screen lg:h-screen lg:max-h-screen w-full flex bg-[#03060d] text-slate-100 selection:bg-white/20 selection:text-white relative overflow-hidden"
      dir="rtl"
    >
      {/* خلفية أبل الكونية الموحدة مع أطياف شفقية متدرجة تعكس ألوان الهوية المؤسسية */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {/* شفق كاوستيك علوي بلمسة الأخضر الزمردي المعتمد */}
        <div
          className="absolute -top-32 right-1/4 w-[650px] h-[650px] rounded-full blur-[140px] opacity-25"
          style={{ background: "radial-gradient(circle, rgba(16,123,99,0.3) 0%, rgba(13,110,87,0.1) 50%, transparent 80%)" }}
        />
        {/* شفق كاوستيك سفلي بلمسة العنبر والنحاس الدافئ */}
        <div
          className="absolute -bottom-32 left-1/4 w-[700px] h-[700px] rounded-full blur-[150px] opacity-20"
          style={{ background: "radial-gradient(circle, rgba(200,90,39,0.25) 0%, rgba(154,67,25,0.08) 50%, transparent 80%)" }}
        />
        {/* شبكة ناعمة فائقة الدقة تحاكي شبكات أبل الزجاجية */}
        <div className="absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:32px_32px] opacity-60" />

        {/* إضاءة انعكاسية تفاعلية ناعمة تتبع حركة الفأرة بنمط أبل التفاعلي */}
        <div
          className="absolute inset-0 transition-opacity duration-700 opacity-30"
          style={{
            background: `radial-gradient(800px circle at ${(mouseCoord.x + 1) * 50}% ${(mouseCoord.y + 1) * 50}%, rgba(255,255,255,0.04), transparent 60%)`,
          }}
        />
      </div>

      {/* الجانب الجانبي: واجهة الاستعراض البصري والشعار بنمط أبل الصافي (محمّلة بالطلب لتخفيف الحزمة الأساسية) */}
      <Suspense fallback={<div className="hidden lg:flex lg:w-1/2 bg-[#040711]" />}>
        <LoginShowcase mouseCoord={mouseCoord} baghdadTime={baghdadTime} />
      </Suspense>

{/* الجانب الأيسر: بوابة الولوج التنفيذية بنمط تصميم أبل الفاخر (Apple Executive Terminal) */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-4 sm:p-6 lg:p-10 relative overflow-hidden bg-[#03060d]/50 backdrop-blur-3xl h-full overflow-y-auto lg:overflow-hidden select-none">
        <div className="w-full max-w-md relative z-10">
          {/* ترويسة الشاشات الصغيرة للموبايل بنمط أبل المنظم */}
          <div className="lg:hidden text-center mb-6">
            <div className="inline-flex size-14 items-center justify-center rounded-2xl bg-white/[0.04] border border-white/[0.1] p-2.5 mb-3 shadow-lg ring-1 ring-white/5 backdrop-blur-xl">
              <img
                src="/logo.png"
                alt="شركة الرؤية العربية"
                className="w-full h-full object-contain"
              />
            </div>
            <div role="heading" aria-level={1} className="text-xl font-bold text-white tracking-tight">
              شركة الرؤية العربية للتجارة العامة
            </div>
            <p className="text-xs text-slate-400 mt-1 font-light">منظومة الإدارة المركزية والطباعة ونقاط البيع</p>
          </div>

          {/* الكارت التنفيذي الرئيسي المصقول بنمط زجاج أبل السائل (Apple Liquid Glass Card) */}
          <motion.div
            layout
            initial={{ opacity: 0, scale: 0.97 }}
            animate={
              error
                ? { opacity: 1, scale: 1, x: [-10, 10, -8, 8, -4, 4, 0] }
                : { opacity: 1, scale: 1, x: 0 }
            }
            transition={{ duration: 0.35, ease: "easeOut" }}
            className="rounded-[36px] border border-white/[0.12] bg-white/[0.03] backdrop-blur-3xl p-6 sm:p-8 shadow-[0_32px_90px_-20px_rgba(0,0,0,0.85),0_0_0_1px_rgba(255,255,255,0.06)_inset] relative overflow-hidden group"
          >
            {/* لمعان الحافة العلوية (Apple Top Specular Bevel) */}
            <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent pointer-events-none" />

            {/* وميض ضوئي ناعم على الكارت */}
            <motion.div
              aria-hidden
              className="absolute inset-0 pointer-events-none z-10 overflow-hidden rounded-[36px]"
            >
              <motion.div
                className="w-[180%] h-full bg-gradient-to-r from-transparent via-white/[0.04] to-transparent -skew-x-25"
                animate={{ x: ["-140%", "240%"] }}
                transition={{ duration: 6, repeat: Infinity, repeatDelay: 4, ease: "easeInOut" }}
              />
            </motion.div>

            {/* شارة أبل الرقيقة لتوثيق البوابة مع زر حساب الإدارة التجريبي */}
            <div className="flex items-center justify-between mb-6 relative z-20">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.04] border border-white/[0.08] backdrop-blur-xl text-[11px] font-medium text-slate-300 shadow-sm">
                <Lock className="size-3 text-slate-400" aria-hidden />
                <span>بوابة الولوج المعتمدة</span>
              </div>

              {step !== "credentials" && (
                <button
                  type="button"
                  onClick={backToCredentials}
                  className="text-xs text-slate-400 hover:text-white inline-flex items-center gap-1.5 transition active:scale-[0.96] px-3 py-1 rounded-full bg-white/[0.03] border border-white/[0.06]"
                >
                  <span>العودة</span>
                  <ArrowRight className="size-3 rotate-180" aria-hidden />
                </button>
              )}
            </div>

            {/* عنوان وتفاصيل الشاشة بأسلوب أبل الصافي */}
            <div className="mb-6 relative z-20">
              <div className="inline-flex items-center gap-2 mb-2">
                <span className="size-1.5 rounded-full bg-money-positive animate-pulse" />
                <span className="text-xs font-medium text-slate-400">{greeting}</span>
              </div>
              <h2 className="text-2xl sm:text-[26px] font-bold tracking-tight text-white/95">
                {step === "credentials"
                  ? "تسجيل الدخول إلى المنظومة"
                  : step === "otp"
                  ? "رمز التحقق الثنائي (2FA)"
                  : "استعادة كلمة المرور"}
              </h2>
              <p className="text-xs sm:text-sm text-slate-400 mt-1.5 leading-relaxed font-light">
                {step === "credentials"
                  ? "أدخل بيانات الاعتماد الرسمية لبدء جلسة عمل مشفّرة وموثقة"
                  : step === "otp"
                  ? "أدخل رمز التحقق المكون من 6 أرقام لتأكيد هويتك وحصانة الجلسة"
                  : "أدخل الرمز السري الممنوح لك لتعيين كلمة مرور جديدة"}
              </p>
            </div>

            {/* تنبيه زر Caps Lock النشط بأسلوب حسي راقٍ */}
            <AnimatePresence>
              {capsLockActive && (
                <motion.div
                  initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                  animate={{ opacity: 1, height: "auto", marginBottom: 16 }}
                  exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                  role="status"
                  className="p-3 rounded-2xl bg-white/[0.04] border border-white/[0.1] text-xs text-slate-300 flex items-center gap-2.5 font-medium overflow-hidden shadow-inner backdrop-blur-xl"
                >
                  <KeyRound className="size-4 shrink-0 text-slate-400" aria-hidden />
                  <span>تنبيه: زر Caps Lock مفعّل (قد يؤدي لكتابة أحرف كبيرة غير مقصودة)</span>
                </motion.div>
              )}
            </AnimatePresence>

            {/* رسالة الخطأ التفاعلية */}
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                role="alert"
                className="mb-4 p-3 rounded-2xl bg-destructive/10 border border-destructive/25 text-destructive text-xs flex items-center gap-2 font-medium"
              >
                <AlertCircle className="size-4 shrink-0" aria-hidden />
                <span>{error}</span>
              </motion.div>
            )}

            {/* محتوى النماذج بحركات انسيابية راقية */}
            <AnimatePresence mode="wait">
              {step === "credentials" ? (
                <motion.form
                  key="credentials-form"
                  initial={{ opacity: 0, x: -16 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 16 }}
                  transition={{ duration: 0.2 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    setError("");
                    try {
                      if (remember && identifier.trim()) {
                        localStorage.setItem(SAVED_IDENTIFIER_KEY, identifier.trim());
                        localStorage.setItem(REMEMBER_KEY, "1");
                      } else {
                        localStorage.removeItem(SAVED_IDENTIFIER_KEY);
                        localStorage.setItem(REMEMBER_KEY, "0");
                      }
                    } catch {
                      // ignore
                    }
                    login.mutate({
                      identifier: identifier.trim(),
                      password,
                      remember,
                      ...(multiTenant ? { companyCode: companyCode.trim() } : {}),
                    });
                  }}
                  className="space-y-4 relative z-20"
                >
                  {multiTenant && (
                    <div className="space-y-1.5">
                      <Label htmlFor="companyCode" className="text-xs font-medium text-slate-300 tracking-wide block">
                        رمز الشركة
                      </Label>
                      <div className="relative">
                        <Building2 className="absolute right-3.5 top-1/2 -translate-y-1/2 size-4 text-slate-400" aria-hidden />
                        <Input
                          id="companyCode"
                          type="text"
                          dir="ltr"
                          autoComplete="organization"
                          value={companyCode}
                          onChange={(e) => setCompanyCode(e.target.value)}
                          className="pe-10 ps-4 h-12 text-sm bg-white/[0.04] hover:bg-white/[0.06] focus:bg-white/[0.07] border border-white/[0.1] focus:border-white/30 rounded-2xl text-white placeholder:text-slate-500 shadow-[0_2px_8px_rgba(0,0,0,0.25)_inset] focus:ring-2 focus:ring-white/15 focus:outline-none transition-all duration-200"
                          placeholder="مثال: alroya"
                          required
                        />
                      </div>
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <Label htmlFor="identifier" className="text-xs font-medium text-slate-300 tracking-wide block">
                      البريد الإلكتروني أو اسم المستخدم
                    </Label>
                    <div className="relative">
                      <User className="absolute right-3.5 top-1/2 -translate-y-1/2 size-4 text-slate-400" aria-hidden />
                      <Input
                        id="identifier"
                        name="username"
                        type="text"
                        dir="ltr"
                        autoComplete="username"
                        autoCapitalize="none"
                        value={identifier}
                        onChange={(e) => setIdentifier(e.target.value)}
                        className="pe-10 ps-10 h-12 text-sm bg-white/[0.04] hover:bg-white/[0.06] focus:bg-white/[0.07] border border-white/[0.1] focus:border-white/30 rounded-2xl text-white placeholder:text-slate-500 shadow-[0_2px_8px_rgba(0,0,0,0.25)_inset] focus:ring-2 focus:ring-white/15 focus:outline-none transition-all duration-200"
                        placeholder="اسم المستخدم أو البريد الإلكتروني"
                        required
                      />
                      {identifier && (
                        <button
                          type="button"
                          onClick={() => setIdentifier("")}
                          className="absolute left-3.5 top-1/2 -translate-y-1/2 p-1 rounded-full text-slate-400 hover:text-white hover:bg-white/[0.1] transition"
                          title="مسح الحقل"
                        >
                          <X className="size-3.5" aria-hidden />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="password" className="text-xs font-medium text-slate-300 tracking-wide block">
                      كلمة المرور
                    </Label>
                    <PasswordInput
                      id="password"
                      name="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={setPassword}
                      required
                      className="h-12 [&_input]:h-12 [&_input]:rounded-2xl [&_input]:bg-white/[0.04] [&_input]:hover:bg-white/[0.06] [&_input]:focus:bg-white/[0.07] [&_input]:border-white/[0.1] [&_input]:focus:border-white/30 [&_input]:text-white [&_input]:placeholder:text-slate-500 [&_input]:shadow-[0_2px_8px_rgba(0,0,0,0.25)_inset] [&_input]:focus:ring-2 [&_input]:focus:ring-white/15 [&_input]:transition-all [&_input]:duration-200"
                    />
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="remember"
                        checked={remember}
                        onCheckedChange={(v) => setRemember(v === true)}
                        className="rounded-lg border-white/20 data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-500"
                      />
                      <Label htmlFor="remember" className="text-xs font-normal cursor-pointer text-slate-400 select-none hover:text-slate-300 transition-colors">
                        تذكّرني على هذا الجهاز (30 يوماً)
                      </Label>
                    </div>

                    <button
                      type="button"
                      className="text-xs text-blue-400 hover:text-blue-300 font-medium transition-colors"
                      onClick={() => {
                        setStep("reset");
                        setResetDone(false);
                        setError("");
                      }}
                    >
                      استعادة الرمز؟
                    </button>
                  </div>

                  <Button
                    type="submit"
                    className="w-full h-12 rounded-2xl font-semibold text-sm bg-gradient-to-b from-[#2563eb] to-[#1d4ed8] hover:from-[#3b82f6] hover:to-[#2563eb] text-white shadow-[0_4px_18px_rgba(37,99,235,0.35),0_1px_0_rgba(255,255,255,0.25)_inset] border border-blue-400/30 active:scale-[0.98] transition-all duration-200 flex items-center justify-center gap-2 relative overflow-hidden group"
                    disabled={login.isPending}
                  >
                    <span className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000 ease-out pointer-events-none" />
                    {login.isPending ? (
                      <>
                        <span className="size-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        <span>جارٍ التحقق وتأمين الجلسة…</span>
                      </>
                    ) : (
                      <>
                        <ShieldCheck className="size-4" aria-hidden />
                        <span>دخول المنظومة</span>
                      </>
                    )}
                  </Button>
                </motion.form>
              ) : step === "reset" ? (
                <motion.form
                  key="reset-form"
                  initial={{ opacity: 0, x: -16 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 16 }}
                  transition={{ duration: 0.2 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    setError("");
                    if (newPassword !== confirmPassword) {
                      setError("كلمتا المرور غير متطابقتين.");
                      return;
                    }
                    if (newPassword.length < 8) {
                      setError("يجب أن تتكون كلمة المرور من 8 محارف على الأقل.");
                      return;
                    }
                    resetPassword.mutate({
                      token: resetToken.trim(),
                      newPassword,
                      ...(multiTenant ? { companyCode: companyCode.trim() } : {}),
                    });
                  }}
                  className="space-y-4 relative z-20"
                >
                  {resetDone ? (
                    <div className="space-y-4 text-center py-4">
                      <div className="inline-flex size-12 items-center justify-center rounded-2xl bg-money-positive/10 text-money-positive border border-money-positive/20">
                        <CheckCircle2 className="size-6" aria-hidden />
                      </div>
                      <p role="status" className="text-sm font-bold text-money-positive">
                        تم تغيير كلمة المرور بنجاح وإبطال الجلسات السابقة. يمكنك الآن تسجيل الدخول بالكلمة الجديدة.
                      </p>
                      <Button
                        type="button"
                        className="w-full h-11 rounded-2xl font-semibold text-sm bg-gradient-to-b from-[#2563eb] to-[#1d4ed8] hover:from-[#3b82f6] hover:to-[#2563eb] text-white"
                        onClick={backToCredentials}
                      >
                        العودة إلى تسجيل الدخول
                      </Button>
                    </div>
                  ) : (
                    <>
                      <p className="text-xs text-slate-400 leading-relaxed font-light">
                        أدخل الرمز الذي سلّمه لك مدير النظام، ثم اختر كلمة مرور قوية وخاصة بك. الرمز صالح 15 دقيقة لمرة واحدة فقط.
                      </p>

                      {multiTenant && (
                        <div className="space-y-1.5">
                          <Label htmlFor="resetCompanyCode" className="text-xs font-medium text-slate-300 tracking-wide block">
                            رمز الشركة
                          </Label>
                          <Input
                            id="resetCompanyCode"
                            type="text"
                            dir="ltr"
                            autoComplete="organization"
                            value={companyCode}
                            onChange={(e) => setCompanyCode(e.target.value)}
                            className="h-12 rounded-2xl text-sm bg-white/[0.04] hover:bg-white/[0.06] focus:bg-white/[0.07] border border-white/[0.1] text-white"
                            required
                          />
                        </div>
                      )}

                      <div className="space-y-1.5">
                        <Label htmlFor="resetToken" className="text-xs font-medium text-slate-300 tracking-wide block">
                          رمز الاستعادة
                        </Label>
                        <div className="relative">
                          <KeyRound className="absolute right-3.5 top-1/2 -translate-y-1/2 size-4 text-slate-400" aria-hidden />
                          <Input
                            id="resetToken"
                            type="text"
                            dir="ltr"
                            autoComplete="one-time-code"
                            value={resetToken}
                            onChange={(e) => setResetToken(e.target.value)}
                            className="pe-10 ps-4 h-12 text-sm font-mono bg-white/[0.04] hover:bg-white/[0.06] focus:bg-white/[0.07] border border-white/[0.1] rounded-2xl text-white placeholder:text-slate-500 shadow-[0_2px_8px_rgba(0,0,0,0.25)_inset]"
                            placeholder="أدخل الرمز السري"
                            required
                            autoFocus
                          />
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="newPassword" className="text-xs font-medium text-slate-300 tracking-wide block">
                          كلمة المرور الجديدة
                        </Label>
                        <PasswordInput
                          id="newPassword"
                          name="new-password"
                          autoComplete="new-password"
                          value={newPassword}
                          onChange={setNewPassword}
                          required
                          className="h-12 [&_input]:h-12 [&_input]:rounded-2xl [&_input]:bg-white/[0.04] [&_input]:hover:bg-white/[0.06] [&_input]:border-white/[0.1] [&_input]:text-white"
                        />

                        {/* مقياس دقيق لقوة وتعقيد كلمة المرور بنمط أبل */}
                        {newPassword && (
                          <div className="space-y-1.5 pt-1">
                            <div className="flex items-center justify-between text-[11px] text-slate-400">
                              <span>قوة كلمة المرور:</span>
                              <span className="font-semibold text-slate-200">
                                {newPassword.length < 8
                                  ? "قصيرة جداً (أقل من 8 محارف)"
                                  : newPassword.length < 12
                                  ? "جيدة ومقبولة"
                                  : "قوية ومحصنة"}
                              </span>
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-white/[0.08] overflow-hidden flex gap-1.5">
                              <div
                                className={cn(
                                  "h-full rounded-full flex-1 transition-all",
                                  newPassword.length >= 8 ? "bg-blue-500" : "bg-white/10"
                                )}
                              />
                              <div
                                className={cn(
                                  "h-full rounded-full flex-1 transition-all",
                                  newPassword.length >= 10 && /[0-9]/.test(newPassword)
                                    ? "bg-blue-500"
                                    : "bg-white/10"
                                )}
                              />
                              <div
                                className={cn(
                                  "h-full rounded-full flex-1 transition-all",
                                  newPassword.length >= 12 && /[^a-zA-Z0-9]/.test(newPassword)
                                    ? "bg-blue-500"
                                    : "bg-white/10"
                                )}
                              />
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="confirmPassword" className="text-xs font-medium text-slate-300 tracking-wide block">
                          تأكيد كلمة المرور
                        </Label>
                        <PasswordInput
                          id="confirmPassword"
                          name="confirm-password"
                          autoComplete="new-password"
                          value={confirmPassword}
                          onChange={setConfirmPassword}
                          required
                          className="h-12 [&_input]:h-12 [&_input]:rounded-2xl [&_input]:bg-white/[0.04] [&_input]:hover:bg-white/[0.06] [&_input]:border-white/[0.1] [&_input]:text-white"
                        />
                      </div>

                      <Button
                        type="submit"
                        className="w-full h-12 rounded-2xl font-semibold text-sm bg-gradient-to-b from-[#2563eb] to-[#1d4ed8] hover:from-[#3b82f6] hover:to-[#2563eb] text-white shadow-[0_4px_18px_rgba(37,99,235,0.35),0_1px_0_rgba(255,255,255,0.25)_inset]"
                        disabled={resetPassword.isPending}
                      >
                        {resetPassword.isPending ? "جارٍ التغيير…" : "تغيير كلمة المرور"}
                      </Button>

                      <button
                        type="button"
                        className="w-full text-xs text-slate-400 hover:text-white transition text-center pt-1"
                        onClick={backToCredentials}
                      >
                        إلغاء والعودة لتسجيل الدخول
                      </button>
                    </>
                  )}
                </motion.form>
              ) : (
                <Suspense
                  fallback={
                    <div className="flex items-center justify-center p-8">
                      <span className="size-6 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    </div>
                  }
                >
                  <TwoFactorForm
                    ticket={ticket}
                    onSuccess={async (data: { mustChangePassword: boolean; recoveryCodesRemaining?: number | null }) => {
                      await finishLogin(data);
                    }}
                    onError={(err: string) => {
                      setError(err);
                    }}
                    onBack={backToCredentials}
                    onExpired={() => {
                      setStep("credentials");
                      setTicket(null);
                    }}
                  />
                </Suspense>
              )}
            </AnimatePresence>

            {/* ختم الأمان السيبراني أسفل الكارت بنمط أبل الرقيق */}
            <div className="mt-6 pt-4 border-t border-white/[0.06] flex items-center justify-center gap-2 text-[11px] text-slate-400 text-center relative z-20">
              <ShieldCheck className="size-3.5 text-slate-400 shrink-0" aria-hidden />
              <span>اتصال مشفّر ومحمي بأنظمة الرقابة ومكافحة التخمين · بغداد</span>
            </div>
          </motion.div>

          <p className="text-center text-[11px] text-slate-400/80 mt-6 tracking-wide">
            جميع الحقوق محفوظة © شركة الرؤية العربية للتجارة العامة
          </p>
        </div>
      </div>
    </div>
  );
}
