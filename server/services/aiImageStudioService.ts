/**
 * مسار الذكاء الاصطناعي لاستوديو صور المنتجات: إعادة تصميم صورة المنتج كتصوير استوديو موحّد عبر
 * مزوّد توليديّ (الافتراضي Gemini). شريحة «استوديو الذكاء الاصطناعي».
 *
 * ⚠️ توليديّ لا قاصّ: بخلاف remove.bg (segmentation)، هذا يعيد رسم بكسلات الصورة كاملةً. لذا:
 *   - البرومت يحمل حارس أمانة صارماً (shared/imageStudio/aiPrompt.ts) يأمر النموذج بحفظ المنتج
 *     وكتابته حرفياً وتغيير الخلفية/الإضاءة فقط — يُبنى في الكود لا في إدخال المستخدم وحده.
 *   - القرار النهائيّ بشريّ: الواجهة تعرض قبل/بعد وتطلب اعتماداً صريحاً؛ الأصل لا يُستبدَل إلا بموافقة.
 *
 * التصميم (نمط removebgService — نقيّ قابل للاختبار):
 *   - `generateStudioImage({apiKey, model, prompt, imageBase64?, mimeType?}, opts)` يمرَّر إليه المفتاح
 *     (لا يقرأ إعدادات) ⇒ قابل للاختبار بـfetch مُموَّه. أخطاء مصنّفة (`AiImageError.kind`).
 *   - `verifyGeminiKey(apiKey)` يفحص صلاحية المفتاح بنداء رخيص (قائمة النماذج) بلا توليد صورة.
 *   - المفتاح لا يُخزَّن هنا؛ الإعدادات المشفّرة في imageStudioSettingsService.
 *   - المفتاح يُمرَّر في ترويسة `x-goog-api-key` (لا في مسار الـURL — لا تسريب في السجلّات).
 */

import { DEFAULT_GEMINI_IMAGE_MODEL } from "@shared/imageStudio/aiPrompt";

/** قاعدة عنوان Gemini API — قابلة للتجاوز عبر env (لتوجيهٍ لبروكسي/إصدار آخر بلا تغيير كود). */
const GEMINI_API_BASE = (process.env.GEMINI_API_BASE ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");

/** تصنيف أخطاء المزوّد — يقود العرض والتشخيص. */
export type AiImageErrorKind =
  | "AUTH" // مفتاح خاطئ/ملغى/بلا صلاحية
  | "QUOTA" // تجاوز الحصّة/الحدّ (429)
  | "BAD_INPUT" // طلب غير صالح (400 غير المصادقة)
  | "BLOCKED" // حجب أمان من المزوّد (المحتوى/السلامة)
  | "NO_IMAGE" // نجح النداء لكن بلا صورة في الردّ (رفض النموذج/نصّ فقط)
  | "SERVICE" // 5xx أو غير متوقّع
  | "NETWORK"; // تعذّر الوصول للخدمة أصلاً

export class AiImageError extends Error {
  constructor(
    public readonly kind: AiImageErrorKind,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AiImageError";
  }
}

export interface GenerateStudioImageParams {
  /** مفتاح API مفكوك (يُمرَّر، لا يُقرأ من الإعدادات). */
  apiKey: string;
  /** معرّف النموذج (فارغ ⇒ الافتراضي). */
  model?: string | null;
  /** البرومت النهائيّ (مبنيّ عبر buildAiStudioPrompt — يحمل حارس الحفظ). */
  prompt: string;
  /** base64 خام لصورة المنتج (بلا بادئة data:). غيابه ⇒ وضع «توليد» من نصّ فقط. */
  imageBase64?: string | null;
  /** نوع MIME لصورة الإدخال (image/jpeg|png|webp). */
  mimeType?: string | null;
}

export interface GenerateStudioImageResult {
  /** base64 خام للصورة الناتجة. */
  imageBase64: string;
  /** نوع MIME الناتج (من الردّ، غالباً image/png). */
  mimeType: string;
}

export interface AiImageCallOptions {
  /** لِحقن fetch مُموَّه في الاختبار (افتراضياً fetch العام). */
  fetchImpl?: typeof fetch;
  /** تضمين imageConfig (aspectRatio 1:1) — الافتراضي true (النموذج الافتراضي يدعمه). */
  includeImageConfig?: boolean;
}

/** أسباب الحجب الأمنيّ من finishReason (candidate) — تُصنَّف BLOCKED لا NO_IMAGE. */
const SAFETY_FINISH_REASONS = new Set(["SAFETY", "IMAGE_SAFETY", "PROHIBITED_CONTENT", "RECITATION", "BLOCKLIST", "SPII"]);

/** يستخرج جزء الصورة (inlineData/inline_data) من أوّل مرشّح — يدعم camelCase وsnake_case. */
function extractImagePart(json: any): { data: string; mime: string } | null {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  for (const p of parts) {
    const inline = p?.inlineData ?? p?.inline_data;
    const data = inline?.data;
    if (typeof data === "string" && data.length > 0) {
      const mime = inline?.mimeType ?? inline?.mime_type ?? "image/png";
      return { data, mime: String(mime) };
    }
  }
  return null;
}

/** يصنّف ردّ الخطأ (غير 2xx) إلى AiImageErrorKind بحسب الرمز والرسالة. */
function classifyHttpError(status: number, message: string): AiImageErrorKind {
  const m = message.toLowerCase();
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "QUOTA";
  if (status === 400) {
    // 400 قد يكون مفتاحاً غير صالح (INVALID_ARGUMENT: API key not valid) أو طلباً سيّئاً.
    if (/api[_ ]?key|unauthenticated|permission|not valid|invalid.*credential/.test(m)) return "AUTH";
    return "BAD_INPUT";
  }
  if (status >= 500) return "SERVICE";
  return "SERVICE";
}

/**
 * يُعيد تصميم صورة المنتج (أو يولّد من نصّ عند غياب الصورة) عبر Gemini generateContent.
 * يرمي `AiImageError` مصنّفاً عند أيّ فشل ⇒ يقرّر المستدعي العرض/التدهور.
 */
export async function generateStudioImage(
  params: GenerateStudioImageParams,
  opts: AiImageCallOptions = {},
): Promise<GenerateStudioImageResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const model = (params.model && params.model.trim()) || DEFAULT_GEMINI_IMAGE_MODEL;
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`;

  const parts: Array<Record<string, unknown>> = [{ text: params.prompt }];
  if (params.imageBase64) {
    parts.push({
      inline_data: { mime_type: params.mimeType || "image/jpeg", data: params.imageBase64 },
    });
  }

  const generationConfig: Record<string, unknown> = { responseModalities: ["TEXT", "IMAGE"] };
  if (opts.includeImageConfig !== false) {
    // إطار مربّع 1:1 مطابق لقالب الاستوديو (بقيّة الأنابيب مربّعة). النموذج الافتراضي يدعم imageConfig.
    generationConfig.imageConfig = { aspectRatio: "1:1" };
  }

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": params.apiKey, // في الترويسة لا في الـURL — لا تسريب في السجلّات.
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ contents: [{ parts }], generationConfig }),
    });
  } catch (e: any) {
    throw new AiImageError("NETWORK", 0, `تعذّر الوصول لمزوّد الذكاء الاصطناعي: ${e?.message ?? "خطأ شبكة"}`);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: { message?: string; status?: string } };
      detail = j?.error?.message ?? j?.error?.status ?? "";
    } catch {
      detail = await res.text().catch(() => "");
    }
    detail = String(detail).slice(0, 300);
    throw new AiImageError(classifyHttpError(res.status, detail), res.status, detail || `HTTP ${res.status}`);
  }

  let json: any;
  try {
    json = await res.json();
  } catch (e: any) {
    throw new AiImageError("SERVICE", res.status, `ردّ غير صالح من المزوّد: ${e?.message ?? ""}`);
  }

  // حجب أمنيّ على مستوى البرومت أو المرشّح ⇒ BLOCKED (لا NO_IMAGE) لرسالة أدقّ.
  const blockReason = json?.promptFeedback?.blockReason;
  const finishReason = json?.candidates?.[0]?.finishReason;
  if (blockReason || (finishReason && SAFETY_FINISH_REASONS.has(String(finishReason)))) {
    throw new AiImageError("BLOCKED", res.status, `حُجِب من المزوّد: ${blockReason ?? finishReason}`);
  }

  const img = extractImagePart(json);
  if (!img) {
    throw new AiImageError("NO_IMAGE", res.status, "لم يُعِد المزوّد صورةً (قد يكون رفض التعديل).");
  }
  return { imageBase64: img.data, mimeType: img.mime };
}

/** رسالة عربية موجزة لكل تصنيف — للعرض/السجلّ (لا تُسرّب المفتاح). */
export function aiImageErrorMessageAr(kind: AiImageErrorKind): string {
  switch (kind) {
    case "AUTH":
      return "مفتاح الذكاء الاصطناعي خاطئ أو بلا صلاحية — تحقّق من الإعدادات.";
    case "QUOTA":
      return "تجاوزتَ حصّة/حدّ مزوّد الذكاء الاصطناعي — أعد المحاولة لاحقاً أو راجِع خطّتك.";
    case "BAD_INPUT":
      return "الطلب غير صالح (صورة أو برومت غير مقبول).";
    case "BLOCKED":
      return "حَجَب المزوّد الطلب لأسباب سلامة المحتوى — جرّب صورةً/برومتاً آخر.";
    case "NO_IMAGE":
      return "لم يُعِد المزوّد صورةً — جرّب مجدّداً أو بصياغة برومت أوضح.";
    case "NETWORK":
      return "تعذّر الوصول لمزوّد الذكاء الاصطناعي.";
    case "SERVICE":
    default:
      return "خطأ مؤقّت من مزوّد الذكاء الاصطناعي.";
  }
}

export interface VerifyGeminiResult {
  ok: boolean;
  /** عدد النماذج المتاحة (إن نجح الفحص) — مؤشّر بسيط على صلاحية المفتاح. */
  modelCount: number | null;
}

/**
 * يفحص صلاحية مفتاح Gemini بنداء **رخيص بلا توليد صورة** (GET /models) ⇒ لا كلفة توليد.
 * يرمي AiImageError عند مفتاح خاطئ/تعطّل.
 */
export async function verifyGeminiKey(apiKey: string, fetchImpl?: typeof fetch): Promise<VerifyGeminiResult> {
  const doFetch = fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${GEMINI_API_BASE}/models`, {
      method: "GET",
      headers: { "x-goog-api-key": apiKey, Accept: "application/json" },
    });
  } catch (e: any) {
    throw new AiImageError("NETWORK", 0, `تعذّر الوصول لمزوّد الذكاء الاصطناعي: ${e?.message ?? "خطأ شبكة"}`);
  }
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: { message?: string; status?: string } };
      detail = j?.error?.message ?? j?.error?.status ?? "";
    } catch {
      detail = "";
    }
    throw new AiImageError(classifyHttpError(res.status, String(detail)), res.status, String(detail) || `HTTP ${res.status}`);
  }
  const j = (await res.json().catch(() => ({}))) as { models?: unknown[] };
  return { ok: true, modelCount: Array.isArray(j?.models) ? j.models.length : null };
}
