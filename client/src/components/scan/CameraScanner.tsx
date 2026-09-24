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

type NativeBarcodeDetectorCtor = {
  new (options?: { formats?: string[] }): NativeBarcodeDetector;
  getSupportedFormats?: () => Promise<string[]>;
};

async function applyCameraEnhancements(stream: MediaStream): Promise<void> {
  const track = stream.getVideoTracks()[0];
  if (!track || typeof track.applyConstraints !== "function") return;
  try {
    const capabilities = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & {
      focusMode?: string[];
      torch?: boolean;
    };
    const advanced: MediaTrackConstraintSet = {};
    if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes("continuous")) {
      (advanced as Record<string, unknown>).focusMode = "continuous";
    }
    if (Object.keys(advanced).length > 0) {
      await track.applyConstraints({ advanced: [advanced] });
    }
  } catch {
    // تجاهل إخفاق تطبيق التركيز التلقائي إن لم يكن مدعوماً في الجهاز
  }
}

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
    let ownedStream: MediaStream | null = null;
    let ownedControls: FallbackControls | null = null;
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
      ownedControls?.stop();
      ownedStream?.getTracks().forEach((track) => track.stop());
      if (controlsRef.current === ownedControls) controlsRef.current = null;
      if (streamRef.current === ownedStream) {
        streamRef.current = null;
        if (videoRef.current?.srcObject === ownedStream) videoRef.current.srcObject = null;
      }
      setTorchAvailable(false);
      setTorchOn(false);
    };

    const setTorchCapability = (stream: MediaStream | null) => {
      const track = stream?.getVideoTracks()[0];
      const capabilities = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
      setTorchAvailable(Boolean(capabilities.torch));
    };

    const startNative = async (Detector: NativeBarcodeDetectorCtor) => {
      // قائمة الصيغ المعتمدة لباركودات المنتجات والتجزئة والرموز المربعة
      const desiredFormats = [
        "qr_code",
        "ean_13",
        "ean_8",
        "code_128",
        "code_39",
        "code_93",
        "upc_a",
        "upc_e",
        "itf",
        "codabar",
        "data_matrix",
      ];
      let activeFormats = desiredFormats;
      if (typeof Detector.getSupportedFormats === "function") {
        try {
          const supported = await Detector.getSupportedFormats();
          if (Array.isArray(supported) && supported.length > 0) {
            // نأخذ تقاطع الصيغ المدعومة في المتصفح الفعلي بدلاً من رمي خطأ وإسقاط المحرك
            const matched = desiredFormats.filter((format) => supported.includes(format));
            if (matched.length > 0) {
              activeFormats = matched;
            }
          }
        } catch {
          // في حال تعذر فحص الصيغ المدعومة نتابع بالصيغ الأساسية
        }
      }
      if (stopped) return;
      const detector = new Detector({ formats: activeFormats });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { min: 640, ideal: 1280, max: 1920 },
          height: { min: 480, ideal: 720, max: 1080 },
        },
      });
      if (stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      await applyCameraEnhancements(stream);
      ownedStream = stream;
      streamRef.current = stream;
      setTorchCapability(stream);
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // تجاهل أخطاء التشغيل عند إلغاء الحوار
      }
      if (stopped) return;
      setEngine("native");
      let failedFrames = 0;
      let isDetecting = false;
      const scanFrame = async () => {
        if (stopped) return;
        // في وضع `keepOpen` نُبقي الحلقةَ حيّةً أثناء التبريد بدل موتها بعد أوّل رصد.
        if (detectedRef.current) {
          if (keepOpenRef.current) nativeRaf = requestAnimationFrame(scanFrame);
          return;
        }
        const currentVideo = videoRef.current;
        if (!currentVideo) return;

        if (
          currentVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          currentVideo.videoWidth > 0 &&
          currentVideo.videoHeight > 0 &&
          !isDetecting
        ) {
          isDetecting = true;
          try {
            const codes = await detector.detect(currentVideo);
            if (stopped) return;
            failedFrames = 0;
            const valid = codes.find((code) => Boolean(code.rawValue && code.rawValue.trim()));
            if (valid?.rawValue) {
              deliver(valid.rawValue);
              // اللقطةُ الواحدة تموت بعد deliver (يستدعي stopMedia)، والمستمرّ يعيد الجدولة.
              if (!keepOpenRef.current) return;
            }
          } catch {
            if (stopped) return;
            // أخطاء المحرك المتكررة ليست إطاراً ضبابياً؛ انتقل إلى القارئ البديل.
            if (++failedFrames >= 5) {
              stop();
              try { await startFallback(); }
              catch (error) {
                if (!stopped) {
                  stop();
                  setError(cameraErrorMessage(error));
                }
              }
              return;
            }
          } finally {
            isDetecting = false;
          }
        }
        nativeRaf = requestAnimationFrame(scanFrame);
      };
      nativeRaf = requestAnimationFrame(scanFrame);
    };

    const startFallback = async () => {
      const [{ BrowserMultiFormatReader }, { DecodeHintType, BarcodeFormat }] = await Promise.all([
        import("@zxing/browser"),
        import("@zxing/library"),
      ]);
      if (stopped || !videoRef.current) return;

      const hints = new Map<any, any>();
      hints.set(DecodeHintType.TRY_HARDER, true);
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.QR_CODE,
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
        BarcodeFormat.CODE_128,
        BarcodeFormat.CODE_39,
        BarcodeFormat.CODE_93,
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E,
        BarcodeFormat.ITF,
        BarcodeFormat.CODABAR,
        BarcodeFormat.DATA_MATRIX,
      ]);

      const reader = new BrowserMultiFormatReader(hints, {
        delayBetweenScanAttempts: 100,
        delayBetweenScanSuccess: 300,
      });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { min: 640, ideal: 1280, max: 1920 },
          height: { min: 480, ideal: 720, max: 1080 },
        },
      });
      if (stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      await applyCameraEnhancements(stream);
      ownedStream = stream;
      streamRef.current = stream;
      const controls = await reader.decodeFromStream(
        stream, videoRef.current,
        (result, _error, callbackControls) => {
          if (stopped || (detectedRef.current && !keepOpenRef.current)) {
            callbackControls.stop();
            return;
          }
          if (result) {
            const text = result.getText();
            if (text && text.trim()) {
              deliver(text);
              if (!keepOpenRef.current) callbackControls.stop();
            }
          }
        },
      );
      if (stopped || (detectedRef.current && !keepOpenRef.current)) {
        controls.stop();
        return;
      }
      ownedControls = controls;
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
            stop();
          }
        }
        await startFallback();
      } catch (scanError) {
        if (!stopped) {
          stop();
          setError(cameraErrorMessage(scanError));
        }
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
        <video ref={videoRef} className="block max-h-[52vh] w-full object-cover" playsInline muted autoPlay />
        {/* إطار التحديد البصري المعتم للحواف */}
        <div className="pointer-events-none absolute inset-[12%] rounded-xl border border-white/40 shadow-[0_0_0_999px_rgba(0,0,0,0.35)]" />
        {/* زوايا إطار التوجيه الملونة لتسهيل محاذاة الباركود */}
        <div className="pointer-events-none absolute inset-[12%]">
          <div className="absolute -top-0.5 -right-0.5 size-6 rounded-tr-lg border-t-4 border-r-4 border-primary" />
          <div className="absolute -top-0.5 -left-0.5 size-6 rounded-tl-lg border-t-4 border-l-4 border-primary" />
          <div className="absolute -bottom-0.5 -right-0.5 size-6 rounded-br-lg border-b-4 border-r-4 border-primary" />
          <div className="absolute -bottom-0.5 -left-0.5 size-6 rounded-bl-lg border-b-4 border-l-4 border-primary" />
        </div>
        {/* مؤشر خط الليزر المتحرك للدلالة على فاعلية المسح */}
        <div className="pointer-events-none absolute inset-x-[14%] top-1/2 h-0.5 bg-primary shadow-[0_0_16px_rgba(255,255,255,0.9)] animate-pulse" />
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
