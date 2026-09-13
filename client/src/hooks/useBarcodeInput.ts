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
import { ScanBurstDetector, resolveScanSettle, recoverSlowScanCode } from "@/lib/barcodeScanTiming";

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
    // ١٢٠مي (رُفع من 80، موحّدٌ مع الخطّاف العالميّ): يلتقط القارئات الأبطأ قليلاً كي يُحجَب المسح
    // مباشرةً (بلا تسرّبٍ لشاشة البحث) دون بلوغ سرعة الكتابة البشرية المستدامة (>١٣٠مي/حرف عبر
    // مصطلحٍ كامل). القارئ البطيء جداً يُغطّيه استرداد Enter أدناه، والحلّ الجذريّ ضبطُ القارئ.
    thresholdMs = 120,
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
      if (detector.isActive) {
        // ومضةٌ نشطة (≥ حرفين سريعين): أصدِر الباركود أو استعِد النصّ القصير بلا فقد.
        event.preventDefault();
        settle(setValue);
        return;
      }
      // قارئٌ بطيء لم يُكتشَف كومضة (تسرّب حرفاً حرفاً): إن كان محتوى الحقل باركوداً واثقاً،
      // فكّه واستعلمه بدل تركه بحثاً نصّياً فاشلاً. وإلّا اترك Enter للنموذج/الحقل.
      const recovered = recoverSlowScanCode(event.currentTarget.value, minLength);
      if (recovered) {
        event.preventDefault();
        reset();
        setValue("");
        onScanRef.current(recovered);
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
    // مهلة سكونٍ أقصر (استجابةٌ أسرع للقارئ بلا لاحقة Enter): أطول من فاصل الومضة، أقصر ملحوظياً.
    timerRef.current = setTimeout(() => settle(setValue), Math.max(180, Math.min(thresholdMs + 80, 320)));
  }, [enabled, settle, minLength, reset, detector, thresholdMs]);

  useEffect(() => reset, [reset]);

  return { handleKeyDown, reset };
}
