/** التقاط قارئ الباركود داخل input: تسلسل سريع ثم Enter، مع إبقاء الكتابة البشرية كما هي. */
import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { normalizeBarcodeScannerInput } from "@/lib/barcodeScannerInput";

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
  const previousMsRef = useRef(0);
  const firstKeyRef = useRef("");
  const bufferRef = useRef("");
  const scanningRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  onScanRef.current = onScan;

  const reset = useCallback(() => {
    clearTimeout(timerRef.current);
    firstKeyRef.current = "";
    bufferRef.current = "";
    scanningRef.current = false;
  }, []);

  const flush = useCallback((setValue: SetInputValue) => {
    clearTimeout(timerRef.current);
    const raw = bufferRef.current;
    reset();
    if (barcodeInputAcceptsScan(raw, minLength)) {
      setValue("");
      onScanRef.current(normalizeBarcodeScannerInput(raw));
    } else if (raw) {
      // تسلسل بشري قصير صُنّف سريعاً بالخطأ: لا نبتلعه.
      setValue(raw);
    }
  }, [minLength, reset]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>, setValue: SetInputValue) => {
    if (!enabled) return;
    const now = Date.now();

    if (event.key === "Enter") {
      if (scanningRef.current && barcodeInputAcceptsScan(bufferRef.current, minLength)) {
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
    if (event.ctrlKey || event.altKey || event.metaKey || event.key.length === 0 || event.key.length > 2) return;

    const gap = now - previousMsRef.current;
    previousMsRef.current = now;

    if (scanningRef.current) {
      event.preventDefault();
      bufferRef.current += event.key;
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => flush(setValue), thresholdMs * 6);
      return;
    }

    const candidate = firstKeyRef.current && gap < thresholdMs
      ? firstKeyRef.current + event.key
      : event.key;
    firstKeyRef.current = candidate;
    // لا نبتلع محرفين سريعين في حقل بحث مختلط؛ ندخل وضع الماسح فقط بعد بلوغ الحد.
    if (!barcodeInputAcceptsScan(candidate, minLength)) return;
    event.preventDefault();
    bufferRef.current = candidate;
    scanningRef.current = true;
    setValue("");
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => flush(setValue), thresholdMs * 6);
  }, [enabled, flush, minLength, reset, thresholdMs]);

  useEffect(() => reset, [reset]);

  return { handleKeyDown, reset };
}
