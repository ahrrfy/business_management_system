// خطّاف تمييز المسح السريع (باركود) عن الكتابة البشرية في حقل بحث الكاشير.
// يفوّض التوقيت والفكّ الفيزيائيّ (المستقلّ عن تخطيط لوحة المفاتيح) إلى `ScanBurstDetector` الموحَّد
// — نفس نواة الخطّاف العالميّ وخطّاف الحقل، فلا انجراف بينها، ويرث تصحيح الرموز العربية والمناعة
// لتذبذب توقيت USB. الكاشير يشترط ≥٤ محارف لاعتباره باركوداً (يتجنّب التقاط ضغطتين بشريتين).

import { useCallback, useMemo, useRef } from "react";
import { ScanBurstDetector } from "@/lib/barcodeScanTiming";
import { SCAN_MS } from "./posShared";

/** أدنى طولٍ لاعتبار الومضة باركوداً في الكاشير (رموز المنتجات ≥٤؛ الأقصر يبقى بحثاً بشرياً). */
const POS_SCAN_MIN_LENGTH = 4;

export function useSmartScanInput(onBarcode: (code: string) => Promise<void>) {
  const detector = useMemo(
    () => new ScanBurstDetector({ minLength: POS_SCAN_MIN_LENGTH, intraGapMs: SCAN_MS }),
    [],
  );
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const fire = useCallback(
    (setValue: (s: string) => void) => {
      clearTimeout(timerRef.current);
      const { accepted, code, text } = detector.flush();
      if (accepted && code.length >= POS_SCAN_MIN_LENGTH) {
        setValue("");
        void onBarcode(code);
      } else if (text) {
        // إدخال بشري قصير أُسيء تصنيفه كمسح — أعِد النصّ المكتوب بدل ابتلاعه صامتاً.
        setValue(text);
      }
    },
    [onBarcode, detector],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, curVal: string, setValue: (s: string) => void) => {
      void curVal; // التوقيع محفوظٌ للتوافق؛ الحرف المرشّح الأوّل يتتبّعه الكاشف داخلياً الآن.
      if (e.key === "Enter") {
        if (detector.isActive && detector.length >= POS_SCAN_MIN_LENGTH) {
          e.preventDefault();
          fire(setValue);
        }
        return;
      }
      if (e.key === "Escape") {
        clearTimeout(timerRef.current);
        detector.reset();
        return;
      }
      // طول 1 أو 2 (لِـ«لا/لأ/لآ» في العربي 101)؛ الفكّ الفيزيائيّ يعيدها ASCII.
      if (e.ctrlKey || e.altKey || e.metaKey || e.key.length < 1 || e.key.length > 2) return;

      const action = detector.feed({ code: e.code, key: e.key, shiftKey: e.shiftKey }, Date.now());
      if (action === "pass") return; // إدخالٌ بشريٌّ محتمل — اتركه يظهر في الحقل
      e.preventDefault();
      if (action === "startBurst") setValue(""); // امسح الحرف المرشّح المتسرّب
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => fire(setValue), SCAN_MS * 6);
    },
    [fire, detector],
  );

  return { handleKeyDown };
}
