import * as React from "react";
import { useEffect, useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CheckCircle2,
  X,
  Phone,
  MapPin,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { WhatsAppIcon } from "@/components/WhatsAppShare";
import { fmt } from "@/lib/money";
import {
  openWhatsApp,
  buildCustomerDispatchMessage,
  buildCourierAssignmentMessage,
  preferredWhatsAppPhone,
} from "@/lib/whatsapp";

export interface DeliveryDepartureData {
  consignmentNumber: string;
  orderNumber?: string | null;
  title?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  deliveryAddress?: string | null;
  courierName: string;
  courierPhone?: string | null;
  codAmount: string | number;
  deliveryFee?: string | number | null;
  feeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
}

export interface DeliveryDepartureOverlayProps {
  open: boolean;
  onClose: () => void;
  data: DeliveryDepartureData | null;
  durationMs?: number; // افتراضياً 6000ms
}

/**
 * تشغيل نغمة صوتية رقمية خفيفة عبر Web Audio API (صفر بايت — بلا ملفات خارجية).
 */
function playDepartureChime() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    // نغمة ترحيبية ثلاثية (Arpeggio: C5 -> E5 -> G5) مع صوت انطلاق ناعم
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, now + i * 0.12);

      gain.gain.setValueAtTime(0.001, now + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.18, now + i * 0.12 + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.35);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.4);
    });

    // صوت هدير محرك خفيف متلاشٍ
    const noiseOsc = ctx.createOscillator();
    const noiseGain = ctx.createGain();
    noiseOsc.type = "sawtooth";
    noiseOsc.frequency.setValueAtTime(95, now + 0.2);
    noiseOsc.frequency.exponentialRampToValueAtTime(140, now + 0.8);
    noiseGain.gain.setValueAtTime(0.001, now + 0.2);
    noiseGain.gain.linearRampToValueAtTime(0.05, now + 0.4);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
    noiseOsc.connect(noiseGain);
    noiseGain.connect(ctx.destination);
    noiseOsc.start(now + 0.2);
    noiseOsc.stop(now + 0.95);
  } catch {
    // بيئة المتصفح لا تدعم Web Audio أو تم تقييد الصوت
  }
}

export function DeliveryDepartureOverlay({
  open,
  onClose,
  data,
  durationMs = 6000,
}: DeliveryDepartureOverlayProps) {
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [progress, setProgress] = useState(100);
  const [isPaused, setIsPaused] = useState(false);
  const startTimeRef = useRef<number>(0);
  const animFrameRef = useRef<number | null>(null);

  // الكشف عن تفضيل الحركة المخففة للمستخدم (Accessibility)
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // تشغيل الصوت عند الفتح
  useEffect(() => {
    if (open && soundEnabled && !prefersReducedMotion) {
      playDepartureChime();
    }
  }, [open, soundEnabled, prefersReducedMotion]);

  // إغلاق عبر زر الهروب ESC
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  // عداد الإغلاق التلقائي مع إمكانية التوقف المؤقت عند تحويم الفأرة
  useEffect(() => {
    if (!open || durationMs <= 0) return;
    startTimeRef.current = performance.now();

    const updateTimer = (now: number) => {
      if (!isPaused) {
        const elapsed = now - startTimeRef.current;
        const remainingPct = Math.max(0, 100 - (elapsed / durationMs) * 100);
        setProgress(remainingPct);
        if (remainingPct <= 0) {
          onClose();
          return;
        }
      } else {
        // عند الإيقاف المؤقت نحافظ على موضع البداية
        startTimeRef.current = performance.now() - ((100 - progress) / 100) * durationMs;
      }
      animFrameRef.current = requestAnimationFrame(updateTimer);
    };

    animFrameRef.current = requestAnimationFrame(updateTimer);
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [open, durationMs, isPaused, onClose, progress]);

  const handleSendCustomerWhatsApp = useCallback(() => {
    if (!data?.customerPhone) return;
    const phone = preferredWhatsAppPhone(data.customerPhone);
    if (!phone) return;
    const msg = buildCustomerDispatchMessage({
      orderNumber: data.orderNumber || data.consignmentNumber,
      title: data.title || "طلبكم المعتمد",
      customerName: data.customerName,
      courierName: data.courierName,
      courierPhone: data.courierPhone,
      codAmount: data.codAmount,
      deliveryFee: data.deliveryFee,
      feeCollection: data.feeCollection,
    });
    openWhatsApp(phone, msg);
  }, [data]);

  const handleSendCourierWhatsApp = useCallback(() => {
    if (!data?.courierPhone) return;
    const phone = preferredWhatsAppPhone(data.courierPhone);
    if (!phone) return;
    const msg = buildCourierAssignmentMessage({
      consignmentNumber: data.consignmentNumber,
      orderNumber: data.orderNumber,
      title: data.title,
      customerName: data.customerName,
      customerPhone: data.customerPhone,
      deliveryAddress: data.deliveryAddress,
      codAmount: data.codAmount,
      deliveryFee: data.deliveryFee,
      feeCollection: data.feeCollection,
    });
    openWhatsApp(phone, msg);
  }, [data]);

  if (!open || !data) return null;

  return (
    <AnimatePresence>
      <div
        className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4"
        dir="rtl"
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 20 }}
          transition={{ type: "spring", damping: 22, stiffness: 300 }}
          className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-border/80 bg-card shadow-2xl text-card-foreground"
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={() => setIsPaused(true)}
          onMouseLeave={() => setIsPaused(false)}
        >
          {/* شريط الإغلاق التلقائي في الأعلى */}
          <div className="absolute top-0 inset-x-0 h-1 bg-muted overflow-hidden z-20">
            <div
              className="h-full bg-[var(--sem-pos)] transition-all duration-75 ease-linear"
              style={{ width: `${progress}%` }}
            />
          </div>

          {/* أزرار التحكم في الزوايا العلوية */}
          <div className="absolute top-3 left-3 z-30 flex items-center gap-1">
            <button
              type="button"
              onClick={() => setSoundEnabled(!soundEnabled)}
              className="p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              title={soundEnabled ? "كتم الصوت" : "تشغيل الصوت"}
              aria-label={soundEnabled ? "كتم الصوت" : "تشغيل الصوت"}
            >
              {soundEnabled ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              title="إغلاق"
              aria-label="إغلاق"
            >
              <X className="size-4" />
            </button>
          </div>

          {/* مشهد انطلاق سيارة التوصيل المتحركة (SVG Animation Scene) */}
          <div className="relative h-48 w-full overflow-hidden bg-gradient-to-b from-slate-900 via-slate-800 to-slate-950 flex flex-col justify-end select-none">
            {/* نجوم / أضواء ليلية في الخلفية */}
            <div className="absolute inset-0 opacity-40">
              <div className="absolute top-4 right-8 size-1 rounded-full bg-blue-300 animate-ping" />
              <div className="absolute top-8 left-16 size-1 rounded-full bg-amber-200" />
              <div className="absolute top-6 left-1/3 size-1.5 rounded-full bg-white/80" />
              <div className="absolute top-12 right-1/4 size-1 rounded-full bg-sky-200" />
            </div>

            {/* سحاب / ضباب خلفي خفيف */}
            <div className="absolute top-10 inset-x-0 flex justify-around opacity-20 pointer-events-none">
              <div className="w-28 h-6 rounded-full bg-sky-400 blur-md" />
              <div className="w-40 h-8 rounded-full bg-indigo-400 blur-lg" />
            </div>

            {/* خطوط سرعة الرياح (Speed wind streaks) */}
            {!prefersReducedMotion && (
              <div className="absolute inset-x-0 top-16 h-12 pointer-events-none overflow-hidden opacity-60">
                <motion.div
                  animate={{ x: [200, -300] }}
                  transition={{ repeat: Infinity, duration: 0.8, ease: "linear" }}
                  className="h-0.5 w-16 bg-gradient-to-l from-sky-400 to-transparent rounded-full"
                  style={{ position: "absolute", top: "25%", right: "10%" }}
                />
                <motion.div
                  animate={{ x: [250, -250] }}
                  transition={{ repeat: Infinity, duration: 0.6, ease: "linear", delay: 0.2 }}
                  className="h-0.5 w-24 bg-gradient-to-l from-white to-transparent rounded-full"
                  style={{ position: "absolute", top: "60%", right: "20%" }}
                />
              </div>
            )}

            {/* سيارة التوصيل والشحنة */}
            <div className="relative z-10 w-full flex justify-center items-end pb-3">
              <motion.div
                initial={prefersReducedMotion ? {} : { x: 120, opacity: 0 }}
                animate={prefersReducedMotion ? {} : { x: 0, opacity: 1 }}
                transition={{ type: "spring", stiffness: 180, damping: 18 }}
                className="relative"
              >
                {/* اهتزاز ميكانيكية السيارة (Chassis suspension bounce) */}
                <motion.div
                  animate={
                    prefersReducedMotion
                      ? {}
                      : {
                          y: [0, -2.5, 0, -1.5, 0],
                        }
                  }
                  transition={{
                    repeat: Infinity,
                    duration: 0.45,
                    ease: "easeInOut",
                  }}
                  className="relative"
                >
                  {/* صندوق / طرد الشحنة يقفز داخل المركبة */}
                  {!prefersReducedMotion && (
                    <motion.div
                      initial={{ y: -55, opacity: 0, scale: 0.6, rotate: -15 }}
                      animate={{ y: 0, opacity: 1, scale: 1, rotate: 0 }}
                      transition={{
                        delay: 0.25,
                        type: "spring",
                        stiffness: 320,
                        damping: 14,
                      }}
                      className="absolute right-[46px] top-[14px] z-20"
                    >
                      {/* طرد كرتوني بفيونكة وشريط لاصق */}
                      <svg width="24" height="22" viewBox="0 0 24 22" fill="none">
                        <rect x="2" y="5" width="20" height="16" rx="2" fill="#d97706" stroke="#b45309" strokeWidth="1.5" />
                        {/* شريط التغليف */}
                        <line x1="12" y1="5" x2="12" y2="21" stroke="#fde68a" strokeWidth="2.5" />
                        <line x1="2" y1="13" x2="22" y2="13" stroke="#fde68a" strokeWidth="2.5" />
                        {/* ملصق الشحنة الأبيض */}
                        <rect x="5" y="8" width="5" height="3" rx="0.5" fill="white" />
                      </svg>
                    </motion.div>
                  )}

                  {/* سحابة دخان العادم المنطلقة خلف السيارة */}
                  {!prefersReducedMotion && (
                    <div className="absolute right-[-14px] bottom-[12px] z-0 pointer-events-none">
                      <motion.div
                        animate={{
                          opacity: [0.7, 0],
                          scale: [0.5, 1.8],
                          x: [0, 24],
                          y: [0, -8],
                        }}
                        transition={{
                          repeat: Infinity,
                          duration: 0.5,
                          ease: "easeOut",
                        }}
                        className="size-3.5 rounded-full bg-slate-400/50 blur-[1px]"
                      />
                    </div>
                  )}

                  {/* هيكل سيارة التوصيل (Modern Delivery Van SVG) */}
                  <svg
                    width="190"
                    height="85"
                    viewBox="0 0 190 85"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className="drop-shadow-lg"
                  >
                    {/* مخروط ضوء الكشاف الأمامي المضيء في الظلام */}
                    <polygon
                      points="20,55 0,42 0,72"
                      fill="url(#headlightCone)"
                      opacity="0.65"
                    />

                    {/* جسم الشاحنة الرئيسي (المقصورة الخلفية للطرود) */}
                    <rect
                      x="48"
                      y="12"
                      width="100"
                      height="48"
                      rx="6"
                      fill="#0284c7"
                      stroke="#0369a1"
                      strokeWidth="2"
                    />

                    {/* الكابينة الأمامية للسائق */}
                    <path
                      d="M48 24 L28 28 C23 30 20 35 20 40 L20 60 L48 60 Z"
                      fill="#0369a1"
                      stroke="#075985"
                      strokeWidth="2"
                    />

                    {/* الزجاج الأمامي ونافذة السائق */}
                    <path
                      d="M45 28 L30 32 C27 34 25 38 25 41 L25 46 L45 46 Z"
                      fill="#bae6fd"
                      opacity="0.9"
                    />

                    {/* نافذة جانبية صغيرة */}
                    <rect x="52" y="18" width="14" height="12" rx="2" fill="#075985" />

                    {/* شعار التوصيل والسرعة على جانب الشاحنة */}
                    <g transform="translate(74, 22)">
                      <circle cx="16" cy="14" r="13" fill="#0369a1" />
                      <path
                        d="M10 14 L15 19 L23 10"
                        stroke="#f8fafc"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </g>
                    <text
                      x="106"
                      y="40"
                      fill="#f0f9ff"
                      fontSize="9"
                      fontWeight="bold"
                      fontFamily="Cairo, sans-serif"
                    >
                      توصيل سريع
                    </text>

                    {/* الصدام والمصابيح */}
                    <rect x="16" y="52" width="6" height="7" rx="1.5" fill="#facc15" />
                    <rect x="145" y="50" width="4" height="6" rx="1" fill="#ef4444" />
                    <rect x="18" y="58" width="134" height="5" rx="2" fill="#334155" />

                    {/* أقواس العجلات (Wheel arches) */}
                    <path d="M36 60 A 13 13 0 0 1 62 60" fill="#0f172a" />
                    <path d="M116 60 A 13 13 0 0 1 142 60" fill="#0f172a" />

                    {/* العجلة الأمامية الدوّارة */}
                    <g transform="translate(49, 60)">
                      <circle cx="0" cy="0" r="11" fill="#1e293b" stroke="#0f172a" strokeWidth="2" />
                      <circle cx="0" cy="0" r="6" fill="#64748b" />
                      <circle cx="0" cy="0" r="2" fill="#f8fafc" />
                      {!prefersReducedMotion && (
                        <motion.g
                          animate={{ rotate: -360 }}
                          transition={{ repeat: Infinity, duration: 0.45, ease: "linear" }}
                        >
                          <line x1="-5" y1="0" x2="5" y2="0" stroke="#f8fafc" strokeWidth="1.5" />
                          <line x1="0" y1="-5" x2="0" y2="5" stroke="#f8fafc" strokeWidth="1.5" />
                        </motion.g>
                      )}
                    </g>

                    {/* العجلة الخلفية الدوّارة */}
                    <g transform="translate(129, 60)">
                      <circle cx="0" cy="0" r="11" fill="#1e293b" stroke="#0f172a" strokeWidth="2" />
                      <circle cx="0" cy="0" r="6" fill="#64748b" />
                      <circle cx="0" cy="0" r="2" fill="#f8fafc" />
                      {!prefersReducedMotion && (
                        <motion.g
                          animate={{ rotate: -360 }}
                          transition={{ repeat: Infinity, duration: 0.45, ease: "linear" }}
                        >
                          <line x1="-5" y1="0" x2="5" y2="0" stroke="#f8fafc" strokeWidth="1.5" />
                          <line x1="0" y1="-5" x2="0" y2="5" stroke="#f8fafc" strokeWidth="1.5" />
                        </motion.g>
                      )}
                    </g>

                    {/* تدرج ضوء الكشاف الأمامي */}
                    <defs>
                      <linearGradient id="headlightCone" x1="20" y1="55" x2="0" y2="55" gradientUnits="userSpaceOnUse">
                        <stop offset="0%" stopColor="#fef08a" stopOpacity="0.8" />
                        <stop offset="100%" stopColor="#fef08a" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                  </svg>
                </motion.div>
              </motion.div>
            </div>

            {/* طريق الأسفلت وخطوط الطريق البيضاء المتقطعة المتحركة */}
            <div className="relative h-6 w-full bg-slate-950 border-t-2 border-slate-700 overflow-hidden flex items-center">
              {!prefersReducedMotion ? (
                <motion.div
                  animate={{ x: [0, -60] }}
                  transition={{ repeat: Infinity, duration: 0.35, ease: "linear" }}
                  className="flex gap-8 whitespace-nowrap w-[200%]"
                >
                  {Array.from({ length: 16 }).map((_, idx) => (
                    <div
                      key={idx}
                      className="h-1 w-8 bg-white/70 rounded-full shrink-0 shadow-sm"
                    />
                  ))}
                </motion.div>
              ) : (
                <div className="flex gap-8 whitespace-nowrap w-full">
                  {Array.from({ length: 8 }).map((_, idx) => (
                    <div
                      key={idx}
                      className="h-1 w-8 bg-white/70 rounded-full shrink-0"
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* محتوى وتفاصيل الإرسالية */}
          <div className="p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border border-[var(--sem-pos)]/40">
                    <CheckCircle2 className="size-3.5" />
                    خرج للتوصيل
                  </span>
                  <span className="font-mono text-xs text-muted-foreground font-semibold">
                    {data.consignmentNumber}
                  </span>
                </div>
                <h3 className="mt-1 text-lg font-extrabold text-foreground">
                  انطلق الطلب مع «{data.courierName}»
                </h3>
                {data.title && (
                  <p className="text-xs text-muted-foreground line-clamp-1">
                    {data.orderNumber ? `${data.orderNumber} — ` : ""}{data.title}
                  </p>
                )}
              </div>

              {/* بطاقة المبلغ المطلوب تحصيله (COD) */}
              <div className="text-start rounded-xl border border-[var(--sem-info)]/30 bg-[var(--sem-info-bg)] px-3 py-2">
                <span className="block text-[11px] font-medium text-muted-foreground">
                  التحصيل عند التسليم
                </span>
                <span className="text-base font-black text-[var(--sem-info)] tabular-nums" dir="ltr">
                  {fmt(data.codAmount)} د.ع
                </span>
              </div>
            </div>

            {/* شبكة معلومات العميل والوجهة */}
            <div className="grid grid-cols-2 gap-2.5 rounded-xl border bg-muted/40 p-3 text-xs">
              <div className="space-y-1">
                <span className="text-muted-foreground block text-[11px]">المستلم:</span>
                <div className="font-bold flex items-center gap-1">
                  <span>{data.customerName || "عميل نقدي"}</span>
                </div>
                {data.customerPhone && (
                  <div className="text-muted-foreground flex items-center gap-1" dir="ltr">
                    <Phone className="size-3 text-primary" />
                    <span>{data.customerPhone}</span>
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <span className="text-muted-foreground block text-[11px]">عنوان التوصيل:</span>
                <div className="font-medium flex items-start gap-1 text-foreground">
                  <MapPin className="size-3.5 shrink-0 text-destructive mt-0.5" />
                  <span className="line-clamp-2 leading-relaxed">
                    {data.deliveryAddress || "مقر العميل (يُحدد بالاتصال)"}
                  </span>
                </div>
              </div>
            </div>

            {/* أزرار الإجراءات السريعة (WhatsApp & Close) */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {data.customerPhone && (
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 gap-1.5 border-[var(--brand-whatsapp)] text-[var(--brand-whatsapp)] hover:bg-[var(--brand-whatsapp)]/10 font-bold text-xs h-10"
                  onClick={handleSendCustomerWhatsApp}
                  type="button"
                >
                  <WhatsAppIcon className="size-4 shrink-0" />
                  <span>إعلام العميل بالمندوب</span>
                </Button>
              )}

              {data.courierPhone && (
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 gap-1.5 border-primary/50 text-primary hover:bg-primary/10 font-bold text-xs h-10"
                  onClick={handleSendCourierWhatsApp}
                  type="button"
                >
                  <WhatsAppIcon className="size-4 shrink-0" />
                  <span>إرسال التفاصيل للمندوب</span>
                </Button>
              )}

              <Button
                variant="default"
                size="sm"
                className="gap-1.5 font-bold text-xs h-10 px-4"
                onClick={onClose}
                type="button"
              >
                <span>متابعة العمل</span>
              </Button>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
