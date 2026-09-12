/** التقاط قارئ الباركود داخل input: ومضةٌ سريعة ثم Enter، مع إبقاء الكتابة البشرية كما هي.
 *
 * يفوّض كلّ منطق التوقيت والفكّ الفيزيائيّ (المستقلّ عن تخطيط لوحة المفاتيح) إلى `ScanBurstDetector`
 * الموحَّد — فلا ينجرف عن الخطّاف العالميّ ولا خطّاف الكاشير، ويرث تصحيح الرموز العربية والمناعة
 * لتذبذب التوقيت. راجع `client/src/lib/barcodeScanTiming.ts`.
 */
import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { ScanBurstDetector } from "@/lib/barcodeScanTiming";

type SetInputValue = (value: string) => void;

export const DEFAULT_BARCODE_INPUT_MIN_LENGTH = 3;
export function barcodeInputAcceptsScan(raw: string, minLength = DEFAULT_BARCODE_INPUT_MIN_LENGTH): boolean {
  return raw.length >= minLength;
}

export function useBarcodeInput(
  onScan: (code: string) => void,
  {
    enabled = true,
    // باركودات الموردين الداخلية قد تكون من 3 محارف (مثل B1X). أقلّ من ذلك يبقى
    // كتابةً بشرية لتجنّب سرقة Enter من حقول البحث والنماذج.
    minLength = DEFAULT_BARCODE_INPUT_MIN_LENGTH,
    thresholdMs = 80,
  }: { enabled?: boolean; minLength?: number; thresholdMs?: number } = {},
) {
  const onScanRef = useRef(onScan);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  onScanRef.current = onScan;

  // كاشفٌ مستقرّ لكلّ تركيبة خيارات؛ يُعاد بناؤه فقط عند تغيّرها (نادر، لا يقع وسط مسح).
  const detector = useMemo(
    () => new ScanBurstDetector({ minLength, intraGapMs: thresholdMs }),
    [minLength, thresholdMs],
  );

  const reset = useCallback(() => {
    clearTimeout(timerRef.current);
    detector.reset();
  }, [detector]);

  const flush = useCallback((setValue: SetInputValue) => {
    clearTimeout(timerRef.current);
    const { accepted, code, text } = detector.flush();
    if (accepted && barcodeInputAcceptsScan(code, minLength)) {
      setValue("");
      onScanRef.current(code);
    } else if (text) {
      // تسلسلٌ بشريٌّ قصير صُنّف سريعاً بالخطأ: لا نبتلعه — نعيد الحروف الخام.
      setValue(text);
    }
  }, [detector, minLength]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>, setValue: SetInputValue) => {
    if (!enabled) return;

    if (event.key === "Enter") {
      if (detector.isActive && detector.length >= minLength) {
        event.preventDefault();
        flush(setValue);
      } else {
        reset();
      }
      return;
    }
    if (event.key === "Escape") {
      reset();
      return;
    }
    // نقبل طول 1 أو 2: تخطيط عربي 101 يُنتج «لا/لأ/لآ» بحرفَين لضغطةٍ واحدة؛ الفكّ الفيزيائيّ
    // (event.code) يعيدها إلى ASCII بصرف النظر عن ذلك.
    if (event.ctrlKey || event.altKey || event.metaKey || event.key.length < 1 || event.key.length > 2) return;

    const action = detector.feed({ code: event.code, key: event.key, shiftKey: event.shiftKey }, Date.now());
    if (action === "pass") return; // حرفٌ مرشّح: يظهر في الحقل طبيعياً (كتابةٌ بشرية محتملة)
    event.preventDefault();
    if (action === "startBurst") setValue(""); // امسح الحرف المرشّح المتسرّب قبل تجميع الومضة
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => flush(setValue), Math.max(250, Math.min(thresholdMs * 6, 600)));
  }, [enabled, flush, minLength, reset, detector, thresholdMs]);

  useEffect(() => reset, [reset]);

  return { handleKeyDown, reset };
}
