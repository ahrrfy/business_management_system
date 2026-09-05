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
  | "IMAGE_OTHER" // عطل توليد بلا صورة أو تفسير من المزوّد
  | "TIMEOUT" // انتهت مهلة الاتصال بالمزوّد
  | "RESPONSE_TOO_LARGE" // تجاوز ردّ المزوّد حدّ ذاكرة الخادم
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
  /** مهلة الاتصال الخارجي؛ تمنع طلباً واحداً من احتجاز العامل بلا حد. */
  timeoutMs?: number;
  /** سقف بايتات JSON من المزوّد قبل التحليل. */
  maxResponseBytes?: number;
  /** يحجز الحصة والصلاحية التنفيذية لكل محاولة مدفوعة، بما فيها الإعادة. */
  runAttempt?: (run: () => Promise<GenerateStudioImageResult>) => Promise<GenerateStudioImageResult>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_OUTPUT_BASE64_CHARS = Math.ceil((8 * 1024 * 1024 * 4) / 3) + 4;
const ALLOWED_OUTPUT_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function isTimeout(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError";
}

/** يقرأ JSON المزوّد بتدفّق محدود، فلا يحمّل ردّاً خبيثاً/خاطئاً كاملاً إلى الذاكرة. */
async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AiImageError("RESPONSE_TOO_LARGE", res.status, "استجابة الذكاء الاصطناعي أكبر من الحد الآمن");
  }
  if (!res.body) return "";

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AiImageError("RESPONSE_TOO_LARGE", res.status, "استجابة الذكاء الاصطناعي أكبر من الحد الآمن");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
}

/** أسباب الحجب الأمنيّ من finishReason (candidate) — تُصنَّف BLOCKED لا NO_IMAGE. */
const SAFETY_FINISH_REASONS = new Set(["SAFETY", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "PROHIBITED_CONTENT", "RECITATION", "BLOCKLIST", "SPII"]);

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

/**
 * يجمع أجزاء النصّ من أوّل مرشّح ويصف سبب انتهاء المرشّح — للتشخيص عند NO_IMAGE/BLOCKED.
 *
 * ⭐ **جذر الفجوة**: عندما يرفض النموذج ضمنياً (يُرجع نصّاً بدلَ صورة، مثلاً "I cannot edit this")،
 * فالنصّ يحمل السبب الفعليّ لكن كنّا نتجاهله ⇒ المستخدم يرى «جرّب مجدّداً» بلا معرفة لماذا.
 * نستخرجه هنا كي يظهر في `AiImageError.message` ثمّ يُلحق بالرسالة العربية في الراوتر.
 *
 * حدود الأمان: يقتصّ النصّ عند ٥٠٠ حرف (يمنع تسريب حمولات ضخمة/مسيئة في السجلّ)، ويُنظّف من التحكّم.
 */
function extractProviderDiagnostic(json: any): string {
  const cand = json?.candidates?.[0];
  const parts = cand?.content?.parts;
  const finishReason = cand?.finishReason ? String(cand.finishReason) : "";
  const blockReason = json?.promptFeedback?.blockReason ? String(json.promptFeedback.blockReason) : "";
  const texts: string[] = [];
  if (Array.isArray(parts)) {
    for (const p of parts) {
      const t = p?.text;
      if (typeof t === "string" && t.trim()) texts.push(t.trim());
    }
  }
  // نظّف من الأسطر/التحكّم واقصص عند ٥٠٠ لكل حقل — كي لا يُفجّر السجلّ ولا يُعرض حمولةً خبيثة.
  const clean = (s: string) => s.replace(/[ -]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
  const bits: string[] = [];
  if (blockReason) bits.push(`blockReason=${clean(blockReason)}`);
  if (finishReason) bits.push(`finishReason=${clean(finishReason)}`);
  if (texts.length) bits.push(`نصّ المزوّد: "${clean(texts.join(" · "))}"`);
  return bits.join(" · ");
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
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const run = () => {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new AiImageError("TIMEOUT", 0, "انتهت مهلة مزوّد الذكاء الاصطناعي");
    return generateStudioImageAttempt(params, { ...opts, timeoutMs });
  };
  const attempt = () => {
    // افحص قبل حجز الحصة أيضاً: قد يستيقظ مؤقت الإعادة بعد انتهاء المهلة.
    if (Date.now() >= deadline) throw new AiImageError("TIMEOUT", 0, "انتهت مهلة مزوّد الذكاء الاصطناعي");
    return opts.runAttempt ? opts.runAttempt(run) : run();
  };
  try {
    return await attempt();
  } catch (error) {
    // IMAGE_OTHER بلا تفسير قد يكون مؤقتاً. محاولة إضافية واحدة بنفس المدخلات،
    // دون إعادة رفض السلامة/النص أو تمديد المهلة الكلية.
    if (!(error instanceof AiImageError) || error.kind !== "IMAGE_OTHER" || deadline - Date.now() <= 250) throw error;
    await new Promise(resolve => setTimeout(resolve, 250));
    return attempt();
  }
}

async function generateStudioImageAttempt(
  params: GenerateStudioImageParams,
  opts: AiImageCallOptions,
): Promise<GenerateStudioImageResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
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
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    if (isTimeout(e)) {
      throw new AiImageError("TIMEOUT", 0, "انتهت مهلة مزوّد الذكاء الاصطناعي");
    }
    throw new AiImageError("NETWORK", 0, `تعذّر الوصول لمزوّد الذكاء الاصطناعي: ${e?.message ?? "خطأ شبكة"}`);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const j = JSON.parse(await readBoundedText(res, Math.min(maxResponseBytes, 256 * 1024))) as {
        error?: { message?: string; status?: string };
      };
      detail = j?.error?.message ?? j?.error?.status ?? "";
    } catch {
      detail = "";
    }
    detail = String(detail).slice(0, 300);
    throw new AiImageError(classifyHttpError(res.status, detail), res.status, detail || `HTTP ${res.status}`);
  }

  let json: any;
  try {
    json = JSON.parse(await readBoundedText(res, maxResponseBytes));
  } catch (e: any) {
    if (e instanceof AiImageError) throw e;
    throw new AiImageError("SERVICE", res.status, `ردّ غير صالح من المزوّد: ${e?.message ?? ""}`);
  }

  // حجب أمنيّ على مستوى البرومت أو المرشّح ⇒ BLOCKED (لا NO_IMAGE) لرسالة أدقّ.
  const blockReason = json?.promptFeedback?.blockReason;
  const finishReason = json?.candidates?.[0]?.finishReason;
  const candidate = json?.candidates?.[0];
  const safetyBlocked = Array.isArray(candidate?.safetyRatings) && candidate.safetyRatings.some((rating: { blocked?: boolean }) => rating?.blocked === true);
  if (blockReason || safetyBlocked || (finishReason && SAFETY_FINISH_REASONS.has(String(finishReason)))) {
    const diag = extractProviderDiagnostic(json);
    throw new AiImageError(
      "BLOCKED",
      res.status,
      diag ? `حُجِب من المزوّد — ${diag}` : `حُجِب من المزوّد: ${blockReason ?? finishReason}`,
    );
  }

  const img = extractImagePart(json);
  if (!img) {
    const hasExplanation = (typeof candidate?.finishMessage === "string" && candidate.finishMessage.trim()) ||
      (Array.isArray(candidate?.content?.parts) && candidate.content.parts.some(
        (part: { text?: string }) => typeof part?.text === "string" && part.text.trim(),
      ));
    if (finishReason === "IMAGE_OTHER" && !hasExplanation) {
      throw new AiImageError("IMAGE_OTHER", res.status, "finishReason=IMAGE_OTHER");
    }
    // ⭐ فجوة تشخيصية أُغلقت: النموذج يُرجع أحياناً نصَّ رفضٍ ضمنيّ («I cannot edit this image...»)
    // أو ينهي بـfinishReason غير STOP (MAX_TOKENS/OTHER/IMAGE_OTHER) — كنّا نبتلع كليهما فيرى المالك
    // «جرّب مجدّداً» بلا معرفة السبب. الآن نمرّر السبب الحقيقيّ في `message` (يُلحقه الراوتر بالرسالة).
    const diag = extractProviderDiagnostic(json);
    throw new AiImageError(
      "NO_IMAGE",
      res.status,
      diag ? `لم يُعِد المزوّد صورةً — ${diag}` : "لم يُعِد المزوّد صورةً (قد يكون رفض التعديل).",
    );
  }
  if (
    !ALLOWED_OUTPUT_MIME_TYPES.has(img.mime.toLowerCase()) ||
    img.data.length > MAX_OUTPUT_BASE64_CHARS ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(img.data)
  ) {
    throw new AiImageError("SERVICE", res.status, "ردّ صورة غير صالح من المزوّد.");
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
    case "IMAGE_OTHER":
      return "تعذّر على المزوّد إنشاء الصورة حالياً؛ أعد المحاولة لاحقاً.";
    case "TIMEOUT":
      return "تأخر مزوّد الذكاء الاصطناعي في الردّ؛ أعد المحاولة لاحقاً.";
    case "RESPONSE_TOO_LARGE":
      return "أعاد مزوّد الذكاء الاصطناعي نتيجةً أكبر من الحد الآمن للخادم.";
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
  /** أسماء النماذج المتاحة (مجرَّدة من بادئة "models/") — للتحقّق من توفّر النموذج المُختار. */
  models: string[];
}

/**
 * يفحص صلاحية مفتاح Gemini بنداء **رخيص بلا توليد صورة** (GET /models) ⇒ لا كلفة توليد.
 * يعيد قائمة أسماء النماذج المتاحة ليتحقّق المستدعي من توفّر النموذج المُختار. يرمي AiImageError عند
 * مفتاح خاطئ/تعطّل.
 */
export async function verifyGeminiKey(apiKey: string, fetchImpl?: typeof fetch): Promise<VerifyGeminiResult> {
  const doFetch = fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${GEMINI_API_BASE}/models`, {
      method: "GET",
      headers: { "x-goog-api-key": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (e: any) {
    if (isTimeout(e)) throw new AiImageError("TIMEOUT", 0, "انتهت مهلة مزوّد الذكاء الاصطناعي");
    throw new AiImageError("NETWORK", 0, `تعذّر الوصول لمزوّد الذكاء الاصطناعي: ${e?.message ?? "خطأ شبكة"}`);
  }
  if (!res.ok) {
    let detail = "";
    try {
      const j = JSON.parse(await readBoundedText(res, 256 * 1024)) as { error?: { message?: string; status?: string } };
      detail = j?.error?.message ?? j?.error?.status ?? "";
    } catch {
      detail = "";
    }
    throw new AiImageError(classifyHttpError(res.status, String(detail)), res.status, String(detail) || `HTTP ${res.status}`);
  }
  let j: { models?: Array<{ name?: string }> } = {};
  try {
    j = JSON.parse(await readBoundedText(res, 256 * 1024));
  } catch (e) {
    if (e instanceof AiImageError) throw e;
  }
  const models = Array.isArray(j?.models)
    ? j.models.map((m) => String(m?.name ?? "").replace(/^models\//, "")).filter(Boolean)
    : [];
  return { ok: true, modelCount: models.length || null, models };
}

/** هل النموذج المُختار ضمن قائمة النماذج المتاحة؟ (يتساهل عند قائمة فارغة — تعذّر الجلب لا منع). */
export function isModelAvailable(effectiveModel: string, models: string[]): boolean {
  if (!models.length) return true;
  const target = effectiveModel.replace(/^models\//, "");
  return models.some((m) => m === target);
}
