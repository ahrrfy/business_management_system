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
 * @param minLength — الحد الأدنى لطول الباركود (افتراضي 3؛ بعض رموز الموردين الداخلية قصيرة)
 * @param thresholdMs — الفاصل الزمني الأقصى بين أحرف الماسح (افتراضي 80ms)
 */
import { useEffect, useCallback } from "react";
import { normalizeBarcodeScannerInput } from "@/lib/barcodeScannerInput";

const INPUT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function useBarcodeScanner(
  onScan: (raw: string) => void,
  {
    enabled = true,
    minLength = 2,
    thresholdMs = 60,
  }: { enabled?: boolean; minLength?: number; thresholdMs?: number } = {},
): void {
  // useCallback لضمان استقرار المرجع وتجنّب إعادة تسجيل event listener
  const stableOnScan = useCallback(onScan, [onScan]);

  useEffect(() => {
    if (!enabled) return;

    let buf = "";
    let lastKeyTime = 0;
    let timer: ReturnType<typeof setTimeout>;

    // تتبع نبضات الماسح السريعة داخل حقول الإدخال النصية
    let inFieldBurst = false;
    let fieldCandidateBuf = "";
    let fieldTarget: HTMLInputElement | HTMLTextAreaElement | null = null;
    let fieldValBeforeBurst = "";

    const reset = () => {
      buf = "";
      inFieldBurst = false;
      fieldCandidateBuf = "";
      fieldTarget = null;
      fieldValBeforeBurst = "";
    };

    const flush = () => {
      const captured = buf;
      reset();
      if (captured.length >= minLength) {
        stableOnScan(normalizeBarcodeScannerInput(captured));
      }
    };

    const handler = (e: KeyboardEvent) => {
      const now = Date.now();
      const target = e.target as HTMLElement | null;
      const inField = target != null && INPUT_TAGS.has(target.tagName);

      // Enter: لا نبتلع Enter إلا إذا كان التسلسل الحالي ماسحاً آلياً مؤكداً
      if (e.key === "Enter") {
        clearTimeout(timer);
        if (buf.length >= minLength && now - lastKeyTime < thresholdMs * 3) {
          e.preventDefault();
          e.stopPropagation();
          flush();
        } else {
          reset();
        }
        return;
      }

      // تجاهل مفاتيح التحكم والوظائف والاختصارات
      if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return;

      const gap = lastKeyTime > 0 ? now - lastKeyTime : 9999;
      lastKeyTime = now;

      // الحالة 1: خارج أي حقل إدخال (الالتقاط التلقائي السلس في أي مكان بالشاشة)
      if (!inField) {
        if (buf.length > 0 && gap > thresholdMs * 3) {
          buf = "";
        }
        buf += e.key;
        clearTimeout(timer);
        timer = setTimeout(flush, thresholdMs * 10);
        return;
      }

      // الحالة 2: داخل حقل إدخال نصي — اعتراض ذكي لمنع تلوث الحقل
      const inputEl = target as HTMLInputElement | HTMLTextAreaElement;

      // إذا كنا في خضم نبضة ماسح جارية: اعترض كل حرف فورا
      if (inFieldBurst) {
        e.preventDefault();
        e.stopPropagation();
        buf += e.key;
        clearTimeout(timer);
        timer = setTimeout(flush, thresholdMs * 10);
        return;
      }

      // قياس الفارق الزمني: الماسح يرسل الأحرف بسرعة فائقة (< 50ms)
      if (gap <= thresholdMs) {
        fieldCandidateBuf += e.key;
        // الماسح الآلي يتجاوز حرفين بفاصل زمني فائق السرعة
        if (fieldCandidateBuf.length >= 2) {
          inFieldBurst = true;
          e.preventDefault();
          e.stopPropagation();
          // استعادة القيمة الأصلية للحقل قبل بدء تسرب أحرف الماسح
          if (fieldTarget && fieldTarget === inputEl) {
            inputEl.value = fieldValBeforeBurst;
            inputEl.dispatchEvent(new Event("input", { bubbles: true }));
          }
          buf = fieldCandidateBuf;
          clearTimeout(timer);
          timer = setTimeout(flush, thresholdMs * 10);
          return;
        }
      } else {
        // كتابة بشرية عادية: تسجيل القيمة الحالية والفاصل الطبيعي
        fieldCandidateBuf = e.key;
        fieldTarget = inputEl;
        fieldValBeforeBurst = inputEl.value;
      }
    };

    // useCapture: التقاط الأحداث عند النزول قبل وصولها لعناصر DOM لتأمين اعتراض Enter والنبضات
    document.addEventListener("keydown", handler, true);
    document.addEventListener("focusin", reset);
    return () => {
      document.removeEventListener("keydown", handler, true);
      document.removeEventListener("focusin", reset);
      clearTimeout(timer);
    };
  }, [enabled, minLength, thresholdMs, stableOnScan]);
}
