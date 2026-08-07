import { useCallback, useRef } from "react";

/** الفاصل الأقصى (مي‌ث) بين حرفين ليُصنَّفا مسحاً آلياً بدل كتابة بشرية — نمط useBarcodeScanner. */
const SCAN_MS = 80;

/**
 * useSmartScanInput — كشف مسح باركود داخل حقل بحثٍ مركَّز عبر توقيت الحرف نفسه (لا عبر استقرار
 * استعلام البحث المؤجَّل). كل ضغطة تُقاس بفاصلها عن سابقتها *في نفس هذا الحقل*؛ فاصلٌ < 80مي‌ث
 * يعني ماسحاً فيُبتلَع الحرفان في مخزنٍ محليّ ويُستدعى `onBarcode` بمطابقةٍ دقيقة (لا نتيجة بحثٍ
 * تقريبية أولى) عند Enter أو بعد سكونٍ قصير — هذا يتفادى السباق مع debounce البحث النصّي كلياً:
 * ماسحٌ حقيقي يرسل Enter خلال عشرات المي‌ث من آخر رقم، أسرع من أي استقرارٍ للبحث المؤجَّل (١٨٠مي‌ث)،
 * فالاعتماد على استقرار البحث وحده (نمط searchSettled) يُسقط أغلب المسحات الحقيقية صامتاً.
 *
 * منقولة من POS.tsx (نقطة البيع الرئيسية) — الأصل هناك بصفر تغيير سلوكي؛ الاستخراج يتيح إعادة
 * الاستعمال في شاشة الاستقبال (Reception.tsx) التي كانت تعتمد على searchSettled وحدها.
 */
export function useSmartScanInput(onBarcode: (code: string) => Promise<void>) {
  const prevMsRef  = useRef(0);
  const bufRef     = useRef("");
  const inScanRef  = useRef(false);
  const timerRef   = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const fire = useCallback(
    (setValue: (s: string) => void) => {
      clearTimeout(timerRef.current);
      const code = bufRef.current;
      bufRef.current = "";
      inScanRef.current = false;
      if (code.length >= 4) {
        setValue("");
        onBarcode(code);
      } else {
        // إدخال بشري قصير أُسيء تصنيفه كمسح (نقرتان سريعتان <٨٠مي، وليس باركوداً ≥٤ خانات) —
        // أعِد النصّ المكتوب بدل ابتلاعه صامتاً. لا يمسّ مسار المسح الحقيقي إطلاقاً (≥٤ يُمسح ويُبحث كالسابق).
        setValue(code);
      }
    },
    [onBarcode]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, curVal: string, setValue: (s: string) => void) => {
      const now = Date.now();
      const prevMs = prevMsRef.current;
      prevMsRef.current = now;
      const gap = now - prevMs;

      if (e.key === "Enter") {
        clearTimeout(timerRef.current);
        if (inScanRef.current && bufRef.current.length >= 4) {
          e.preventDefault();
          fire(setValue);
        }
        return;
      }
      if (e.key === "Escape") {
        clearTimeout(timerRef.current);
        bufRef.current = "";
        inScanRef.current = false;
        return;
      }
      if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return;

      if (inScanRef.current) {
        e.preventDefault();
        bufRef.current += e.key;
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => fire(setValue), SCAN_MS * 6);
        return;
      }

      if (prevMs > 0 && gap < SCAN_MS) {
        e.preventDefault();
        bufRef.current = curVal + e.key;
        inScanRef.current = true;
        setValue("");
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => fire(setValue), SCAN_MS * 6);
      }
    },
    [fire]
  );

  return { handleKeyDown };
}
