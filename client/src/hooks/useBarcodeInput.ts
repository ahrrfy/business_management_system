/** التقاط قارئ الباركود داخل input — **موحَّدٌ مع خطّاف الكاشير** `useSmartScanInput` (بلاغ المالك ١٥/٩:
 *  «طبّق مكوّن الكاشير على بقية حقول البحث والاستعلام»). كان هذا الخطّاف يحمل نسخةً موازية من منطق
 *  التوقيت انجرفت عن الكاشير؛ الآن **يفوّض كلّ شيء إلى `useSmartScanInput`** فيصير سلوكُ البحث/المسح
 *  (الكتابة العربية بالمسافة + المسح الرقميّ والأبجديّ) واحداً في كلّ الشاشات كما في الكاشير تماماً.
 *
 *  يكيّف فقط التوقيع: حقول القوائم القائمة تستدعي `handleKeyDown(event, setValue)`، بينما خطّاف الكاشير
 *  يستقبل `(event, currentValue, setValue)` — نشتقّ القيمة الحالية من `event.currentTarget.value`.
 *  `useSmartScanInput` بلا خيارات = سلوك الكاشير (٤ محارف/١٢٠مي)؛ هنا نمرّر minLength=3 لحقول البحث. */
import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { useSmartScanInput } from "@/components/pos/useSmartScanInput";

type SetInputValue = (value: string) => void;

export const DEFAULT_BARCODE_INPUT_MIN_LENGTH = 3;
export function barcodeInputAcceptsScan(raw: string, minLength = DEFAULT_BARCODE_INPUT_MIN_LENGTH): boolean {
  return raw.length >= minLength;
}

export function useBarcodeInput(
  onScan: (code: string) => void,
  {
    enabled = true,
    // باركودات الموردين الداخلية قد تكون من 3 محارف (مثل B1X). أقلّ من ذلك يبقى كتابةً بشرية.
    minLength = DEFAULT_BARCODE_INPUT_MIN_LENGTH,
    // ١٢٠مي موحّدٌ مع الكاشير — يتحمّل تذبذب توقيت USB دون بلوغ سرعة الكتابة البشرية المستدامة.
    thresholdMs = 120,
  }: { enabled?: boolean; minLength?: number; thresholdMs?: number } = {},
) {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  // نفس خطّاف الكاشير حرفيّاً — لا نسخة موازية. مرجعٌ مستقرّ لـonScan كي لا يُعاد بناء الكاشف وسط مسح.
  const { handleKeyDown: scanKeyDown, reset } = useSmartScanInput(
    (code) => onScanRef.current(code),
    { minLength, gapMs: thresholdMs },
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>, setValue: SetInputValue) => {
      if (!enabled) return;
      // نمرّر القيمة الحالية للحقل (بادئة البحث القائم) كما يفعل الكاشير بـ`curVal`.
      scanKeyDown(event, event.currentTarget.value, setValue);
    },
    [enabled, scanKeyDown],
  );

  // إلغاءُ أيّ ومضةٍ معلّقة عند إزالة المكوّن (تجنّب إطلاق مسحٍ على حقلٍ زال).
  useEffect(() => reset, [reset]);

  return { handleKeyDown, reset };
}
