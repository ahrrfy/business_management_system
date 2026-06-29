/**
 * useBarcodeScanner — Custom Hook لاستقبال مدخل ماسح HID.
 *
 * ماسحات الباركود USB/Bluetooth تحاكي لوحة مفاتيح (HID keyboard emulation):
 * تُرسل أحرفاً بسرعة عالية (< 80ms/حرف) ثم Enter.
 * هذا الـ hook يُفرّق بين مدخل الماسح والكتابة البشرية العادية بالتوقيت.
 *
 * النمط معتمد في: Square POS SDK، Shopify POS، WooCommerce POS.
 *
 * @param onScan  — callback يُستدعى بالنص الكامل عند اكتمال المسح
 * @param enabled — يُعطَّل عند فتح نوافذ مودال لتجنّب التعارض
 * @param minLength — الحد الأدنى لطول الباركود (افتراضي 4)
 * @param thresholdMs — الفاصل الزمني الأقصى بين أحرف الماسح (افتراضي 80ms)
 */
import { useEffect, useCallback } from "react";

const INPUT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function useBarcodeScanner(
  onScan: (raw: string) => void,
  {
    enabled = true,
    minLength = 4,
    thresholdMs = 80,
  }: { enabled?: boolean; minLength?: number; thresholdMs?: number } = {},
): void {
  // useCallback لضمان استقرار المرجع وتجنّب إعادة تسجيل event listener
  const stableOnScan = useCallback(onScan, [onScan]);

  useEffect(() => {
    if (!enabled) return;

    let buf = "";
    let lastKeyTime = 0;
    let timer: ReturnType<typeof setTimeout>;

    const reset = () => {
      buf = "";
    };

    const flush = () => {
      const captured = buf;
      buf = "";
      if (captured.length >= minLength) {
        stableOnScan(captured);
      }
    };

    const handler = (e: KeyboardEvent) => {
      const now = Date.now();
      const inField = INPUT_TAGS.has((e.target as HTMLElement).tagName);

      // Enter: لا نبتلع Enter (e.preventDefault) إلا إذا كان التسلسل الحالي ماسحاً آلياً
      // مؤكَّداً: طول كافٍ + آخر حرف وصل للتوّ (الماسح يُرسل آخر رقم ثم Enter خلال <80ms).
      // الإنسان يفرغ من الكتابة ثم يتوقّف ثم يضغط Enter لإرسال نموذج ⇒ الفاصل أكبر فلا يُسرَق.
      if (e.key === "Enter") {
        clearTimeout(timer);
        if (buf.length >= minLength && now - lastKeyTime < thresholdMs * 2) {
          e.preventDefault();
          flush();
        } else {
          reset();
        }
        return;
      }

      // تجاهل مفاتيح التحكم والوظائف والاختصارات
      if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return;

      // إن كانت الكتابة في حقل نص والمسح لم يبدأ بعد → اتركها للحقل (لا تراكم داخل الحقول).
      if (inField && buf.length === 0) return;

      const gap = now - lastKeyTime;
      lastKeyTime = now;

      // إن كان الفاصل بين حرفين أكبر من الحدّ → سرعة بشرية لا ماسح
      if (buf.length > 0 && gap > thresholdMs * 3) {
        buf = "";
      }

      buf += e.key;
      clearTimeout(timer);
      // مهلة انتهاء المسح (إن لم يأتِ Enter)
      timer = setTimeout(flush, thresholdMs * 10);
    };

    document.addEventListener("keydown", handler);
    // أي تغيّر تركيز (نقر/Tab إلى حقل أو زر) يُنهي أي تسلسل جارٍ ⇒ يمنع حمل buf المُجمَّع
    // على body عبر تغيّر التركيز فيُسرَق Enter داخل حقل/زر (انحدار «النماذج لا تُرسَل»).
    document.addEventListener("focusin", reset);
    return () => {
      document.removeEventListener("keydown", handler);
      document.removeEventListener("focusin", reset);
      clearTimeout(timer);
    };
  }, [enabled, minLength, thresholdMs, stableOnScan]);
}
