export type CustomizationAssetKind = "LOGO" | "PREVIEW";
export type CustomizationAssetMime = "image/png" | "image/jpeg" | "image/webp";
export type CustomizationStudioUploadState =
  | "idle"
  | "uploading"
  | "uploaded"
  | "error";

export const MAX_CUSTOMIZATION_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_CUSTOMIZATION_IMAGE_DIMENSION = 4096;

const ALLOWED_CUSTOMIZATION_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export function stripDataUrlBase64(input: string): string {
  const trimmed = input.trim();
  const stripped = trimmed.replace(/^data:[^,]*;base64,/i, "");
  return stripped.replace(/\s+/g, "");
}

export function estimateBase64ByteLength(pureBase64: string): number {
  const cleaned = stripDataUrlBase64(pureBase64);
  if (!cleaned) return 0;
  const padding = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((cleaned.length * 3) / 4) - padding);
}

export function validateCustomizationAssetFile(file: {
  type: string;
  size: number;
  name?: string;
}):
  | { ok: true; mimeType: CustomizationAssetMime }
  | { ok: false; error: string } {
  const mime = (file.type || "").trim().toLowerCase();
  if (!ALLOWED_CUSTOMIZATION_MIMES.has(mime)) {
    return {
      ok: false,
      error:
        "يرجى اختيار صورة بصيغة PNG أو JPEG أو WebP فقط (ملفات SVG أو الصيغ الأخرى غير مدعومة).",
    };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return {
      ok: false,
      error: "ملف الصورة فارغ أو تالف. يرجى اختيار ملف صالح.",
    };
  }
  if (file.size > MAX_CUSTOMIZATION_ASSET_BYTES) {
    return {
      ok: false,
      error:
        "حجم الصورة يتجاوز الحد الأقصى المسموح (2 ميجابايت). يرجى اختيار صورة أصغر.",
    };
  }
  return { ok: true, mimeType: mime as CustomizationAssetMime };
}

export function validateCustomizationImageDimensions(
  width: number,
  height: number,
): { ok: true } | { ok: false; error: string } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {
      ok: false,
      error: "تعذّرت قراءة أبعاد ملف الصورة. يرجى اختيار ملف صورة صالح.",
    };
  }
  if (
    width > MAX_CUSTOMIZATION_IMAGE_DIMENSION ||
    height > MAX_CUSTOMIZATION_IMAGE_DIMENSION
  ) {
    return {
      ok: false,
      error: `أبعاد الصورة تتجاوز الحد الأقصى المسموح (${MAX_CUSTOMIZATION_IMAGE_DIMENSION}×${MAX_CUSTOMIZATION_IMAGE_DIMENSION} بكسل). يرجى اختيار صورة بأبعاد أصغر.`,
    };
  }
  return { ok: true };
}

export function loadStudioImage(
  src: string,
  options?: { crossOrigin?: string },
): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (options?.crossOrigin) {
      img.crossOrigin = options.crossOrigin;
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("تعذّر تحميل ملف الصورة للمعاينة."));
    img.src = src;
  });
}

export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result ?? reader.result;
      if (typeof result === "string" && result.length > 0) {
        resolve(result);
      } else {
        reject(new Error("تعذّرت قراءة ملف الصورة من الجهاز."));
      }
    };
    reader.onerror = () => {
      reject(new Error("تعذّرت قراءة ملف الصورة من الجهاز."));
    };
    reader.readAsDataURL(file);
  });
}

function tryExportCanvasToBase64(
  target: Pick<HTMLCanvasElement, "toDataURL">,
):
  | {
      ok: true;
      mimeType: CustomizationAssetMime;
      dataBase64: string;
      dataUrl: string;
    }
  | { ok: false; error: string } {
  const pngUrl = target.toDataURL("image/png");
  const pngBase64 = stripDataUrlBase64(pngUrl);
  if (
    pngBase64 &&
    estimateBase64ByteLength(pngBase64) <= MAX_CUSTOMIZATION_ASSET_BYTES
  ) {
    return {
      ok: true,
      mimeType: "image/png",
      dataBase64: pngBase64,
      dataUrl: pngUrl,
    };
  }

  const webpUrl = target.toDataURL("image/webp", 0.86);
  const webpBase64 = stripDataUrlBase64(webpUrl);
  if (
    webpBase64 &&
    estimateBase64ByteLength(webpBase64) <= MAX_CUSTOMIZATION_ASSET_BYTES
  ) {
    return {
      ok: true,
      mimeType: "image/webp",
      dataBase64: webpBase64,
      dataUrl: webpUrl,
    };
  }

  return {
    ok: false,
    error:
      "حجم صورة المعاينة يتجاوز الحد الأقصى المسموح (2 ميجابايت). يرجى تصغير الشعار والمحاولة مجدداً.",
  };
}

export function exportStudioCanvasPayload(
  canvas: Pick<HTMLCanvasElement, "toDataURL"> | null,
  fallbackUntaintedCanvasFactory?: () => Pick<HTMLCanvasElement, "toDataURL"> | null,
):
  | {
      ok: true;
      mimeType: CustomizationAssetMime;
      dataBase64: string;
      dataUrl: string;
    }
  | { ok: false; error: string } {
  if (!canvas) {
    return { ok: false, error: "لوحة المعاينة غير جاهزة حالياً. أعد المحاولة." };
  }
  try {
    return tryExportCanvasToBase64(canvas);
  } catch {
    if (fallbackUntaintedCanvasFactory) {
      try {
        const cleanCanvas = fallbackUntaintedCanvasFactory();
        if (cleanCanvas) {
          return tryExportCanvasToBase64(cleanCanvas);
        }
      } catch {
        // Fall through to unified Arabic error below
      }
    }
    return {
      ok: false,
      error: "تعذّر تصدير صورة المعاينة من المتصفح. يرجى إعادة المحاولة.",
    };
  }
}


export function formatCustomizationUploadError(error: unknown): string {
  const errObj =
    typeof error === "object" && error !== null
      ? (error as {
          message?: unknown;
          data?: { code?: unknown; httpStatus?: unknown };
        })
      : null;
  const code = typeof errObj?.data?.code === "string" ? errObj.data.code : "";
  const status =
    typeof errObj?.data?.httpStatus === "number" ? errObj.data.httpStatus : 0;
  const rawMessage =
    typeof errObj?.message === "string" ? errObj.message.trim() : "";

  if (code === "SERVICE_UNAVAILABLE" || status === 503) {
    if (rawMessage && /[\u0600-\u06FF]/.test(rawMessage)) {
      return rawMessage;
    }
    return "خدمة رفع ملفات التخصيص غير متاحة مؤقتاً. انتظر لحظات ثم اضغط إعادة المحاولة.";
  }

  if (code === "TOO_MANY_REQUESTS" || status === 429) {
    if (rawMessage && /[\u0600-\u06FF]/.test(rawMessage)) {
      return rawMessage;
    }
    return "تم تجاوز الحد المؤقت لرفع المرفقات. انتظر قليلاً ثم أعد المحاولة.";
  }

  if (rawMessage && /[\u0600-\u06FF]/.test(rawMessage)) {
    return rawMessage;
  }

  return "تعذّر رفع مرفق التخصيص حالياً. تحقق من الاتصال ثم اضغط إعادة المحاولة.";
}

export function isCustomizationUploadBlockingAddToCart(
  state: CustomizationStudioUploadState | undefined,
): boolean {
  return state === "uploading" || state === "error";
}
