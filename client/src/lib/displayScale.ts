/**
 * مقياس عرض التطبيق — يغيّر جذر rem ضمن حدودٍ آمنة ولا يستعمل CSS zoom/transform.
 * بذلك تبقى الإحداثيات، النقر، sticky، الطباعة، وتقريب المتصفح الأصلي صحيحة.
 */
export const DISPLAY_SCALE_STORAGE_KEY = "erp:display-scale:v1";

export const DISPLAY_SCALES = ["compact", "normal", "large", "xlarge"] as const;
export type DisplayScale = (typeof DISPLAY_SCALES)[number];

export const DISPLAY_SCALE_LABEL: Record<DisplayScale, string> = {
  compact: "مضغوط",
  normal: "عادي",
  large: "كبير",
  xlarge: "كبير جداً",
};

const DISPLAY_SCALE_EVENT = "erp:display-scale-change";

export function isDisplayScale(value: unknown): value is DisplayScale {
  return typeof value === "string" && (DISPLAY_SCALES as readonly string[]).includes(value);
}

export function readDisplayScale(): DisplayScale {
  if (typeof window === "undefined") return "normal";
  try {
    const saved = window.localStorage.getItem(DISPLAY_SCALE_STORAGE_KEY);
    return isDisplayScale(saved) ? saved : "normal";
  } catch {
    return "normal";
  }
}

export function applyDisplayScale(scale: DisplayScale): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.uiScale = scale;
}

/** تُستدعى قبل تركيب React لمنع قفزة الخط عند أول رسم. */
export function applyStoredDisplayScale(): DisplayScale {
  const scale = readDisplayScale();
  applyDisplayScale(scale);
  return scale;
}

export function setDisplayScale(scale: DisplayScale): void {
  applyDisplayScale(scale);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISPLAY_SCALE_STORAGE_KEY, scale);
  } catch {
    // تعذّر التخزين لا يمنع تطبيق التفضيل في الجلسة الحالية.
  }
  window.dispatchEvent(new CustomEvent(DISPLAY_SCALE_EVENT, { detail: scale }));
}

export function subscribeDisplayScale(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === DISPLAY_SCALE_STORAGE_KEY) {
      applyDisplayScale(readDisplayScale());
      listener();
    }
  };
  window.addEventListener(DISPLAY_SCALE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(DISPLAY_SCALE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}
