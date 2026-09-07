import { PasswordInput } from "@/components/form/PasswordInput";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { translateLoginError } from "@/lib/loginErrors";
import { saveOfflineProfile } from "@/lib/offline/pinLock";
import { studioOfflineProfileInput } from "@/lib/productStudio/coldOfflinePolicy";
import { saveStudioDraftIdentity } from "@/lib/productStudio/studioDrafts";
import { resetSessionForLogin } from "@/lib/offline/sessionBoundary";
import { trpc } from "@/lib/trpc";
import { useQueryClient } from "@tanstack/react-query";
import { INTERNAL_ORIGIN, isPublicHost } from "@/lib/siteHosts";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { useEffect, useState, useMemo } from "react";
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
} from "lucide-react";
import { cn } from "@/lib/utils";

const LAST_COMPANY_CODE_KEY = "erp.lastCompanyCode";
const REMEMBER_KEY = "erp.rememberMe";

export default function Login() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  const [identifier, setIdentifier] = useState("");
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
  const [otp, setOtp] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
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

  const handleQuickFillAdmin = () => {
    setIdentifier("admin@alroya.local");
    setPassword("Admin@12345");
    setError("");
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
        console.warn(`رموز الاسترداد المتبقية: ${data.recoveryCodesRemaining}`);
      }
      await finishLogin(data);
    },
    onError: (e) => {
      setError(translateLoginError(e.message));
      setOtp("");
      if (e.message.includes("انتهت مهلة التحقق")) {
        setStep("credentials");
        setTicket(null);
      }
    },
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
    setResetDone(false);
    setError("");
  }

  return (
    <div
      onMouseMove={handleMouseMove}
      className="min-h-screen lg:h-screen lg:max-h-screen w-full flex bg-[#070b14] text-slate-100 selection:bg-primary/25 selection:text-primary relative overflow-hidden"
      dir="rtl"
    >
      {/* خلفية معمارية شبكية فاخرة وإضاءة استوديو محيطية */}
      <div className="absolute inset-0 pointer-events-none">
        {/* هالة علوية زرقاء كحلية */}
        <div
          className="absolute -top-40 -right-40 size-[580px] rounded-full blur-[150px] opacity-25"
          style={{ background: "radial-gradient(circle, #2563eb 0%, #1e1b4b 60%, transparent 100%)" }}
        />
        {/* هالة سفلية عميقة */}
        <div
          className="absolute -bottom-40 -left-40 size-[620px] rounded-full blur-[160px] opacity-20"
          style={{ background: "radial-gradient(circle, #0284c7 0%, #0f172a 70%, transparent 100%)" }}
        />

        {/* شبكة هندسية خافتة فائقة الدقة تحاكي شاشات مراقبة العمليات الكبرى */}
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff04_1px,transparent_1px),linear-gradient(to_bottom,#ffffff04_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_80%_70%_at_50%_50%,#000_70%,transparent_100%)]" />

        {/* إضاءة تفاعلية ناعمة تتبع حركة الفأرة */}
        <div
          className="absolute inset-0 transition-opacity duration-500 opacity-25"
          style={{
            background: `radial-gradient(700px circle at ${(mouseCoord.x + 1) * 50}% ${(mouseCoord.y + 1) * 50}%, rgba(37,99,235,0.08), transparent 50%)`,
          }}
        />
      </div>

      {/* الجانب الأيمن: قمرة العمليات والنشاط التجاري لشركة الرؤية العربية (شاشات lg فما فوق) */}
      <div className="hidden lg:flex lg:w-1/2 relative bg-[#080d1a]/80 backdrop-blur-md flex-col justify-between p-6 xl:p-10 overflow-hidden border-e border-white/[0.08] h-full">
        {/* ترويسة الهوية المؤسسية الرسمية مع شعار الخط العربي المعتمد */}
        <div className="relative z-10 space-y-3">
          <div className="flex items-center gap-3.5">
            {/* الشعار الرسمي للشركة */}
            <div className="size-13 rounded-2xl bg-white/[0.08] border border-white/20 p-2 backdrop-blur-md shadow-xl flex items-center justify-center shrink-0 ring-1 ring-white/10">
              <img
                src="/logo.png"
                alt="شعار شركة الرؤية العربية"
                className="w-full h-full object-contain"
              />
            </div>
            <div className="space-y-1">
              <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full bg-white/[0.04] border border-white/10 text-[11px] font-medium text-slate-300">
                <span className="relative flex size-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-money-positive opacity-75" />
                  <span className="relative inline-flex rounded-full size-2 bg-money-positive" />
                </span>
                <span>المنظومة الإدارية والمالية المركزية</span>
              </div>
              <div role="heading" aria-level={1} className="text-2xl xl:text-3xl font-black tracking-tight text-white leading-tight">
                شركة الرؤية العربية للتجارة العامة
              </div>
            </div>
          </div>

          <p className="text-xs sm:text-sm text-slate-400 max-w-lg leading-relaxed">
            منظومة مؤسسية موحدة لإدارة العمليات التجارية، خطوط الإنتاج والطباعة، سلاسل الإمداد ونقاط البيع المركزية — بغداد، العامرية.
          </p>
        </div>

        {/* قلب المعرض: بوابة الحوكمة والأمان المؤسسي المعتمدة (Institutional Security & Governance Panel) */}
        <div className="relative z-10 my-auto py-2 select-none w-full max-w-xl mx-auto">
          <motion.div
            style={{
              transform: `perspective(1000px) rotateX(${-mouseCoord.y * 7}deg) rotateY(${mouseCoord.x * 7}deg)`,
            }}
            transition={{ type: "spring", stiffness: 120, damping: 22 }}
            className="rounded-3xl border border-white/10 bg-[#0c1424]/90 backdrop-blur-2xl p-5 xl:p-6 shadow-[0_25px_60px_-15px_rgba(0,0,0,0.85)] ring-1 ring-white/5 space-y-5"
          >
            {/* ترويسة الحوكمة: معايير الأمان المعتمدة */}
            <div className="flex items-center justify-between border-b border-white/10 pb-3.5">
              <div className="flex items-center gap-2.5">
                <div className="size-8 rounded-lg bg-primary/10 border border-primary/25 flex items-center justify-center text-primary">
                  <ShieldCheck className="size-4" aria-hidden />
                </div>
                <div>
                  <h2 className="text-xs font-bold text-white">معايير الأمان وحوكمة النفاذ المؤسسي</h2>
                  <p className="text-[10px] text-slate-400">بيئة سحابية ومحلية محمية وفق أعلى ضوابط الامتثال الإداري</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-money-positive/10 border border-money-positive/20 text-money-positive text-[11px] font-bold">
                <span className="size-1.5 rounded-full bg-money-positive animate-pulse" />
                <span>جلسة مشفرة ومعتمدة</span>
              </div>
            </div>

            {/* بطاقة بروتوكول حماية سرية البيانات والامتثال الفدرالي */}
            <div className="p-4 rounded-2xl bg-white/[0.025] border border-white/[0.06] space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="size-7 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 flex items-center justify-center">
                    <Lock className="size-3.5" aria-hidden />
                  </div>
                  <div>
                    <span className="text-xs font-bold text-white block">حماية مشددة لكافة قنوات التداول</span>
                    <span className="text-[10px] text-slate-400">تشفير القنوات عبر TLS 1.3 مع عزل تام للبيانات المالية الحساسة</span>
                  </div>
                </div>
                <span className="text-[10px] font-mono font-bold text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20">
                  E2EE / TLS 1.3
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 pt-1">
                <div className="flex items-center gap-2 p-2 rounded-xl bg-white/[0.02] border border-white/[0.04]">
                  <CheckCircle2 className="size-3.5 text-money-positive shrink-0" aria-hidden />
                  <span className="text-[11px] text-slate-300">عزل تام للبيانات قبل المصادقة</span>
                </div>
                <div className="flex items-center gap-2 p-2 rounded-xl bg-white/[0.02] border border-white/[0.04]">
                  <CheckCircle2 className="size-3.5 text-money-positive shrink-0" aria-hidden />
                  <span className="text-[11px] text-slate-300">مطابقة الهوية والأجهزة المرخصة</span>
                </div>
              </div>
            </div>

            {/* ركائز الحوكمة الإدارية والأمنية الثلاث */}
            <div className="grid grid-cols-3 gap-2.5">
              <div className="p-3 rounded-xl bg-white/[0.025] border border-white/[0.06] space-y-1">
                <div className="size-6 rounded-md bg-blue-500/10 text-blue-400 border border-blue-500/20 flex items-center justify-center">
                  <KeyRound className="size-3.5" aria-hidden />
                </div>
                <div className="text-xs font-bold text-white">فصل الصلاحيات (RBAC)</div>
                <p className="text-[10px] text-slate-400 leading-tight">صلاحيات وظيفية دقيقة بحسب الواجب الإداري</p>
              </div>

              <div className="p-3 rounded-xl bg-white/[0.025] border border-white/[0.06] space-y-1">
                <div className="size-6 rounded-md bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 flex items-center justify-center">
                  <FileCheck2 className="size-3.5" aria-hidden />
                </div>
                <div className="text-xs font-bold text-white">سجل التدقيق الصارم</div>
                <p className="text-[10px] text-slate-400 leading-tight">توثيق زمني غير قابل للتعديل لكافة الحركات</p>
              </div>

              <div className="p-3 rounded-xl bg-white/[0.025] border border-white/[0.06] space-y-1">
                <div className="size-6 rounded-md bg-primary/10 text-primary border border-primary/20 flex items-center justify-center">
                  <Fingerprint className="size-3.5" aria-hidden />
                </div>
                <div className="text-xs font-bold text-white">توثيق الأجهزة</div>
                <p className="text-[10px] text-slate-400 leading-tight">حظر الأجهزة غير المعرفة ومكافحة التخمين</p>
              </div>
            </div>

            {/* إشعار الاستخدام المصرح به والتحذير الأمني التنظيمي */}
            <div className="p-3 rounded-xl bg-[var(--sem-warn)]/[0.04] border border-[var(--sem-warn)]/20 flex items-center gap-2.5">
              <AlertCircle className="size-4 text-[var(--sem-warn)] shrink-0" aria-hidden />
              <p className="text-[11px] text-slate-300 leading-snug">
                <strong className="text-[var(--sem-warn)] font-semibold">تنبيه نظامي:</strong> هذه البوابة مخصصة حصراً لكوادر شركة الرؤية العربية المصرح لهم. تخضع كافة عمليات الدخول للرقابة والتدقيق الدوري لحماية أصول المنظومة.
              </p>
            </div>
          </motion.div>
        </div>

        {/* شريط حالة المقر والتوقيت أسفل الشاشة */}
        <div className="relative z-10 w-full max-w-xl mx-auto border-t border-white/10 pt-3.5 flex items-center justify-between text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-money-positive" />
            <span className="text-slate-300 font-medium text-[11px]">
              بغداد — العامرية / شارع العمل الشعبي
            </span>
          </div>
          <div className="flex items-center gap-3 font-mono text-[11px]">
            <span className="text-slate-200 bg-white/[0.05] px-2 py-0.5 rounded border border-white/10 font-bold">
              {baghdadTime || "14:50:00"}
            </span>
            <span className="text-slate-400">استجابة 22ms · TLS 1.3</span>
          </div>
        </div>
      </div>

      {/* الجانب الأيسر: بوابة الولوج التنفيذية المعتمدة (Executive Terminal) */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-4 sm:p-6 lg:p-8 relative overflow-hidden bg-[#070b14] h-full overflow-y-auto lg:overflow-hidden">
        <div className="w-full max-w-md relative z-10">
          {/* ترويسة الشاشات الصغيرة للموبايل */}
          <div className="lg:hidden text-center mb-6">
            <div className="inline-flex size-14 items-center justify-center rounded-2xl bg-white/[0.06] border border-white/15 p-2 mb-3 shadow-lg">
              <img
                src="/logo.png"
                alt="شركة الرؤية العربية"
                className="w-full h-full object-contain"
              />
            </div>
            <div role="heading" aria-level={1} className="text-xl font-black text-white">
              شركة الرؤية العربية للتجارة العامة
            </div>
            <p className="text-xs text-slate-400 mt-0.5">منظومة الإدارة المركزية والطباعة ونقاط البيع</p>
          </div>

          {/* الكارت التنفيذي الرئيسي المصقول بأناقة واحترافية عالية */}
          <motion.div
            layout
            initial={{ opacity: 0, scale: 0.97 }}
            animate={
              error
                ? { opacity: 1, scale: 1, x: [-10, 10, -8, 8, -4, 4, 0] }
                : { opacity: 1, scale: 1, x: 0 }
            }
            transition={{ duration: 0.35, ease: "easeOut" }}
            className="rounded-3xl border border-white/[0.1] bg-[#0d1424]/90 backdrop-blur-2xl p-6 sm:p-8 shadow-[0_30px_90px_rgba(0,0,0,0.85)] relative overflow-hidden ring-1 ring-white/5"
          >
            {/* شريط الإشراق العلوي الدقيق */}
            <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-transparent via-primary/70 to-transparent" />

            {/* شارة أمان البوابة مع زر التعبئة السريعة لتسهيل العمل */}
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <div className="size-7 rounded-lg bg-white/[0.06] border border-white/15 p-1 flex items-center justify-center shrink-0">
                  <img src="/logo.png" alt="الرؤية العربية" className="w-full h-full object-contain" />
                </div>
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary/10 border border-primary/25 text-primary text-[11px] font-bold shadow-sm">
                  <Lock className="size-3" aria-hidden />
                  <span>بوابة الولوج المعتمدة</span>
                </div>
              </div>

              {step === "credentials" ? (
                <button
                  type="button"
                  onClick={handleQuickFillAdmin}
                  className="text-[11px] text-slate-300 hover:text-white transition inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-white/[0.05] border border-white/10 hover:border-primary/40"
                  title="تعبئة حساب الإدارة للتجربة السريعة"
                >
                  <User className="size-3 text-primary" aria-hidden />
                  <span>حساب المدير (تجريبي)</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={backToCredentials}
                  className="text-xs text-slate-400 hover:text-white inline-flex items-center gap-1 transition"
                >
                  <span>العودة</span>
                  <ArrowRight className="size-3 rotate-180" aria-hidden />
                </button>
              )}
            </div>

            <div className="mb-6">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="size-1.5 rounded-full bg-primary" />
                <span className="text-xs font-semibold text-primary">{greeting}</span>
              </div>
              <h2 className="text-xl sm:text-2xl font-black tracking-tight text-white">
                {step === "credentials"
                  ? "تسجيل الدخول إلى المنظومة"
                  : step === "otp"
                  ? "رمز التحقق الثنائي (2FA)"
                  : "استعادة كلمة المرور"}
              </h2>
              <p className="text-xs sm:text-sm text-slate-400 mt-1.5 leading-relaxed">
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
                  className="p-3 rounded-xl bg-white/[0.04] border border-white/15 text-xs text-slate-200 flex items-center gap-2.5 font-medium overflow-hidden shadow-inner"
                >
                  <KeyRound className="size-4 shrink-0 text-primary" aria-hidden />
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
                className="mb-4 p-3 rounded-xl bg-destructive/10 border border-destructive/25 text-destructive text-xs flex items-center gap-2 font-medium"
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
                      localStorage.setItem(REMEMBER_KEY, remember ? "1" : "0");
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
                  className="space-y-4"
                >
                  {multiTenant && (
                    <div className="space-y-1.5">
                      <Label htmlFor="companyCode" className="text-xs font-semibold text-slate-200">
                        رمز الشركة
                      </Label>
                      <div className="relative">
                        <Building2 className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-slate-400" aria-hidden />
                        <Input
                          id="companyCode"
                          type="text"
                          dir="ltr"
                          autoComplete="organization"
                          value={companyCode}
                          onChange={(e) => setCompanyCode(e.target.value)}
                          className="pe-9 ps-3 h-10 text-xs sm:text-sm bg-black/40 border-white/10 text-white placeholder:text-slate-500 focus:border-primary/60 focus:ring-1 focus:ring-primary/40 transition-colors"
                          placeholder="مثال: alroya"
                          required
                        />
                      </div>
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <Label htmlFor="identifier" className="text-xs font-semibold text-slate-200">
                      البريد الإلكتروني أو اسم المستخدم
                    </Label>
                    <div className="relative">
                      <User className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-slate-400" aria-hidden />
                      <Input
                        id="identifier"
                        name="username"
                        type="text"
                        dir="ltr"
                        autoComplete="username"
                        autoCapitalize="none"
                        value={identifier}
                        onChange={(e) => setIdentifier(e.target.value)}
                        className="pe-9 ps-3 h-10 text-xs sm:text-sm bg-black/40 border-white/10 text-white placeholder:text-slate-500 focus:border-primary/60 focus:ring-1 focus:ring-primary/40 transition-colors"
                        placeholder="admin@alroya.local"
                        required
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="password" className="text-xs font-semibold text-slate-200">
                      كلمة المرور
                    </Label>
                    <PasswordInput
                      id="password"
                      name="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={setPassword}
                      required
                      className="h-10 [&_input]:bg-black/40 [&_input]:border-white/10 [&_input]:text-white [&_input]:focus:border-primary/60 [&_input]:focus:ring-1 [&_input]:focus:ring-primary/40"
                    />
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="remember"
                        checked={remember}
                        onCheckedChange={(v) => setRemember(v === true)}
                        className="border-white/20 data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                      />
                      <Label htmlFor="remember" className="text-xs font-normal cursor-pointer text-slate-400 select-none hover:text-slate-300 transition-colors">
                        تذكّرني على هذا الجهاز (30 يوماً)
                      </Label>
                    </div>

                    <button
                      type="button"
                      className="text-xs text-primary hover:underline font-medium"
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
                    className="w-full h-11 font-bold text-sm bg-primary hover:bg-primary/90 text-primary-foreground shadow-[0_4px_20px_rgba(37,99,235,0.4)] transition-all active:scale-[0.985] flex items-center justify-center gap-2 border border-primary/30 relative overflow-hidden group"
                    disabled={login.isPending}
                  >
                    <span className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-white/15 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000 ease-out" />
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
                  className="space-y-4"
                >
                  {resetDone ? (
                    <div className="space-y-4 text-center py-4">
                      <div className="inline-flex size-12 items-center justify-center rounded-full bg-money-positive/10 text-money-positive border border-money-positive/20">
                        <CheckCircle2 className="size-6" aria-hidden />
                      </div>
                      <p role="status" className="text-sm font-bold text-money-positive">
                        تم تغيير كلمة المرور بنجاح وإبطال الجلسات السابقة. يمكنك الآن تسجيل الدخول بالكلمة الجديدة.
                      </p>
                      <Button
                        type="button"
                        className="w-full h-10"
                        onClick={backToCredentials}
                      >
                        العودة إلى تسجيل الدخول
                      </Button>
                    </div>
                  ) : (
                    <>
                      <p className="text-xs text-slate-400 leading-relaxed">
                        أدخل الرمز الذي سلّمه لك مدير النظام، ثم اختر كلمة مرور قوية وخاصة بك. الرمز صالح 15 دقيقة لمرة واحدة فقط.
                      </p>

                      {multiTenant && (
                        <div className="space-y-1.5">
                          <Label htmlFor="resetCompanyCode" className="text-xs font-semibold text-slate-200">
                            رمز الشركة
                          </Label>
                          <Input
                            id="resetCompanyCode"
                            type="text"
                            dir="ltr"
                            autoComplete="organization"
                            value={companyCode}
                            onChange={(e) => setCompanyCode(e.target.value)}
                            className="h-10 text-xs sm:text-sm bg-black/40 border-white/10 text-white"
                            required
                          />
                        </div>
                      )}

                      <div className="space-y-1.5">
                        <Label htmlFor="resetToken" className="text-xs font-semibold text-slate-200">
                          رمز الاستعادة
                        </Label>
                        <div className="relative">
                          <KeyRound className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-slate-400" aria-hidden />
                          <Input
                            id="resetToken"
                            type="text"
                            dir="ltr"
                            autoComplete="one-time-code"
                            value={resetToken}
                            onChange={(e) => setResetToken(e.target.value)}
                            className="pe-9 ps-3 h-10 text-xs sm:text-sm font-mono bg-black/40 border-white/10 text-white"
                            placeholder="أدخل الرمز السري"
                            required
                            autoFocus
                          />
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="newPassword" className="text-xs font-semibold text-slate-200">
                          كلمة المرور الجديدة
                        </Label>
                        <PasswordInput
                          id="newPassword"
                          name="new-password"
                          autoComplete="new-password"
                          value={newPassword}
                          onChange={setNewPassword}
                          required
                          className="h-10 [&_input]:bg-black/40 [&_input]:border-white/10 [&_input]:text-white"
                        />

                        {/* مقياس دقيق لقوة وتعقيد كلمة المرور */}
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
                            <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden flex gap-1">
                              <div
                                className={cn(
                                  "h-full rounded-full flex-1 transition-all",
                                  newPassword.length >= 8 ? "bg-primary" : "bg-white/10"
                                )}
                              />
                              <div
                                className={cn(
                                  "h-full rounded-full flex-1 transition-all",
                                  newPassword.length >= 10 && /[0-9]/.test(newPassword)
                                    ? "bg-primary"
                                    : "bg-white/10"
                                )}
                              />
                              <div
                                className={cn(
                                  "h-full rounded-full flex-1 transition-all",
                                  newPassword.length >= 12 && /[^a-zA-Z0-9]/.test(newPassword)
                                    ? "bg-primary"
                                    : "bg-white/10"
                                )}
                              />
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="confirmPassword" className="text-xs font-semibold text-slate-200">
                          تأكيد كلمة المرور
                        </Label>
                        <PasswordInput
                          id="confirmPassword"
                          name="confirm-password"
                          autoComplete="new-password"
                          value={confirmPassword}
                          onChange={setConfirmPassword}
                          required
                          className="h-10 [&_input]:bg-black/40 [&_input]:border-white/10 [&_input]:text-white"
                        />
                      </div>

                      <Button
                        type="submit"
                        className="w-full h-10 font-bold"
                        disabled={resetPassword.isPending}
                      >
                        {resetPassword.isPending ? "جارٍ التغيير…" : "تغيير كلمة المرور"}
                      </Button>

                      <button
                        type="button"
                        className="w-full text-xs text-slate-400 hover:text-white transition text-center"
                        onClick={backToCredentials}
                      >
                        إلغاء والعودة لتسجيل الدخول
                      </button>
                    </>
                  )}
                </motion.form>
              ) : (
                <motion.form
                  key="otp-form"
                  initial={{ opacity: 0, x: -16 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 16 }}
                  transition={{ duration: 0.2 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitOtp();
                  }}
                  className="space-y-4"
                >
                  <p className="text-xs text-slate-400 leading-relaxed">
                    {useRecovery
                      ? "أدخل أحد رموز الاسترداد التي حفظتها عند إعداد المصادقة الثنائية."
                      : "أدخل الرمز المكون من 6 أرقام من تطبيق المصادقة (Google Authenticator) على هاتفك."}
                  </p>

                  {useRecovery ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="recoveryCode" className="text-xs font-semibold text-slate-200">
                        رمز الاسترداد
                      </Label>
                      <Input
                        id="recoveryCode"
                        type="text"
                        dir="ltr"
                        autoComplete="one-time-code"
                        placeholder="XXXXX-XXXXX"
                        value={recoveryCode}
                        onChange={(e) => setRecoveryCode(e.target.value)}
                        className="h-10 font-mono text-center tracking-widest bg-black/40 border-white/10 text-white"
                        autoFocus
                        required
                      />
                    </div>
                  ) : (
                    <div dir="ltr" className="flex justify-center py-2">
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
                            <InputOTPSlot
                              key={i}
                              index={i}
                              className="h-12 w-11 text-lg font-mono font-bold border-white/15 bg-black/40 text-white"
                            />
                          ))}
                        </InputOTPGroup>
                      </InputOTP>
                    </div>
                  )}

                  <Button
                    type="submit"
                    className="w-full h-11 font-bold text-sm bg-primary hover:bg-primary/90 text-primary-foreground shadow-[0_4px_20px_rgba(37,99,235,0.4)] transition-all active:scale-[0.985] flex items-center justify-center gap-2"
                    disabled={verify2fa.isPending}
                  >
                    {verify2fa.isPending ? (
                      <>
                        <span className="size-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        <span>جارٍ التحقق وتأكيد الهوية…</span>
                      </>
                    ) : (
                      <>
                        <ShieldCheck className="size-4" aria-hidden />
                        <span>تأكيد ومتابعة</span>
                      </>
                    )}
                  </Button>

                  <div className="flex items-center justify-between text-xs pt-1">
                    <button
                      type="button"
                      className="text-primary hover:underline font-medium"
                      onClick={() => {
                        setUseRecovery((v) => !v);
                        setError("");
                      }}
                    >
                      {useRecovery ? "استخدم رمز التطبيق" : "فقدت هاتفك؟ رمز الاسترداد"}
                    </button>
                    <button
                      type="button"
                      className="text-slate-400 hover:text-white transition"
                      onClick={backToCredentials}
                    >
                      رجوع
                    </button>
                  </div>
                </motion.form>
              )}
            </AnimatePresence>

            {/* ختم الأمان السيبراني أسفل الكارت */}
            <div className="mt-6 pt-4 border-t border-white/10 flex items-center justify-center gap-1.5 text-[11px] text-slate-400 text-center">
              <ShieldCheck className="size-3.5 text-primary shrink-0" aria-hidden />
              <span>اتصال مشفّر ومحمي بأنظمة الرقابة ومكافحة التخمين · بغداد</span>
            </div>
          </motion.div>

          <p className="text-center text-[11px] text-slate-500 mt-6">
            جميع الحقوق محفوظة © شركة الرؤية العربية للتجارة العامة
          </p>
        </div>
      </div>
    </div>
  );
}
