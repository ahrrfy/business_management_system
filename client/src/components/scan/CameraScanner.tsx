/**
 * CameraScanner — ماسح باركود/QR بكاميرا الهاتف.
 *
 * يبدأ بمحرّك BarcodeDetector الأصلي حيث يتاح، ثم يستخدم ZXing تلقائياً في
 * Safari/iOS والمتصفحات التي لا تدعمه. لا تُرسل صور الكاميرا إلى الخادم.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CameraOff, Flashlight, FlashlightOff, ScanLine, X } from "lucide-react";
import { normalizeBarcodeScannerInput } from "@/lib/barcodeScannerInput";
import { dispatchManualCameraEntry } from "./cameraScannerLifecycle";

interface Props {
  open: boolean;
  onClose: () => void;
  /** يُستدعى بالنص المفكوك من الباركود أو QR. */
  onDetect: (code: string) => void;
  /** الإدخال المكتوب ليس دليلاً من الكاميرا؛ المستدعي المحاسبي يميّزه صراحةً. */
  onManualDetect?: (code: string) => void;
  /**
   * إبقاء الكاميرا مفتوحةً بعد كلّ مسحٍ ناجح لتمكين دورة «امسح ثمّ التالي» بلا إعادة فتح.
   * الافتراضي `false` للتوافق مع الاستدعاءات القائمة التي تتوقّع الإغلاق التلقائيّ.
   * حين تُفعَّل، يُطبَّق زمن تبريدٍ بين المسحات (`cooldownMs`) لمنع نفس الباركود من الإطلاق
   * مرّاتٍ متتاليةً بلا فائدة.
   */
  keepOpen?: boolean;
  /** زمنُ تبريدٍ بين مسحات `keepOpen` (بالميلي ثانية). الافتراضي ١٥٠٠ (ثلاث ثوانٍ نصفَين). */
  cooldownMs?: number;
}

type FallbackControls = {
  stop: () => void;
  switchTorch?: (on: boolean) => Promise<void>;
};

type NativeBarcodeDetector = {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>;
};

type NativeBarcodeDetectorCtor = new (options: { formats: string[] }) => NativeBarcodeDetector;

function cameraErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "لم يُسمح باستخدام الكاميرا. افتح إعدادات المتصفح واسمح بالكاميرا لهذا الموقع ثم حاول مجدداً.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "لم نعثر على كاميرا خلفية مناسبة. جرّب إغلاق التطبيقات الأخرى التي تستخدم الكاميرا.";
  }
  return "تعذّر تشغيل الماسح. تأكّد من فتح الرابط عبر HTTPS ومن منح إذن الكاميرا.";
}

function ManualEntry({ onSubmit }: { onSubmit: (value: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="flex w-full items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const code = normalizeBarcodeScannerInput(value);
        if (code) onSubmit(code);
      }}
    >
      {/* text-base (لا text-sm) لتجنّب auto-zoom في Safari iOS عند التركيز على الحقل.
          h-11 كي يبلغ معيارَ اللمس ٤٤px.
          inputMode="text" مقصود (Codex P2): باركودات Code39/Code128 و`ALR*` الداخليّ
          أبجديّة-عدديّة معتمَدة في `shared/barcodeSymbology.ts`؛ لوحةٌ رقميّةٌ فقط تمنع
          إدخالها يدوياً. النصّ يقبل كليهما بلا فقد التلميح اللمسيّ. */}
      <input
        dir="ltr"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="اكتب رقم الباركود يدوياً"
        inputMode="text"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        className="h-11 flex-1 rounded-lg border border-white/30 bg-white/10 px-3 text-base text-white placeholder:text-white/55 focus:outline-none focus:ring-2 focus:ring-white/60"
      />
      <button type="submit" className="h-11 rounded-lg bg-white px-5 text-sm font-bold text-black active:bg-white/90">
        فتح
      </button>
    </form>
  );
}

export function CameraScanner({ open, onClose, onDetect, onManualDetect, keepOpen = false, cooldownMs = 1500 }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onDetectRef = useRef(onDetect);
  const onManualDetectRef = useRef(onManualDetect ?? onDetect);
  const controlsRef = useRef<FallbackControls | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectedRef = useRef(false);
  const lastCodeRef = useRef<string | null>(null);
  const cooldownTimerRef = useRef<number | null>(null);
  const keepOpenRef = useRef(keepOpen);
  const cooldownMsRef = useRef(cooldownMs);
  onDetectRef.current = onDetect;
  onManualDetectRef.current = onManualDetect ?? onDetect;
  keepOpenRef.current = keepOpen;
  cooldownMsRef.current = cooldownMs;

  const [error, setError] = useState("");
  const [engine, setEngine] = useState<"starting" | "native" | "zxing">("starting");
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const stopMedia = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setTorchAvailable(false);
    setTorchOn(false);
  }, []);

  const deliver = useCallback(
    (raw: string) => {
      const code = raw.trim();
      if (!code || detectedRef.current) return;
      // في وضع «الاستمرار» نُبقي الكاميرا مفتوحة، ونمنع التكرار بزمن تبريدٍ لا بالإغلاق.
      // ولمنع الباركود ذاته من الإطلاق مرّاتٍ متتالية حين يظلّ في الإطار: نفس الرمز
      // خلال نافذة التبريد يُتجاهَل، ورمزٌ آخر يعمل فوراً (الحقل معدّ لدورة سريعة).
      if (keepOpenRef.current) {
        if (lastCodeRef.current === code && cooldownTimerRef.current != null) return;
        detectedRef.current = true;
        lastCodeRef.current = code;
        if (cooldownTimerRef.current != null) window.clearTimeout(cooldownTimerRef.current);
        cooldownTimerRef.current = window.setTimeout(() => {
          detectedRef.current = false;
          cooldownTimerRef.current = null;
        }, Math.max(400, cooldownMsRef.current));
        onDetectRef.current(code);
        return;
      }
      detectedRef.current = true;
      stopMedia();
      onDetectRef.current(code);
    },
    [stopMedia],
  );

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let nativeRaf = 0;
    detectedRef.current = false;
    lastCodeRef.current = null;
    if (cooldownTimerRef.current != null) {
      window.clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }
    setError("");
    setEngine("starting");

    const stop = () => {
      if (nativeRaf) cancelAnimationFrame(nativeRaf);
      stopMedia();
    };

    const setTorchCapability = (stream: MediaStream | null) => {
      const track = stream?.getVideoTracks()[0];
      const capabilities = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
      setTorchAvailable(Boolean(capabilities.torch));
    };

    const startNative = async (Detector: NativeBarcodeDetectorCtor) => {
      // بعض المتصفحات تعرض BarcodeDetector لكنها لا تقبل جميع الصيغ؛ ننشئه
      // أولاً حتى نستطيع الانتقال إلى ZXing قبل حجز الكاميرا عند حدوث ذلك.
      const detector = new Detector({
        formats: ["code_128", "code_39", "code_93", "codabar", "ean_13", "ean_8", "itf", "upc_a", "upc_e", "qr_code"],
      });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      if (stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      setTorchCapability(stream);
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      setEngine("native");
      const scanFrame = async () => {
        if (stopped) return;
        // في وضع `keepOpen` نُبقي الحلقةَ حيّةً أثناء التبريد بدل موتها بعد أوّل رصد.
        // قبل الإصلاح: `if (stopped || detectedRef.current) return;` كان يوقف الجدولة
        // نهائياً على أوّل رصد، فيبدو الماسح مفتوحاً على الشاشة لكنه ميّت — الجذر: مراجعة
        // Codex P2 على PR #776 (٢٥/٨) — وضع `keepOpen` كان بلا أثرٍ على المسار الأصليّ.
        if (detectedRef.current) {
          if (keepOpenRef.current) nativeRaf = requestAnimationFrame(scanFrame);
          return;
        }
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          try {
            const codes = await detector.detect(video);
            const value = codes[0]?.rawValue;
            if (value) {
              deliver(value);
              // اللقطةُ الواحدة تموت بعد deliver (يستدعي stopMedia)، والمستمرّ يعيد الجدولة.
              if (!keepOpenRef.current) return;
            }
          } catch {
            // إطار غير صالح أو ضبابي؛ نستمر حتى يستقر التركيز.
          }
        }
        nativeRaf = requestAnimationFrame(scanFrame);
      };
      nativeRaf = requestAnimationFrame(scanFrame);
    };

    const startFallback = async () => {
      const { BrowserMultiFormatReader } = await import("@zxing/browser");
      if (stopped || !videoRef.current) return;
      const reader = new BrowserMultiFormatReader(undefined, {
        delayBetweenScanAttempts: 90,
        delayBetweenScanSuccess: 250,
      });
      const controls = await reader.decodeFromConstraints(
        {
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        },
        videoRef.current,
        (result) => {
          if (result) deliver(result.getText());
        },
      );
      if (stopped) {
        controls.stop();
        return;
      }
      controlsRef.current = controls;
      streamRef.current = videoRef.current?.srcObject instanceof MediaStream ? videoRef.current.srcObject : null;
      setTorchCapability(streamRef.current);
      setEngine("zxing");
    };

    const start = async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setError("يتطلب المسح بالكاميرا رابطاً آمناً (HTTPS) ومتصفحاً يدعم الكاميرا.");
        return;
      }
      try {
        const Detector = (window as Window & { BarcodeDetector?: NativeBarcodeDetectorCtor }).BarcodeDetector;
        if (Detector) {
          try {
            await startNative(Detector);
            return;
          } catch (nativeError) {
            // لا نكرر طلب الإذن، لكن ندعم المتصفحات التي تعلن BarcodeDetector
            // ثم تفشل في تهيئته أو في أحد صيغ الباركود المطلوبة.
            const name = nativeError instanceof DOMException ? nativeError.name : "";
            if (["NotAllowedError", "SecurityError", "NotFoundError", "OverconstrainedError"].includes(name)) {
              throw nativeError;
            }
            stopMedia();
          }
        }
        await startFallback();
      } catch (scanError) {
        if (!stopped) setError(cameraErrorMessage(scanError));
      }
    };

    void start();
    return () => {
      stopped = true;
      stop();
      if (cooldownTimerRef.current != null) {
        window.clearTimeout(cooldownTimerRef.current);
        cooldownTimerRef.current = null;
      }
    };
  }, [deliver, open, stopMedia]);

  const toggleTorch = async () => {
    try {
      const next = !torchOn;
      if (controlsRef.current?.switchTorch) await controlsRef.current.switchTorch(next);
      else {
        const track = streamRef.current?.getVideoTracks()[0];
        if (!track) return;
        await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      }
      setTorchOn(next);
    } catch {
      notifyTorchUnsupported();
    }
  };

  const notifyTorchUnsupported = () => {
    setTorchAvailable(false);
    setTorchOn(false);
  };

  if (!open) return null;
  return (
    // ٢٩/٨: `dvh` بدل `vh` كي يعمل ارتفاعُ الشاشة الفعليّ على iOS (شريط عناوين ديناميكيّ)،
    // و`env(safe-area-inset-*)` كي لا يتخفّى زرّ الإغلاق تحت الـnotch ولا يُقصّ الحقلُ اليدويّ
    // تحت الشريط السفليّ / الهوم-إنديكيتور. الحاويةُ استعملَت `justify-center` سابقاً فكان
    // المحتوى يفلت إلى الحواف حين تفتح لوحةُ المفاتيح؛ الآن `justify-start` مع sm:justify-center
    // على الشاشات الأوسع فالمحتوى يبقى مرئياً على iPhone حين تظهر لوحة المفاتيح.
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center bg-black/95 dir-rtl px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] justify-start gap-3 overflow-y-auto sm:justify-center"
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-label="مسح الباركود بالكاميرا"
      style={{ minHeight: "100dvh" }}
    >
      {/* شريطُ رأسٍ ثابتٌ بمقدار الـsafe-area كي تصل يدُ المستخدم إلى «إغلاق» بلا عناء
          على iPhone (زرّ 44×44 يحترم معيار اللمس). العنوان في الوسط لتوازن بصريّ.*/}
      <div className="flex w-full items-center justify-between text-white">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex size-11 items-center justify-center rounded-full text-white/90 active:bg-white/15"
          aria-label="إغلاق الماسح"
        >
          <X className="size-6" />
        </button>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ScanLine className="size-4" /> وجّه الباركود داخل الإطار
        </div>
        <span className="size-11" aria-hidden />
      </div>
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/25 bg-black">
        <video ref={videoRef} className="block max-h-[52vh] w-full object-cover" playsInline muted />
        <div className="pointer-events-none absolute inset-[12%] rounded-xl border-2 border-white/80 shadow-[0_0_0_999px_rgba(0,0,0,0.28)]" />
        <div className="pointer-events-none absolute inset-x-[16%] top-1/2 h-0.5 bg-primary shadow-[0_0_16px_rgba(255,255,255,0.9)]" />
        {torchAvailable && (
          <button
            type="button"
            onClick={() => void toggleTorch()}
            className="absolute bottom-3 left-3 rounded-full bg-black/65 p-3 text-white backdrop-blur active:bg-black/85"
            aria-label={torchOn ? "إطفاء فلاش الكاميرا" : "تشغيل فلاش الكاميرا"}
          >
            {torchOn ? <FlashlightOff className="size-5" /> : <Flashlight className="size-5" />}
          </button>
        )}
      </div>
      {error ? (
        <div className="flex max-w-md items-start gap-2 rounded-xl border border-white/20 bg-white/10 p-3 text-center text-sm leading-relaxed text-white">
          <CameraOff className="mt-0.5 size-4 shrink-0" /> {error}
        </div>
      ) : (
        // نصٌّ صغيرٌ بأيقونةٍ توضّح المسارَ الحاليّ للقارئ. «متوافق مع iPhone» كان يوهم أنّه
        // مسارٌ فاشل فيصبح عبئاً بصرياً. النصّ الجديد فعليّ: يقول ما يعمل، لا هوامش تقنية.
        <p className="text-center text-xs text-white/70">
          {engine === "starting"
            ? "جارٍ فتح الكاميرا…"
            : engine === "zxing"
              ? "الكاميرا تعمل — مرّر الباركود داخل الإطار"
              : "الكاميرا جاهزة — وجّه الباركود"}
        </p>
      )}
      {/* الفصل البصريّ عبر borderTop خفيف يميّز منطقة الإدخال اليدويّ عن الكاميرا،
          فلا يظنّ المستخدم أنّ الحقلَ جزءٌ من إطار المسح. */}
      <div className="mt-1 w-full max-w-md border-t border-white/10 pt-3">
        <ManualEntry
          onSubmit={(code) => {
            dispatchManualCameraEntry(code, {
              deliver,
              stopMedia,
              manual: onManualDetectRef.current,
              hasManualOverride: onManualDetect != null,
            });
          }}
        />
      </div>
    </div>
  );
}
