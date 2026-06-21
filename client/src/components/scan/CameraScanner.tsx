/**
 * CameraScanner — مسح QR/باركود بكاميرا الجهاز (هاتف/ويب كام).
 *
 * يستعمل BarcodeDetector (مدعوم في Chrome/Edge/Android) لفكّ الكود من بثّ الكاميرا.
 * تدهور سلس: إن لم يدعمه المتصفح أو تعذّرت الكاميرا ⇒ يعرض رسالة + إدخال يدوي للكود.
 *
 * overlay مستقلّ (لا Radix Dialog) لتفادي تعارض النوافذ المتداخلة داخل CommandPalette.
 */
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
  /** يُستدعى بالنصّ المفكوك من الكود. */
  onDetect: (code: string) => void;
}

function ManualEntry({ onSubmit }: { onSubmit: (v: string) => void }) {
  const [v, setV] = useState("");
  return (
    <form
      className="mt-4 flex w-full max-w-sm items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const t = v.trim();
        if (t) onSubmit(t);
      }}
    >
      <input
        dir="ltr"
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="أو اكتب الكود يدوياً (EMP-1 / INV-… / باركود)"
        className="h-9 flex-1 rounded-md border border-white/30 bg-white/10 px-3 text-sm text-white placeholder:text-white/50 focus:outline-none focus:ring-1 focus:ring-white/60"
      />
      <button type="submit" className="h-9 rounded-md bg-white px-3 text-sm font-medium text-black hover:bg-white/90">
        فتح
      </button>
    </form>
  );
}

export function CameraScanner({ open, onClose, onDetect }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onDetectRef = useRef(onDetect);
  onDetectRef.current = onDetect;
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    setError("");
    const AnyWin = window as any;
    const hasDetector = "BarcodeDetector" in window;

    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setError("الكاميرا غير متاحة في هذا المتصفح — استخدم ماسحاً ليزرياً أو الإدخال اليدوي.");
          return;
        }
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        // سباق: قد يُغلَق الماسح (cleanup) أثناء انتظار إذن الكاميرا ⇒ أوقف البثّ فوراً ولا تُسرّبه.
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          stream = null;
          return;
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        if (!hasDetector) {
          setError("متصفّحك لا يدعم فكّ الباركود تلقائياً — وجّه الكود واكتبه يدوياً، أو استخدم ماسحاً ليزرياً.");
          return;
        }
        const detector = new AnyWin.BarcodeDetector({
          formats: ["qr_code", "code_128", "ean_13", "ean_8", "code_39", "upc_a", "upc_e"],
        });
        const tick = async () => {
          if (stopped) return;
          const video = videoRef.current;
          if (video && video.readyState >= 2) {
            try {
              const codes = await detector.detect(video);
              if (codes && codes.length) {
                const value = String(codes[0].rawValue ?? "").trim();
                if (value) {
                  onDetectRef.current(value);
                  return;
                }
              }
            } catch {
              /* تجاهل أخطاء الإطار المفرد */
            }
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch {
        setError("تعذّر فتح الكاميرا — تأكّد من منح الإذن، أو استخدم الإدخال اليدوي.");
      }
    }
    void start();

    return () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black/90 p-4" dir="rtl">
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 left-4 rounded-full p-1.5 text-white/80 hover:bg-white/10 hover:text-white"
        aria-label="إغلاق"
      >
        <X className="size-6" />
      </button>
      <div className="mb-3 text-sm text-white">وجّه الكاميرا نحو الباركود / رمز QR</div>
      <video
        ref={videoRef}
        className="max-h-[60vh] max-w-full rounded-lg border border-white/20"
        playsInline
        muted
      />
      {error && <div className="mt-3 max-w-sm text-center text-sm text-amber-300">{error}</div>}
      <ManualEntry onSubmit={(v) => onDetectRef.current(v)} />
    </div>
  );
}
