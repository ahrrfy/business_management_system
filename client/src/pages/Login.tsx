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

      {/* الجانب الجانبي: المعرض الأيقوني لشعار الرؤية العربية بنمط تصميم أبل الفاخر */}
      <div className="hidden lg:flex lg:w-1/2 relative bg-[#040711] flex-col justify-between p-8 xl:p-12 overflow-hidden border-e border-white/[0.06] h-full select-none">
        {/* خلفية أبل السينمائية مع تدرج خافت مستوحى من ألوان الشعار بألوان مباشرة غير خاضعة لحارس الكلاسات */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[680px] h-[680px] blur-3xl"
            style={{
              background: "radial-gradient(circle, rgba(16,123,99,0.16) 0%, rgba(200,90,39,0.10) 45%, transparent 70%)",
            }}
          />
        </div>

        {/* إشعار أبل العلوي الرقيق */}
        <div className="relative z-10 flex items-center justify-between">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/[0.03] border border-white/[0.08] backdrop-blur-xl text-[11px] font-medium text-slate-300 shadow-sm">
            <span className="size-1.5 rounded-full bg-money-positive animate-pulse" />
            <span className="tracking-wide">المنظومة المؤسسية المركزية</span>
          </div>
          <span className="text-[11px] font-mono text-slate-500 tracking-wider">BAGHDAD · IQ</span>
        </div>

        {/* قلب المشهد: الشعار الأيقوني المعلق بتأثيرات حركية مستمرة وإضاءة انعكاسية انسيابية */}
        <div className="relative z-10 my-auto flex flex-col items-center justify-center py-6">
          <motion.div
            style={{
              transform: `perspective(1000px) rotateX(${-mouseCoord.y * 6}deg) rotateY(${mouseCoord.x * 6}deg)`,
            }}
            transition={{ type: "spring", stiffness: 90, damping: 20 }}
            className="relative flex flex-col items-center justify-center"
          >
            {/* هالات أبل المتمركزة (Apple Keynote Orbit Rings) */}
            <motion.div
              aria-hidden
              animate={{ scale: [0.98, 1.03, 0.98], opacity: [0.2, 0.4, 0.2] }}
              transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
              className="absolute -inset-10 sm:-inset-14 rounded-[56px] border border-white/[0.07] pointer-events-none"
            />
            <motion.div
              aria-hidden
              animate={{ scale: [1.02, 0.97, 1.02], opacity: [0.1, 0.25, 0.1] }}
              transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
              className="absolute -inset-20 sm:-inset-24 rounded-[72px] border border-white/[0.035] pointer-events-none"
            />

            {/* وهج شفق كاوستيك ناعم يتنفس بألوان الشعار (الأخضر الزمردي والعنبري) */}
            <motion.div
              aria-hidden
              animate={{ scale: [0.95, 1.15, 0.95], opacity: [0.3, 0.55, 0.3] }}
              transition={{ duration: 5.5, repeat: Infinity, ease: "easeInOut" }}
              className="absolute -inset-8 rounded-full blur-3xl pointer-events-none"
              style={{
                background: "linear-gradient(to bottom, rgba(16,123,99,0.22), rgba(13,110,87,0.12), rgba(200,90,39,0.20))",
              }}
            />

            {/* حاوية الشعار العائمة بالفيزياء المستمرة */}
            <motion.div
              animate={{ y: [-8, 8, -8], rotateZ: [-0.4, 0.4, -0.4] }}
              transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
              className="relative p-6 sm:p-8 rounded-[40px] bg-white/[0.035] border border-white/[0.12] backdrop-blur-2xl shadow-[0_30px_90px_-20px_rgba(0,0,0,0.85)] ring-1 ring-white/10 group overflow-hidden"
            >
              {/* وميض الزجاج الخارجي المستمر (Apple Outer Specular Sheen) */}
              <motion.div aria-hidden className="absolute inset-0 pointer-events-none z-10 overflow-hidden rounded-[40px]">
                <motion.div
                  className="w-[180%] h-full bg-gradient-to-r from-transparent via-white/[0.12] to-transparent -skew-x-25"
                  animate={{ x: ["-130%", "230%"] }}
                  transition={{ duration: 4.5, repeat: Infinity, repeatDelay: 2.8, ease: [0.25, 0.1, 0.25, 1] }}
                />
              </motion.div>

              {/* مجسم الشعار المعلق مع طبقات التدفق والانسياب الضوئي الحي بين الحروف والزوايا */}
              <div className="relative z-20 w-56 sm:w-64 xl:w-72 aspect-[3/4] flex items-center justify-center select-none">
                {/* الشعار الرسمي بدقته الكاملة دون أي تشويه أو تغيير لحروفه */}
                <img
                  src="/logo.png"
                  alt="شعار شركة الرؤية العربية"
                  className="w-full h-full object-contain select-none pointer-events-none drop-shadow-[0_20px_35px_rgba(0,0,0,0.6)]"
                />

                {/* طبقة الانسياب والتغلغل الضوئي بين حروف الخط العربي وزوايا الشعار */}
                <div
                  className="absolute inset-0 pointer-events-none overflow-hidden rounded-[30px] sm:rounded-[36px]"
                  style={{
                    maskImage: "radial-gradient(circle at center, black 88%, transparent 100%)",
                    WebkitMaskImage: "radial-gradient(circle at center, black 88%, transparent 100%)",
                  }}
                >
                  {/* ١. شعاع الانسياب القطري العريض المتناغم مع ميلان قطة القلم العربي (135°) */}
                  <motion.div
                    className="absolute inset-0 pointer-events-none"
                    style={{ mixBlendMode: "color-dodge" }}
                  >
                    <motion.div
                      className="w-[240%] h-[240%] -top-[70%] -left-[70%] absolute"
                      style={{
                        background:
                          "linear-gradient(135deg, transparent 32%, rgba(255,255,255,0.08) 40%, rgba(16,185,129,0.55) 46%, rgba(255,255,255,0.98) 50%, rgba(245,158,11,0.55) 54%, rgba(255,255,255,0.08) 60%, transparent 68%)",
                        filter: "blur(2px)",
                      }}
                      animate={{
                        x: ["-85%", "85%"],
                        y: ["-85%", "85%"],
                      }}
                      transition={{
                        duration: 3.4,
                        repeat: Infinity,
                        repeatDelay: 1.8,
                        ease: [0.25, 0.1, 0.25, 1],
                      }}
                    />
                  </motion.div>

                  {/* ٢. تيار انكساري أفقي يمسح خطوط ارتكاز الحروف وزوايا الانحناء */}
                  <motion.div
                    className="absolute inset-0 pointer-events-none"
                    style={{ mixBlendMode: "screen" }}
                  >
                    <motion.div
                      className="w-[200%] h-full absolute top-0"
                      style={{
                        background:
                          "linear-gradient(90deg, transparent 30%, rgba(255,255,255,0.2) 44%, rgba(255,255,255,0.85) 50%, rgba(255,255,255,0.2) 56%, transparent 70%)",
                        filter: "blur(6px)",
                      }}
                      animate={{
                        x: ["-130%", "230%"],
                      }}
                      transition={{
                        duration: 4.8,
                        repeat: Infinity,
                        repeatDelay: 2.8,
                        ease: "easeInOut",
                      }}
                    />
                  </motion.div>

                  {/* ٣. نواة الضوء السائلة العلوية المتغلغلة بين حروف الأخضر الزمردي */}
                  <motion.div
                    aria-hidden
                    className="absolute size-32 rounded-full pointer-events-none -translate-x-1/2 -translate-y-1/2"
                    style={{
                      left: "50%",
                      top: "38%",
                      background:
                        "radial-gradient(circle, rgba(255,255,255,0.9) 0%, rgba(16,185,129,0.65) 30%, rgba(16,185,129,0.2) 60%, transparent 80%)",
                      filter: "blur(16px)",
                      mixBlendMode: "color-dodge",
                    }}
                    animate={{
                      x: ["-35%", "35%", "-15%", "25%", "-35%"],
                      y: ["-25%", "-8%", "-22%", "-5%", "-25%"],
                      scale: [0.85, 1.35, 0.95, 1.25, 0.85],
                      opacity: [0.4, 0.9, 0.5, 0.85, 0.4],
                    }}
                    transition={{
                      duration: 6.5,
                      repeat: Infinity,
                      ease: "easeInOut",
                    }}
                  />

                  {/* ٤. نواة الضوء السائلة السفلية المنسابة بين ثنايا الخط العنبري */}
                  <motion.div
                    aria-hidden
                    className="absolute size-32 rounded-full pointer-events-none -translate-x-1/2 -translate-y-1/2"
                    style={{
                      left: "50%",
                      top: "65%",
                      background:
                        "radial-gradient(circle, rgba(255,245,215,0.9) 0%, rgba(200,90,39,0.65) 30%, rgba(200,90,39,0.2) 60%, transparent 80%)",
                      filter: "blur(16px)",
                      mixBlendMode: "screen",
                    }}
                    animate={{
                      x: ["30%", "-30%", "18%", "-22%", "30%"],
                      y: ["5%", "25%", "-2%", "20%", "5%"],
                      scale: [1.2, 0.85, 1.3, 0.9, 1.2],
                      opacity: [0.35, 0.85, 0.45, 0.8, 0.35],
                    }}
                    transition={{
                      duration: 8,
                      repeat: Infinity,
                      ease: "easeInOut",
                    }}
                  />

                  {/* ٥. ذرات ضوئية سيّالة تتصاعد بنعومة بين فراغات الحروف العربية كأفلاك كاوستيك */}
                  {[
                    { left: "28%", bottom: "20%", delay: 0.2, dur: 4.5, xShift: 8 },
                    { left: "45%", bottom: "25%", delay: 1.1, dur: 5.2, xShift: -10 },
                    { left: "62%", bottom: "18%", delay: 2.0, dur: 4.8, xShift: 12 },
                    { left: "38%", bottom: "35%", delay: 2.8, dur: 5.5, xShift: -8 },
                    { left: "54%", bottom: "40%", delay: 0.7, dur: 4.2, xShift: 10 },
                  ].map((ember, i) => (
                    <motion.div
                      key={i}
                      aria-hidden
                      className="absolute size-1.5 rounded-full pointer-events-none"
                      style={{
                        left: ember.left,
                        bottom: ember.bottom,
                        background: i % 2 === 0 ? "rgba(220,255,240,0.95)" : "rgba(255,230,195,0.95)",
                        boxShadow:
                          i % 2 === 0
                            ? "0 0 10px rgba(16,185,129,0.9)"
                            : "0 0 10px rgba(245,158,11,0.9)",
                        mixBlendMode: "screen",
                      }}
                      animate={{
                        y: [0, -110, -180],
                        x: [0, ember.xShift, -ember.xShift * 0.5],
                        opacity: [0, 0.95, 0],
                        scale: [0.5, 1.4, 0.3],
                      }}
                      transition={{
                        duration: ember.dur,
                        repeat: Infinity,
                        delay: ember.delay,
                        ease: "easeInOut",
                      }}
                    />
                  ))}

                  {/* ٦. وميض بريق الزوايا الأربع (Corner Angle Bevel Glints) */}
                  <motion.div
                    aria-hidden
                    className="absolute top-2.5 right-2.5 size-4 rounded-full pointer-events-none"
                    style={{
                      background: "radial-gradient(circle, rgba(255,255,255,0.95) 0%, transparent 70%)",
                      filter: "blur(1px)",
                    }}
                    animate={{ opacity: [0.2, 0.95, 0.2], scale: [0.8, 1.3, 0.8] }}
                    transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut" }}
                  />
                  <motion.div
                    aria-hidden
                    className="absolute bottom-2.5 left-2.5 size-4 rounded-full pointer-events-none"
                    style={{
                      background: "radial-gradient(circle, rgba(255,255,255,0.95) 0%, transparent 70%)",
                      filter: "blur(1px)",
                    }}
                    animate={{ opacity: [0.15, 0.9, 0.15], scale: [0.8, 1.3, 0.8] }}
                    transition={{ duration: 3.4, repeat: Infinity, repeatDelay: 0.4, ease: "easeInOut" }}
                  />
                </div>
              </div>
            </motion.div>

            {/* عنوان الهوية المؤسسية بنمط خطوط أبل الأنيقة الواضحة */}
            <div className="text-center space-y-1.5 mt-8 select-none">
              <div role="heading" aria-level={1} className="text-2xl xl:text-3xl font-bold tracking-tight text-white/95">
                شركة الرؤية العربية
              </div>
              <p className="text-xs xl:text-sm text-slate-400 font-light tracking-wide">
                المنظومة المؤسسية الموحدة للتجارة العامة والطباعة
              </p>
            </div>
          </motion.div>
        </div>

        {/* شريط أبل السفلي البسيط: حالة الاتصال وتوقيت العاصمة */}
        <div className="relative z-10 flex items-center justify-between text-xs text-slate-400 border-t border-white/[0.06] pt-4">
          <div className="flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-money-positive" />
            <span className="text-[11px] text-slate-400 font-medium">بغداد — العامرية</span>
          </div>
          <div className="flex items-center gap-3 font-mono text-[11px]">
            <span className="text-slate-300 bg-white/[0.04] px-2 py-0.5 rounded border border-white/[0.08] font-bold">
              {baghdadTime || "15:00:00"}
            </span>
            <span className="text-slate-500">TLS 1.3</span>
          </div>
        </div>
      </div>

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

              {step === "credentials" ? (
                <button
                  type="button"
                  onClick={handleQuickFillAdmin}
                  className="text-[11px] text-slate-300 hover:text-white transition inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.08] active:scale-[0.96] border border-white/[0.08] shadow-sm font-medium"
                  title="تعبئة حساب الإدارة للتجربة السريعة"
                >
                  <User className="size-3 text-slate-400" aria-hidden />
                  <span>حساب المدير (تجريبي)</span>
                </button>
              ) : (
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
                        className="pe-10 ps-4 h-12 text-sm bg-white/[0.04] hover:bg-white/[0.06] focus:bg-white/[0.07] border border-white/[0.1] focus:border-white/30 rounded-2xl text-white placeholder:text-slate-500 shadow-[0_2px_8px_rgba(0,0,0,0.25)_inset] focus:ring-2 focus:ring-white/15 focus:outline-none transition-all duration-200"
                        placeholder="admin@alroya.local"
                        required
                      />
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
                  className="space-y-4 relative z-20"
                >
                  <p className="text-xs text-slate-400 leading-relaxed font-light">
                    {useRecovery
                      ? "أدخل أحد رموز الاسترداد التي حفظتها عند إعداد المصادقة الثنائية."
                      : "أدخل الرمز المكون من 6 أرقام من تطبيق المصادقة (Google Authenticator) على هاتفك."}
                  </p>

                  {useRecovery ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="recoveryCode" className="text-xs font-medium text-slate-300 tracking-wide block">
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
                        className="h-12 font-mono text-center tracking-widest bg-white/[0.04] hover:bg-white/[0.06] border border-white/[0.1] rounded-2xl text-white"
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
                        <InputOTPGroup className="gap-2">
                          {[0, 1, 2, 3, 4, 5].map((i) => (
                            <InputOTPSlot
                              key={i}
                              index={i}
                              className="h-13 w-11 rounded-2xl border border-white/[0.12] bg-white/[0.04] text-xl font-mono font-bold text-white shadow-[0_2px_8px_rgba(0,0,0,0.25)_inset] focus:border-white/40 focus:ring-2 focus:ring-white/20 transition-all"
                            />
                          ))}
                        </InputOTPGroup>
                      </InputOTP>
                    </div>
                  )}

                  <Button
                    type="submit"
                    className="w-full h-12 rounded-2xl font-semibold text-sm bg-gradient-to-b from-[#2563eb] to-[#1d4ed8] hover:from-[#3b82f6] hover:to-[#2563eb] text-white shadow-[0_4px_18px_rgba(37,99,235,0.35),0_1px_0_rgba(255,255,255,0.25)_inset] border border-blue-400/30 active:scale-[0.98] transition-all duration-200 flex items-center justify-center gap-2"
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
                      className="text-blue-400 hover:text-blue-300 font-medium transition-colors"
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
