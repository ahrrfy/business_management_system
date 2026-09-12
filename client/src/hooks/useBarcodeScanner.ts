/**
 * useBarcodeScanner — خطّاف الالتقاط العالميّ لمدخل قارئ HID على مستوى الصفحة كاملةً.
 *
 * ماسحات USB/Bluetooth تحاكي لوحة مفاتيح: تُرسل مواقع مفاتيح بسرعةٍ عالية ثم Enter. هذا الخطّاف
 * يلتقط المسح في **أيّ مكانٍ** بالشاشة (داخل حقلٍ أو خارجه) ويميّزه عن الكتابة البشرية بالتوقيت.
 *
 * كلّ منطق التوقيت والفكّ الفيزيائيّ موحَّدٌ في `ScanBurstDetector` (نواةٌ نقيّة مُختبَرة) — فلا
 * ينجرف عن `useBarcodeInput`/`useSmartScanInput`، ويصحّح ثلاث علل معاً: الرموز العربية (فكّ
 * `event.code` المستقلّ عن التخطيط)، و«يعمل أحياناً» (تسامحٌ مع تذبذب توقيت USB)، والتسريب
 * (استعادةٌ فوريّة للحرف المرشّح عند بدء الومضة). راجع `client/src/lib/barcodeScanTiming.ts`.
 *
 * @param onScan     — يُستدعى بالباركود المفكوك الكامل عند اكتمال المسح.
 * @param enabled    — يُعطَّل عند فتح المودالات لتجنّب التعارض.
 * @param minLength  — أدنى طولٍ لقبول الومضة (افتراضي 2؛ رموز الموردين الداخلية قد تكون قصيرة).
 * @param thresholdMs— أقصى فاصلٍ بين ضغطتين ضمن ومضةٍ واحدة (افتراضي 120؛ سخيٌّ ليتحمّل التذبذب).
 */
import { useEffect, useCallback } from "react";
import { ScanBurstDetector } from "@/lib/barcodeScanTiming";

const INPUT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function useBarcodeScanner(
  onScan: (raw: string) => void,
  {
    enabled = true,
    minLength = 2,
    thresholdMs = 120,
  }: { enabled?: boolean; minLength?: number; thresholdMs?: number } = {},
): void {
  // useCallback لضمان استقرار المرجع وتجنّب إعادة تسجيل event listener
  const stableOnScan = useCallback(onScan, [onScan]);

  useEffect(() => {
    if (!enabled) return;

    const detector = new ScanBurstDetector({ minLength, intraGapMs: thresholdMs });
    // مهلة السكون قبل الإفراغ التلقائيّ (قارئٌ بلا لاحقة Enter): أطول من أيّ فاصلٍ متوقَّعٍ ضمن
    // ومضة، وأقصر من أن يعوق كتابةً بشرية لاحقة.
    const idleMs = Math.max(250, Math.min(thresholdMs * 4, 600));
    let timer: ReturnType<typeof setTimeout>;

    // الحقل المستهدَف وقيمته قبل ظهور الحرف المرشّح — لاستعادةٍ نظيفة (صفر تسريب).
    let fieldTarget: HTMLInputElement | HTMLTextAreaElement | null = null;
    let valBefore = "";

    const clearField = () => {
      fieldTarget = null;
      valBefore = "";
    };

    const restore = (value: string) => {
      if (!fieldTarget) return;
      fieldTarget.value = value;
      fieldTarget.dispatchEvent(new Event("input", { bubbles: true }));
    };

    const finish = () => {
      clearTimeout(timer);
      const { accepted, code, text } = detector.flush();
      if (accepted && code.length >= minLength) {
        // نجحت الومضة: الحقل نُظّف بالفعل عند بدئها؛ نصدر الباركود المفكوك.
        clearField();
        stableOnScan(code);
      } else {
        // كتابةٌ بشرية قصيرة صُنّفت سريعاً بالخطأ: أعِد الحروف الخام للحقل بلا ابتلاع.
        if (text) restore(valBefore + text);
        clearField();
      }
    };

    const armIdle = () => {
      clearTimeout(timer);
      timer = setTimeout(finish, idleMs);
    };

    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField = target != null && INPUT_TAGS.has(target.tagName);
      const inputEl = inField ? (target as HTMLInputElement | HTMLTextAreaElement) : null;

      // Enter: نعترضه حين تكون ومضةٌ نشطة — إمّا نُصدر الباركود (بلغ الحدّ الأدنى) وإمّا نستعيد
      // النصّ القصير عبر finish (يعيد البادئة + الخام) بلا فقد. غير النشط يمرّ للنموذج/الحقل.
      if (e.key === "Enter") {
        if (detector.isActive) {
          e.preventDefault();
          e.stopPropagation();
          finish();
        } else {
          clearTimeout(timer);
          detector.reset();
          clearField();
        }
        return;
      }

      // تجاهل مفاتيح التحكّم والوظائف والاختصارات. نقبل طول 1 أو 2 لأنّ العربي 101 يُنتج
      // «لا/لأ/لآ» بحرفَين لضغطةٍ واحدة؛ الفكّ الفيزيائيّ (event.code) يعيدها ASCII.
      if (e.ctrlKey || e.altKey || e.metaKey || e.key.length < 1 || e.key.length > 2) return;

      const action = detector.feed({ code: e.code, key: e.key, shiftKey: e.shiftKey }, Date.now());

      if (action === "pass") {
        // حرفٌ مرشّح: يظهر في الحقل (قد يكون بشرياً). نسجّل قيمة الحقل قبله لاستعادةٍ محتملة.
        if (inputEl) {
          fieldTarget = inputEl;
          valBefore = inputEl.value;
        } else {
          clearField();
        }
        return;
      }

      // startBurst أو capture: احجب الحرف عن الحقل.
      e.preventDefault();
      e.stopPropagation();
      if (action === "startBurst" && inputEl && fieldTarget === inputEl) {
        // استعِد الحرف المرشّح الأوّل الذي تسرّب — صفر رمزٍ مرئيّ.
        restore(valBefore);
      }
      armIdle();
    };

    // useCapture: الالتقاط عند النزول قبل عناصر DOM لتأمين اعتراض Enter والنبضات وسبق الخطّافات الحقلية.
    document.addEventListener("keydown", handler, true);
    // أيّ تغيّر تركيزٍ يُنهي أيّ تسلسلٍ جارٍ (منع حمل مخزنٍ عبر الحقول).
    const onFocusChange = () => {
      clearTimeout(timer);
      detector.reset();
      clearField();
    };
    document.addEventListener("focusin", onFocusChange);
    return () => {
      document.removeEventListener("keydown", handler, true);
      document.removeEventListener("focusin", onFocusChange);
      clearTimeout(timer);
    };
  }, [enabled, minLength, thresholdMs, stableOnScan]);
}
