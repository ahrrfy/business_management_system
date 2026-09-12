/** التقاط قارئ الباركود داخل input: ومضةٌ سريعة ثم Enter، مع إبقاء الكتابة البشرية كما هي.
 *
 * يفوّض كلّ منطق التوقيت والفكّ الفيزيائيّ (المستقلّ عن تخطيط لوحة المفاتيح) إلى `ScanBurstDetector`
 * الموحَّد — فلا ينجرف عن الخطّاف العالميّ ولا خطّاف الكاشير، ويرث تصحيح الرموز العربية والمناعة
 * لتذبذب التوقيت. راجع `client/src/lib/barcodeScanTiming.ts`.
 *
 * صون البحث القائم (ملاحظتا مراجعة #1107): نتتبّع **بادئة** الحقل (قيمته قبل الحرف المرشّح)، فحين
 * تنكسر الومضة قصيرةً (كتابةٌ بشرية) نستعيد **البادئة + الحروف الخام** بدل مسحها — سواءٌ عند السكون
 * أو عند Enter.
 */
import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { ScanBurstDetector, resolveScanSettle } from "@/lib/barcodeScanTiming";

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
  // قيمة الحقل قبل الحرف المرشّح الحاليّ — تُستعاد إن انكسرت الومضة قصيرة.
  const prefixRef = useRef("");
  onScanRef.current = onScan;

  // كاشفٌ مستقرّ لكلّ تركيبة خيارات؛ يُعاد بناؤه فقط عند تغيّرها (نادر، لا يقع وسط مسح).
  const detector = useMemo(
    () => new ScanBurstDetector({ minLength, intraGapMs: thresholdMs }),
    [minLength, thresholdMs],
  );

  const reset = useCallback(() => {
    clearTimeout(timerRef.current);
    detector.reset();
    prefixRef.current = "";
  }, [detector]);

  const settle = useCallback((setValue: SetInputValue) => {
    clearTimeout(timerRef.current);
    const decision = resolveScanSettle(detector.flush(), prefixRef.current, minLength);
    prefixRef.current = "";
    setValue(decision.fieldValue);
    if (decision.scan) onScanRef.current(decision.scan);
  }, [detector, minLength]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>, setValue: SetInputValue) => {
    if (!enabled) return;

    if (event.key === "Enter") {
      // نعترض Enter فقط حين تكون ومضةٌ نشطة (≥ حرفين سريعين): إمّا نُصدر الباركود، وإمّا نستعيد
      // النصّ القصير بلا فقد. الحرف المفرد أو السكون يترك Enter للنموذج/الحقل بقيمته الظاهرة.
      if (detector.isActive) {
        event.preventDefault();
        settle(setValue);
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
    if (action === "pass") {
      // حرفٌ مرشّح يظهر في الحقل؛ سجّل قيمة الحقل قبله (قبل إدراج هذا الحرف) لاستعادةٍ محتملة.
      prefixRef.current = event.currentTarget.value;
      return;
    }
    event.preventDefault();
    if (action === "startBurst") setValue(prefixRef.current); // أزل الحرف المرشّح المتسرّب، وأبقِ البادئة
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => settle(setValue), Math.max(250, Math.min(thresholdMs * 6, 600)));
  }, [enabled, settle, minLength, reset, detector, thresholdMs]);

  useEffect(() => reset, [reset]);

  return { handleKeyDown, reset };
}
