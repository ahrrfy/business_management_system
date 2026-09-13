// خطّاف تمييز المسح السريع (باركود) عن الكتابة البشرية في حقل بحث الكاشير.
// يفوّض التوقيت والفكّ الفيزيائيّ (المستقلّ عن تخطيط لوحة المفاتيح) إلى `ScanBurstDetector` الموحَّد
// — نفس نواة الخطّاف العالميّ وخطّاف الحقل، فلا انجراف بينها، ويرث تصحيح الرموز العربية والمناعة
// لتذبذب توقيت USB. الكاشير يشترط ≥٤ محارف لاعتباره باركوداً (يتجنّب التقاط ضغطتين بشريتين).
//
// صون البحث القائم (ملاحظتا مراجعة #1107): نتتبّع بادئة الحقل (قيمته قبل الحرف المرشّح، عبر curVal)
// فحين تنكسر الومضة قصيرةً نستعيد البادئة + الحروف الخام بدل مسحها.

import { useCallback, useMemo, useRef } from "react";
import { ScanBurstDetector, resolveScanSettle, recoverSlowScanCode } from "@/lib/barcodeScanTiming";
import { SCAN_MS } from "./posShared";

/** أدنى طولٍ لاعتبار الومضة باركوداً في الكاشير (رموز المنتجات ≥٤؛ الأقصر يبقى بحثاً بشرياً). */
const POS_SCAN_MIN_LENGTH = 4;

export function useSmartScanInput(onBarcode: (code: string) => Promise<void>) {
  const detector = useMemo(
    () => new ScanBurstDetector({ minLength: POS_SCAN_MIN_LENGTH, intraGapMs: SCAN_MS }),
    [],
  );
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const prefixRef = useRef("");

  const fire = useCallback(
    (setValue: (s: string) => void) => {
      clearTimeout(timerRef.current);
      const decision = resolveScanSettle(detector.flush(), prefixRef.current, POS_SCAN_MIN_LENGTH);
      prefixRef.current = "";
      setValue(decision.fieldValue);
      if (decision.scan) void onBarcode(decision.scan);
    },
    [onBarcode, detector],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, curVal: string, setValue: (s: string) => void) => {
      if (e.key === "Enter") {
        if (detector.isActive) {
          // ومضةٌ نشطة: أصدِر الباركود أو استعِد النصّ القصير بلا فقد.
          e.preventDefault();
          fire(setValue);
          return;
        }
        // قارئٌ بطيء تسرّب حرفاً حرفاً: استردّ باركوداً واثقاً من قيمة الحقل بدل بحثٍ نصّيّ.
        const recovered = recoverSlowScanCode(curVal, POS_SCAN_MIN_LENGTH);
        if (recovered) {
          e.preventDefault();
          detector.reset();
          prefixRef.current = "";
          setValue("");
          void onBarcode(recovered);
        }
        return;
      }
      if (e.key === "Escape") {
        clearTimeout(timerRef.current);
        detector.reset();
        prefixRef.current = "";
        return;
      }
      // طول 1 أو 2 (لِـ«لا/لأ/لآ» في العربي 101)؛ الفكّ الفيزيائيّ يعيدها ASCII.
      if (e.ctrlKey || e.altKey || e.metaKey || e.key.length < 1 || e.key.length > 2) return;

      const action = detector.feed({ code: e.code, key: e.key, shiftKey: e.shiftKey }, Date.now());
      if (action === "pass") {
        // حرفٌ مرشّح يظهر في الحقل؛ curVal هو قيمة الحقل قبله (بادئة البحث القائم).
        prefixRef.current = curVal;
        return;
      }
      e.preventDefault();
      if (action === "startBurst") setValue(prefixRef.current); // أزل الحرف المرشّح المتسرّب، أبقِ البادئة
      clearTimeout(timerRef.current);
      // مهلة سكونٍ أقصر (استجابةٌ أسرع للقارئ بلا لاحقة Enter).
      timerRef.current = setTimeout(() => fire(setValue), Math.max(180, SCAN_MS + 80));
    },
    [fire, detector],
  );

  return { handleKeyDown };
}
