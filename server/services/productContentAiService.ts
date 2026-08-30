import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  categories,
  productImages,
  productUnits,
  productVariants,
  products,
} from "../../drizzle/schema";
import { saveProductContentDraft } from "./productContentGovernanceService";
import { getAiStudioRuntime } from "./imageStudioSettingsService";
import {
  ImageStudioGuardError,
  imageStudioGuardErrorMessageAr,
  runGuardedImageStudioCall,
} from "./imageStudioUsageGuard";
import { requireDb } from "./tx";
import { getImageStore } from "../lib/imageStore";
import { decodeDataUrl } from "../imageRoute";
import { logger } from "../logger";
import {
  AI_PROVIDER_ERROR_PRESENTATION,
  aiProductDraftSchema,
  canonicalJson,
  classifyGeminiError,
  extractedProductFactsSchema,
  productFactsSchema,
  validateAiProductDraft,
  type AiProductDraft,
  type AiProviderErrorCategory,
  type ExtractedProductFacts,
  type ProductFacts,
} from "../../shared/productContentAi";

const GEMINI_API_BASE = (
  process.env.GEMINI_API_BASE ??
  "https://generativelanguage.googleapis.com/v1beta"
).replace(/\/+$/, "");

// ── نماذج المحتوى (نصّ/بصريّ) — منفصلةٌ صراحةً عن نماذج توليد الصور ────────────────
// السبب: `runtime.model` من إعدادات الاستوديو يشير في العادة إلى نموذج **توليد صور**
// (aiPrompt.ts: gemini-2.5-flash-image). الاستعمال هنا مختلف: نطلب مخرَج JSON مُهيكَلاً
// (نصّاً/بصريّاً). النماذج الصوريّة لا تلبّي هذا العقد ⇒ نتجاوزها بمجموعةٍ صريحة، لا
// بمطابقة نصّيّة هشّة كـ`.includes("image")` كانت تفوت imagen-3.0 أو نماذج مستقبليّة.
//
// ⭐ اختيار الاسم — دَرسٌ اشتراه سجلّ الإنتاج في ٣٠/٨/٢٦:
// كنّا نستعمل الاسم المرقَّم `gemini-2.5-flash` فردَّ Google 404 برسالةٍ صريحة: «هذا
// النموذج لم يعد متاحاً للمستعملين الجدد»، ثمّ سقط الاحتياطيّ `gemini-1.5-flash` بـ«غير
// موجودٍ في v1beta لـgenerateContent». أرقامُ الإصدارات تشيخ خلال شهور — أسماءُ `-latest`
// اسمٌ ثابتٌ تصونه Google ويعيد الربطَ إلى النسخة المستقرّة الحالية بلا نشرٍ من طرفنا.
// وأيّ طوارئ (Google تُغيّر عقد الاسم، أو نموذجٌ محدَّد يعمل أفضل لحالتنا) يعالجها
// المتغيّران البيئيّان أدناه بلا نشرٍ ولا تعديل شيفرة.
const DEFAULT_CONTENT_MODEL =
  process.env.PRODUCT_CONTENT_MODEL?.trim() || "gemini-flash-latest";
/** نموذجٌ احتياطيٌّ — نلجأ إليه حين يفشل الأساسيّ بـMODEL_NOT_FOUND. اسمُ `-latest` مصونٌ من الهجر. */
const CONTENT_MODEL_FALLBACK =
  process.env.PRODUCT_CONTENT_MODEL_FALLBACK?.trim() || "gemini-flash-lite-latest";
/** نماذجُ توليد الصور — لا تُنتج JSON مُهيكَلاً؛ نتجاوزها بنيوياً إن ضُبطت في الاستوديو. */
const IMAGE_GENERATION_MODELS = new Set<string>([
  "gemini-2.5-flash-image",
  "gemini-2.5-flash-image-preview",
  "imagen-3.0-generate-001",
  "imagen-3.0-generate-002",
]);
/** نماذجٌ أثبت الإنتاج هجرَها ⇒ نتجاوزها صراحةً حتى لو بقيت مضبوطةً في الاستوديو،
 *  فلا نبدأ محاولةً محكومٌ عليها بـ404 قبل أن نلجأ إلى الاحتياطيّ. */
const DEPRECATED_CONTENT_MODELS = new Set<string>([
  "gemini-2.5-flash",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
  "gemini-pro",
]);

/** يحلّ نموذج المحتوى المستعمَل — يتجاوز نماذج الصور والنماذج المهجورة إلى الافتراضيّ. */
function resolveContentModel(configuredModel: string | null | undefined): string {
  const normalized = (configuredModel ?? "").trim();
  if (!normalized) return DEFAULT_CONTENT_MODEL;
  if (IMAGE_GENERATION_MODELS.has(normalized)) return DEFAULT_CONTENT_MODEL;
  if (DEPRECATED_CONTENT_MODELS.has(normalized)) return DEFAULT_CONTENT_MODEL;
  return normalized;
}

/** خطأٌ مصنَّفٌ من مزوّد الذكاء — يحمل الفئة والتفصيل الأصليّ للتسجيل التشغيليّ.
 *  يُحوَّل إلى TRPCError برسالةٍ عربيّة موحّدة عند حدود المعالج (toTRPCError). */
class AiProviderError extends Error {
  constructor(
    public readonly category: AiProviderErrorCategory,
    public readonly httpStatus: number,
    public readonly detail: string | undefined,
  ) {
    super(`${category}${detail ? ": " + detail.slice(0, 120) : ""}`);
    this.name = "AiProviderError";
  }
}

/** خريطةُ فئات المزوّد إلى رموز tRPC — مركزيّةٌ لضمان الاتّساق بين الاستدعاءات. */
const CATEGORY_TO_TRPC_CODE: Record<
  AiProviderErrorCategory,
  "PRECONDITION_FAILED" | "BAD_REQUEST" | "TOO_MANY_REQUESTS" | "INTERNAL_SERVER_ERROR" | "TIMEOUT"
> = {
  MODEL_NOT_FOUND: "PRECONDITION_FAILED",
  SAFETY_BLOCK: "BAD_REQUEST",
  QUOTA_EXCEEDED: "TOO_MANY_REQUESTS",
  INVALID_INPUT: "BAD_REQUEST",
  AUTH: "PRECONDITION_FAILED",
  SERVER_TRANSIENT: "INTERNAL_SERVER_ERROR",
  TIMEOUT: "TIMEOUT",
  UNKNOWN: "INTERNAL_SERVER_ERROR",
};

/** يحوّل AiProviderError إلى TRPCError بالرسالة العربيّة الموحّدة للفئة، مع إبقاء الخطأ
 *  الأصليّ في cause كي يظهر providerCategory في shape.data.providerCategory (server/trpc.ts). */
function toTRPCError(err: AiProviderError): TRPCError {
  const presentation = AI_PROVIDER_ERROR_PRESENTATION[err.category];
  return new TRPCError({
    code: CATEGORY_TO_TRPC_CODE[err.category],
    message: presentation.message,
    cause: err,
  });
}
const TEXT_PROMPT_VERSION = "product-content-ar-v2";
const VISION_PROMPT_VERSION = "product-content-ar-v3-vision";
const MAX_RESPONSE_BYTES = 512 * 1024;
const TIMEOUT_MS = 25_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
// ٤ صور كسقفٍ عمليّ: 4 × 900KB = 3.6MB (بعيدٌ عن حدّ Gemini ~20MB) + انتباه بصريّ مركّز
// بلا ازدحام يذوّب الاختلاف بين الصور. الأولوية لـisPrimary ثمّ sortOrder.
const MAX_VISION_IMAGES = 4;
const MAX_IMAGE_BYTES = 900_000;

type TextFetch = typeof fetch;

// ────────────────────────────────────────────────────────────────────────────────
// نداءُ Gemini الموحَّد — يجمع: fetch + timeout + تصنيف الأخطاء + fallback بين النماذج +
// تسجيلٌ تشغيليٌّ (info للنجاح، warn للفشل). كلّ الاستدعاءات لـGemini تمرّ عبره —
// دالّةٌ واحدة تُصلَح مرّةً وتنعكس على كلّ المسارات (generate + extract + مستقبلٌ آخر).
// ────────────────────────────────────────────────────────────────────────────────
async function callGeminiWithFallback(opts: {
  runtime: { apiKey: string; model: string };
  payload: unknown;
  fetchImpl: TextFetch;
  timeoutMs: number;
  callName: string; // مثل "generateContentDraft" — يُطبع في السجلّ للتصفية
  actor?: { userId: number; branchId?: number | null };
}): Promise<{ body: any; modelUsed: string; fellBack: boolean }> {
  const primary = resolveContentModel(opts.runtime.model);
  // لا نجرّب fallback إن كان الأساسيّ هو الاحتياطيّ نفسه — تجنّبٌ لدائرةٍ لا تفيد.
  const fallback = primary === CONTENT_MODEL_FALLBACK ? null : CONTENT_MODEL_FALLBACK;

  const attempt = async (model: string): Promise<any> => {
    const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
    const startMs = Date.now();
    let response: Response;
    try {
      response = await opts.fetchImpl(url, {
        method: "POST",
        headers: {
          "x-goog-api-key": opts.runtime.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(opts.payload),
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(timeout);
      const detail = err?.name === "AbortError" ? "aborted (client timeout)" : String(err?.message ?? "network");
      throw new AiProviderError("TIMEOUT", 0, detail);
    }
    try {
      if (!response.ok) {
        let detail = "";
        try {
          const errorBody = JSON.parse(await readBoundedText(response, 32 * 1024));
          detail = String(errorBody?.error?.message ?? "").slice(0, 250);
        } catch {
          detail = "";
        }
        const category = classifyGeminiError(response.status, detail);
        throw new AiProviderError(category, response.status, detail);
      }
      const body = JSON.parse(await readBoundedText(response, MAX_RESPONSE_BYTES));
      logger.info(
        {
          model,
          callName: opts.callName,
          durationMs: Date.now() - startMs,
          userId: opts.actor?.userId,
          branchId: opts.actor?.branchId ?? null,
        },
        "ai.gemini.call_ok",
      );
      return body;
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    const body = await attempt(primary);
    return { body, modelUsed: primary, fellBack: false };
  } catch (err) {
    // MODEL_NOT_FOUND: النموذج المضبوط لا يخدمه المفتاح ⇒ حاول بالاحتياطيّ مرّةً واحدة.
    // بقيّة الفئات (AUTH/SAFETY/QUOTA/...) لا يفيدها fallback — قطعٌ فوريّ.
    if (err instanceof AiProviderError && err.category === "MODEL_NOT_FOUND" && fallback) {
      logger.warn(
        {
          primary,
          fallback,
          detail: err.detail,
          callName: opts.callName,
          userId: opts.actor?.userId,
        },
        "ai.gemini.model_fallback",
      );
      try {
        const body = await attempt(fallback);
        return { body, modelUsed: fallback, fellBack: true };
      } catch (err2) {
        if (err2 instanceof AiProviderError) {
          logger.warn(
            {
              primary,
              fallback,
              category: err2.category,
              httpStatus: err2.httpStatus,
              detail: err2.detail,
              callName: opts.callName,
            },
            "ai.gemini.fallback_failed",
          );
        }
        throw err2;
      }
    }
    if (err instanceof AiProviderError) {
      logger.warn(
        {
          model: primary,
          category: err.category,
          httpStatus: err.httpStatus,
          detail: err.detail,
          callName: opts.callName,
          userId: opts.actor?.userId,
        },
        "ai.gemini.call_failed",
      );
    }
    throw err;
  }
}

type CachedDraft = { result: ProductContentDraftResult; expiresAt: number };
const draftCache = new Map<string, CachedDraft>();
const inFlightDrafts = new Map<string, Promise<ProductContentDraftResult>>();
const MAX_CACHE_ENTRIES = 200;

function pruneDraftCache() {
  const now = Date.now();
  draftCache.forEach((value, key) => {
    if (value.expiresAt <= now) draftCache.delete(key);
  });
  if (draftCache.size <= MAX_CACHE_ENTRIES) return;
  const oldest = Array.from(draftCache.entries()).sort(
    (a, b) => a[1].expiresAt - b[1].expiresAt,
  );
  oldest
    .slice(0, draftCache.size - MAX_CACHE_ENTRIES)
    .forEach(([key]) => draftCache.delete(key));
}

const SYSTEM_PROMPT = `أنت محرر محتوى كتالوج عربي يعمل داخل نظام مبيعات ومخزون.
مصدر الحقيقة الوحيد للمواصفات هو الحقول المنظمة داخل VERIFIED_PRODUCT_FACTS.
finalProductName وinputDescription هما مدخل الصياغة الذي كتبه الموظف: استخدم الاسم النهائي كمرجع أساسي لألفاظ المنتج وترتيبها، واستفد من الوصف لتحسين الصياغة، لكن لا تعتبر أي معلومة فيهما مواصفة مؤكدة إذا لم توجد في الحقول المنظمة.
إذا تعارض الاسم أو الوصف المدخل مع الحقول المنظمة، فالأولوية للحقول المنظمة ولا تذكر المعلومة المتعارضة.
لا تستخدم معرفة خارجية ولا تكمل المعلومات الناقصة بالتخمين.
كل claim يجب أن يحتوي evidenceKeys تشير إلى مفاتيح موجودة في الحقائق.
لا تخترع مادة أو ميزة أو ضماناً أو بلداً للصناعة أو شهادة أو جودة أو توافقاً.
لا تستخدم عبارات مثل الأفضل، رقم 1، الأرخص، مضمون، أصلي، فاخر، مقاوم للماء، الأكثر مبيعاً أو صديق للبيئة إلا إذا كانت موجودة في verifiedClaims.
لا تضع السعر أو الخصم أو المخزون داخل الاسم أو الوصف.
إذا كان اللون أو المقاس متغيراً مستقلاً فلا تضعه في seoTitle أو shortTitle، ويمكن وضعه فقط في posLabel أو invoiceLabel عند الحاجة.
إذا كانت البيانات غير كافية، أعد نصاً محافظاً وأضف السبب إلى warnings أو unsupportedClaims.
استخدم عربية واضحة مناسبة للعراق بلا تشكيل ولا كشيدة.
أعد JSON فقط مطابقاً للمخطط المطلوب.`;

// بروتوكول الأدلّة البصريّة — يُلحَق بالبرومبت فقط عند إرسال صور معتمَدة مع الطلب. الصور
// تُعنوَن image.0, image.1, ... بترتيب ورودها في parts. الادّعاء البصريّ يجب أن يحمل مفتاح
// image.N في evidenceKeys ليُميَّز عن الادّعاء النصّيّ المدعوم بحقلٍ مُنظَّم.
const VISUAL_PROTOCOL = `PRODUCT_IMAGES:
الصور المرفقة معتمَدة (مرت مراجعة الاستوديو) وترقيمها image.0, image.1, image.2, ... حسب ترتيب ورودها قبل النصّ.

يُسمح استنتاجه بصرياً — وثّق مصدره بمفتاح image.N في evidenceKeys:
- اللون الظاهر (أخضر، أزرق داكن، ذهبيّ…)
- النوع العام المرئيّ (كتاب، دفتر ملاحظات، قلم، علبة أقلام…)
- شعار أو نصّ ماركة مقروء (اكتب النصّ كما هو ظاهر بلا ترجمة)
- عدد قطعٍ ظاهرة بوضوحٍ داخل تغليفٍ شفّاف
- الشكل العام (مستطيل، دائريّ، مجلَّد بسلك، أسطوانيّ…)
- وجود تغليفٍ من عدمه، ولون التغليف

يُحظَر استنتاجه بصرياً — أضفه إلى unsupportedClaims إن ورَد بلا حقلٍ مقابل في VERIFIED_PRODUCT_FACTS:
- المادّة (ورق/بلاستيك/معدن…) ما لم يكن مطبوعاً واضحاً على العلبة
- عدد الصفحات، السماكة، الأبعاد بالسنتيمترات، الوزن
- بلد الصنع، الشهادات، الضمان، تاريخ إنتاج
- سعرٌ أو تخفيض
- كلّ ادّعاءٍ عن الجودة/المتانة/الأمان

إن تعارضت الصورة مع حقلٍ مُنظَّم فالأولوية للحقل المُنظَّم.
لا تخترع أرقاماً مصدرها الصورة (عدد الصفحات، قياس بالمليمترات، وزن…) — الأرقام في المخرَج يجب أن تأتي من حقلٍ مُنظَّم فقط.`;

// ⚠️ Gemini responseSchema يقبل مجموعةً فرعيّةً من OpenAPI 3.0 لا JSON Schema الكامل:
// - `additionalProperties` غير مدعوم ⇒ محذوف من كل مستوى (كان يرمي 400 Invalid JSON payload).
// - `type: ["string", "null"]` (array form) غير مدعوم ⇒ نستعمل `type: "string", nullable: true`.
// - المتاح: type, properties, required, items, enum, format, description, nullable, minimum,
//   maximum, minItems, maxItems, minLength, maxLength.
// وثائق Google: https://ai.google.dev/gemini-api/docs/structured-output#supported-schemas
const OUTPUT_JSON_SCHEMA = {
  type: "object",
  required: [
    "seoTitle",
    "shortTitle",
    "posLabel",
    "invoiceLabel",
    "marketingCopy",
    "description",
    "keywords",
    "claims",
    "unsupportedClaims",
    "warnings",
    "confidence",
  ],
  properties: {
    seoTitle: { type: "string" },
    shortTitle: { type: "string" },
    posLabel: { type: "string" },
    invoiceLabel: { type: "string" },
    marketingCopy: { type: "string" },
    description: { type: "string" },
    keywords: {
      type: "array",
      maxItems: 20,
      items: { type: "string" },
    },
    claims: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        required: ["text", "evidenceKeys"],
        properties: {
          text: { type: "string" },
          evidenceKeys: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: { type: "string" },
          },
        },
      },
    },
    unsupportedClaims: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        required: ["text", "reason"],
        properties: {
          text: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    warnings: {
      type: "array",
      maxItems: 20,
      items: { type: "string" },
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
} as const;

function textFromGeminiResponse(body: any): string {
  const parts = body?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error("AI response too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("AI response too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  ).toString("utf8");
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    return trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
  }
  return trimmed;
}

export type ProductContentDraftResult = {
  draft: AiProductDraft;
  validation: ReturnType<typeof validateAiProductDraft>;
  cacheKey: string;
  model: string;
  promptVersion: string;
  cacheHit: boolean;
  // عدد الصور المعتمَدة التي دخلت البرومبت البصريّ فعلاً (0 ⇒ توليدٌ نصّيّ خالص).
  // الواجهة تعرضه لتُبيّن للموظّف/المدير أنّ الاقتراح استفاد من الصور.
  imagesUsed: number;
};

type VisualCacheContext = { imageHashes: string[] } | null;

export function productContentCacheKey(
  facts: ProductFacts,
  model: string,
  visual: VisualCacheContext = null,
): string {
  // نسخة البرومبت تختلف بحسب وجود الصور ⇒ لا تصادم كاش بين المسارَين حتى مع نفس الحقائق.
  const promptVersion = visual ? VISION_PROMPT_VERSION : TEXT_PROMPT_VERSION;
  return createHash("sha256")
    .update(
      canonicalJson({ facts, model, promptVersion, visual }),
      "utf8",
    )
    .digest("hex");
}

type VisionImage = {
  index: number;
  mime: string;
  data: string; // base64
  contentHash: string;
};

/**
 * يحمّل حتى ٤ صور معتمَدة (`reviewStatus='APPROVED'`) لمنتجٍ ما بترتيب: `isPrimary` ثمّ `sortOrder`.
 * الصورة من R2 عبر `imageStore.getBuffer` (كائنٌ معنون-بالمحتوى)، أو من `url` كـdata-URL موروث.
 * فشل صورةٍ منفردة يُتجاهَل بصمتٍ (سنستعمل الباقي) — لا يُعطَّل التوليد من أجل صورةٍ واحدة تالفة.
 * ⛔ لا نُثِق بمعرّفات صورٍ يمرّرها العميل: الخدمة تختار بنفسها من DB بشرط الاعتماد.
 */
async function loadProductImagesForVision(
  productId: number,
): Promise<VisionImage[]> {
  const rows = await requireDb()
    .select({
      id: productImages.id,
      mime: productImages.mime,
      bytes: productImages.bytes,
      objectKey: productImages.objectKey,
      contentHash: productImages.contentHash,
      url: productImages.url,
    })
    .from(productImages)
    .where(
      and(
        eq(productImages.productId, productId),
        eq(productImages.reviewStatus, "APPROVED"),
      ),
    )
    .orderBy(desc(productImages.isPrimary), asc(productImages.sortOrder))
    .limit(MAX_VISION_IMAGES);

  const out: VisionImage[] = [];
  const store = getImageStore();
  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    try {
      let bytes: Buffer | null = null;
      let mime = row.mime ?? "";
      if (row.objectKey && row.contentHash) {
        // R2: نُقيّد القراءة بـMAX_IMAGE_BYTES منعاً لتضخّم غير متوقّع (row.bytes قد يكذب في بيانات
        // موروثة؛ الحدّ العلويّ الصلب هنا حاسم قبل إرسال البايتات إلى Gemini).
        const expected = Math.min(row.bytes ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES);
        bytes = await store.getBuffer(row.objectKey, expected);
      } else if (row.url) {
        // موروث: data-URL في العمود نصّاً. decodeDataUrl يحقّق الصيغة وقائمة mime البيضاء.
        const decoded = decodeDataUrl(row.url);
        if (decoded && decoded.bytes.length <= MAX_IMAGE_BYTES) {
          bytes = decoded.bytes;
          mime = decoded.mime;
        }
      }
      if (!bytes || bytes.length === 0 || !mime) continue;
      out.push({
        index: idx,
        mime,
        data: bytes.toString("base64"),
        contentHash: row.contentHash ?? createHash("sha256").update(bytes).digest("hex"),
      });
    } catch (err) {
      logger.warn(
        { err, productId, imageId: row.id },
        "vision: skipping image (load failed)",
      );
    }
  }
  return out;
}

export async function generateProductContentDraft(
  rawFacts: unknown,
  opts: {
    fetchImpl?: TextFetch;
    timeoutMs?: number;
    forceRefresh?: boolean;
    actor?: { userId: number; branchId?: number | null };
    // productId اختياريّ: إن وُجد وله صور معتمَدة، ينفّذ المسار البصريّ (Gemini vision).
    // إن غاب أو لم يجد صوراً، يظلّ المسار نصّياً بحتاً — لا فشل صامت، لا تعطيل ميزة قائمة.
    productId?: number;
    // لحقن صورٍ في الاختبار دون الحاجة إلى R2/DB فعليَّين.
    imagesOverride?: VisionImage[];
  } = {},
): Promise<ProductContentDraftResult> {
  const facts = productFactsSchema.parse(rawFacts);
  const runtime = await getAiStudioRuntime();
  if (!runtime) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "مسار الذكاء الاصطناعي غير مفعّل أو لا يوجد مفتاح صالح في إعدادات الاستوديو.",
    });
  }
  if (runtime.provider !== "GEMINI") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "مزود محتوى المنتج غير مدعوم حالياً.",
    });
  }
  if (
    !opts.actor ||
    !Number.isSafeInteger(opts.actor.userId) ||
    opts.actor.userId <= 0
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "تعذر تحديد مستخدم طلب توليد المحتوى.",
    });
  }

  // النموذج المستعمَل يُحسم داخل callGeminiWithFallback (resolveContentModel + احتياطيّ عند
  // MODEL_NOT_FOUND). هنا نبني الكاش على النموذج **الأساسيّ** المشتقّ فقط — بدون fallback:
  // كاشُ ناتجٍ بواسطة نموذج مختلف لا يمثّل ناتج النموذج المضبوط، فيُخفي المشكلة عن المدير.
  const cacheModel = resolveContentModel(runtime.model);

  // نحمّل الصور المعتمَدة **قبل** حساب مفتاح الكاش ⇒ مسارٌ نصّيّ ومسارٌ بصريّ لهما مفتاحان
  // مختلفان، وإعادة رفع صورةٍ (contentHash جديد) تُبطل الكاش تلقائياً.
  // ⛔ لا نطلب الصور من العميل: الخدمة تختار بنفسها بشرط APPROVED.
  const images: VisionImage[] =
    opts.imagesOverride ??
    (opts.productId && Number.isSafeInteger(opts.productId) && opts.productId > 0
      ? await loadProductImagesForVision(opts.productId)
      : []);
  const visualContext: VisualCacheContext =
    images.length > 0 ? { imageHashes: images.map((i) => i.contentHash).sort() } : null;
  const promptVersionUsed = visualContext
    ? VISION_PROMPT_VERSION
    : TEXT_PROMPT_VERSION;
  const cacheKey = productContentCacheKey(facts, cacheModel, visualContext);

  pruneDraftCache();
  if (!opts.forceRefresh) {
    const cached = draftCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now())
      return { ...cached.result, cacheHit: true };
    if (cached) draftCache.delete(cacheKey);
    const pending = inFlightDrafts.get(cacheKey);
    if (pending) return { ...(await pending), cacheHit: true };
  }

  const generate = async (): Promise<ProductContentDraftResult> => {
    // ترتيب parts متعمَّد: الصور أوّلاً (يزيد انتباه النموذج للبصريّ) والنصّ آخراً بحيث ترد
    // التعليمات النهائية مباشرةً قبل التوليد. البروتوكول البصريّ يُلحَق فقط عند وجود صور.
    const imageParts = images.map((img) => ({
      inlineData: { mimeType: img.mime, data: img.data },
    }));
    const textPrompt = visualContext
      ? `${SYSTEM_PROMPT}\n\n${VISUAL_PROTOCOL}\n\nVERIFIED_PRODUCT_FACTS:\n${JSON.stringify(facts)}\n\nأعد مسودة المنتج الآن مستنداً إلى الحقائق المُنظَّمة والصور المرفقة.`
      : `${SYSTEM_PROMPT}\n\nVERIFIED_PRODUCT_FACTS:\n${JSON.stringify(facts)}\n\nأعد مسودة المنتج الآن.`;

    const payload = {
      contents: [
        {
          role: "user",
          parts: [...imageParts, { text: textPrompt }],
        },
      ],
      generationConfig: {
        temperature: 0.15,
        responseMimeType: "application/json",
        responseSchema: OUTPUT_JSON_SCHEMA,
      },
    };

    // نداءُ Gemini الموحَّد: fetch + timeout + تصنيف الأخطاء + fallback + تسجيل.
    let body: any;
    let modelUsed: string;
    try {
      const result = await callGeminiWithFallback({
        runtime: { apiKey: runtime.apiKey, model: runtime.model },
        payload,
        fetchImpl: opts.fetchImpl ?? fetch,
        timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
        callName: "generateContentDraft",
        actor: opts.actor,
      });
      body = result.body;
      modelUsed = result.modelUsed;
    } catch (err) {
      if (err instanceof AiProviderError) throw toTRPCError(err);
      throw err;
    }

    let draft: AiProductDraft;
    try {
      draft = aiProductDraftSchema.parse(
        JSON.parse(stripCodeFence(textFromGeminiResponse(body))),
      );
    } catch {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "مسودة الذكاء الاصطناعي لا تطابق مخطط المحتوى المطلوب.",
      });
    }

    const validation = validateAiProductDraft(draft, facts);
    return {
      draft,
      validation,
      cacheKey,
      model: modelUsed,
      promptVersion: promptVersionUsed,
      cacheHit: false,
      imagesUsed: images.length,
    };
  };

  const pending = runGuardedImageStudioCall({
    service: "AI",
    userId: opts.actor.userId,
    branchId: opts.actor.branchId ?? null,
    run: generate,
  });
  inFlightDrafts.set(cacheKey, pending);
  try {
    const result = await pending;
    draftCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    pruneDraftCache();
    return result;
  } catch (error) {
    if (error instanceof ImageStudioGuardError) {
      throw new TRPCError({
        code:
          error.kind === "DAILY_BUDGET_EXHAUSTED"
            ? "PRECONDITION_FAILED"
            : "TOO_MANY_REQUESTS",
        message: imageStudioGuardErrorMessageAr(error.kind),
      });
    }
    throw error;
  } finally {
    inFlightDrafts.delete(cacheKey);
  }
}

// م٣ — استخراج الحقائق الأساسية من صورة (للتدفّق «صورة أوّلاً»).
const EXTRACTION_PROMPT_VERSION = "product-extract-ar-v1";
const EXTRACTION_ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

const EXTRACTION_PROMPT = `أنت محلّل صور منتجات لكتالوج مكتبة وقرطاسية عراقية.
مهمّتك استخراج بيانات المنتج التي **تظهر بوضوح** في الصورة، لا أكثر. أنت لا تخترع، لا تُكمّل، لا تُخمّن.

يُسمح استخراجه:
- suggestedName: مقترحٌ مركّبٌ ممّا تراه (النوع + الماركة + الموديل إن كان مقروءاً). أمثلة: «دفتر ملاحظات روتا سلك A5»، «قلم حبر بايلوت أزرق»، «علبة أقلام رصاص فابر كاستل ١٢ قطعة».
- productType: النوع العامّ المرئيّ عربياً (كتاب، دفتر ملاحظات، قلم، علبة أقلام، حقيبة، مسطرة، ممحاة…).
- brand: نصّ الماركة المقروء على الغلاف كما هو (عربياً أو لاتينياً — لا تُترجم).
- modelHint: رقم موديل أو نصّ تعريفيّ ثانويّ **مطبوعٌ ظاهر** (مثلاً A5، M-101، No. 2B).
- description: جملة أو اثنتان تصفان ما هو مرئيّ فعلاً: اللون، الشكل، وجود تغليف، عدد قطعٍ ظاهر بوضوح في تغليف شفّاف. حدّ ٥٠٠ حرف.
- keywords: كلمات بحث محتملة من المرئيّ (حدّ ١٠).

يُحظَر إخراجه — إن فكّرتَ فيه فأضفه إلى unsupportedGuesses مع سبب الرفض:
- سعر أو تخفيض أو خصم
- مادّة داخلية (ورق/معدن/بلاستيك…) ما لم تكن مطبوعةً واضحةً على الغلاف
- عدد صفحات ما لم يكن مطبوعاً
- أبعاد بالسنتيمتر أو الوزن
- بلد صنع ما لم يكن مطبوعاً
- ادّعاء جودة/متانة/أمان/توافق
- شهادات أو ضمانات

قواعد الصياغة:
- إن لم تتبيّن حقلاً فبقيمة null (لا فراغ ولا «غير معروف»).
- عربية مبسّطة مناسبة للعراق، بلا تشكيل ولا كشيدة.
- ثقة (confidence): high إذا كان النصّ/الشعار مقروءاً واضحاً، medium إذا استنتجتَ النوع بصرياً بلا نصّ، low للصور الغامضة/الجانبية/المشوّشة.

أعد JSON فقط مطابقاً لمخطط المخرَج.`;

// ⚠️ نفس قيود Gemini OpenAPI subset المذكورة أعلى OUTPUT_JSON_SCHEMA:
// - بلا `additionalProperties` (غير مدعوم على أيّ مستوى)
// - بلا `type: ["string", "null"]` — نستعمل `type: "string", nullable: true` بدلاً عنه.
const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  required: [
    "suggestedName",
    "productType",
    "brand",
    "modelHint",
    "description",
    "keywords",
    "confidence",
    "unsupportedGuesses",
  ],
  properties: {
    suggestedName: { type: "string", nullable: true },
    productType: { type: "string", nullable: true },
    brand: { type: "string", nullable: true },
    modelHint: { type: "string", nullable: true },
    description: { type: "string" },
    keywords: {
      type: "array",
      maxItems: 10,
      items: { type: "string" },
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    unsupportedGuesses: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        required: ["text", "reason"],
        properties: {
          text: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

export type ExtractProductFactsResult = {
  facts: ExtractedProductFacts;
  model: string;
  promptVersion: string;
};

/**
 * يستخرج حقائق منتجٍ من صورةٍ واحدة (للتدفّق «صورة أوّلاً»، م٣).
 * ⛔ لا يُنشئ منتجاً — الموظّف يراجع الاقتراحات ثمّ يطبّقها على النموذج.
 * تحت نفس حارس الاستخدام اليوميّ (٢٠ نداءً) — الحارس يعدّ النداءات لا البايتات.
 */
export async function extractProductFactsFromImage(
  input: {
    imageBase64: string;
    mime: string;
    contextName?: string | null;
  },
  opts: {
    fetchImpl?: TextFetch;
    timeoutMs?: number;
    actor?: { userId: number; branchId?: number | null };
  } = {},
): Promise<ExtractProductFactsResult> {
  if (!EXTRACTION_ALLOWED_MIMES.has(input.mime)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "نوع الصورة غير مدعوم؛ استعمل JPEG/PNG/WEBP/GIF/AVIF.",
    });
  }
  const bytesLen = Math.ceil((input.imageBase64.length * 3) / 4);
  if (bytesLen > MAX_IMAGE_BYTES) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `حجم الصورة يتجاوز الحدّ (${MAX_IMAGE_BYTES / 1024}KB).`,
    });
  }
  const runtime = await getAiStudioRuntime();
  if (!runtime) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "مسار الذكاء الاصطناعي غير مفعّل أو لا يوجد مفتاح صالح في إعدادات الاستوديو.",
    });
  }
  if (runtime.provider !== "GEMINI") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "مزود محتوى المنتج غير مدعوم حالياً.",
    });
  }
  if (
    !opts.actor ||
    !Number.isSafeInteger(opts.actor.userId) ||
    opts.actor.userId <= 0
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "تعذر تحديد مستخدم طلب الاستخراج.",
    });
  }

  const extract = async (): Promise<ExtractProductFactsResult> => {
    const contextLine = input.contextName
      ? `\n\nCONTEXT (ما كتبه الموظّف حتى الآن، للاسترشاد لا للنسخ): ${input.contextName.slice(0, 160)}`
      : "";
    const payload = {
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: input.mime, data: input.imageBase64 } },
            { text: `${EXTRACTION_PROMPT}${contextLine}\n\nاستخرج الآن.` },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: EXTRACTION_JSON_SCHEMA,
      },
    };

    // نداءُ Gemini الموحَّد: fetch + timeout + تصنيف الأخطاء + fallback + تسجيل.
    let body: any;
    let modelUsed: string;
    try {
      const result = await callGeminiWithFallback({
        runtime: { apiKey: runtime.apiKey, model: runtime.model },
        payload,
        fetchImpl: opts.fetchImpl ?? fetch,
        timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
        callName: "extractProductFactsFromImage",
        actor: opts.actor,
      });
      body = result.body;
      modelUsed = result.modelUsed;
    } catch (err) {
      if (err instanceof AiProviderError) throw toTRPCError(err);
      throw err;
    }

    let facts: ExtractedProductFacts;
    try {
      facts = extractedProductFactsSchema.parse(
        JSON.parse(stripCodeFence(textFromGeminiResponse(body))),
      );
    } catch {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "نتيجة الاستخراج لا تطابق المخطط المطلوب.",
      });
    }

    return { facts, model: modelUsed, promptVersion: EXTRACTION_PROMPT_VERSION };
  };

  try {
    return await runGuardedImageStudioCall({
      service: "AI",
      userId: opts.actor.userId,
      branchId: opts.actor.branchId ?? null,
      run: extract,
    });
  } catch (error) {
    if (error instanceof ImageStudioGuardError) {
      throw new TRPCError({
        code:
          error.kind === "DAILY_BUDGET_EXHAUSTED"
            ? "PRECONDITION_FAILED"
            : "TOO_MANY_REQUESTS",
        message: imageStudioGuardErrorMessageAr(error.kind),
      });
    }
    throw error;
  }
}

// ── هجين: توليدٌ تلقائيّ يُشغَّل بعد اعتماد صورة استوديو (fire-and-forget) ────────────

export type AutoContentDraftOutcome =
  | { draftId: number; reason: "created" }
  | {
      draftId: null;
      reason:
        | "product-not-found"
        | "no-images"
        | "validation-failed"
        | "budget-exhausted"
        | "generate-failed"
        | "save-failed";
      detail?: string;
    };

/**
 * يبني حقائق منتجٍ ما مباشرةً من قاعدة البيانات كما تراها الشاشة: اسم، وصف، فئة، نوع، ماركة،
 * موديل، وحدات البيع من variant الأوّل. الغرض: تغذية الاستدعاء التلقائيّ لـgenerate بعد اعتماد
 * صورةٍ في الاستوديو — لا ينتظر من الموظّف كتابة أيّ شيء إضافيّ.
 */
async function buildProductFactsFromDb(
  productId: number,
): Promise<ProductFacts | null> {
  const db = requireDb();
  const [row] = await db
    .select({
      name: products.name,
      description: products.description,
      productType: products.productType,
      brand: products.brand,
      modelName: products.modelName,
      categoryName: categories.name,
    })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(eq(products.id, productId))
    .limit(1);
  if (!row) return null;

  const [variant] = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(eq(productVariants.productId, productId))
    .orderBy(asc(productVariants.id))
    .limit(1);
  const units = variant
    ? await db
        .select({
          unitName: productUnits.unitName,
          conversionFactor: productUnits.conversionFactor,
        })
        .from(productUnits)
        .where(eq(productUnits.variantId, variant.id))
        .orderBy(asc(productUnits.isBaseUnit))
    : [];

  return productFactsSchema.parse({
    finalProductName: row.name?.trim() || null,
    inputDescription: row.description?.trim() || null,
    category: row.categoryName?.trim() || null,
    productType: row.productType?.trim() || null,
    brand: row.brand?.trim() || null,
    modelName: row.modelName?.trim() || null,
    attributes: {},
    variants: [],
    saleUnits: units.map((u) => ({
      name: u.unitName,
      conversionFactor: String(u.conversionFactor ?? "1"),
    })),
    verifiedClaims: [],
    audience: null,
  });
}

/**
 * الهجين — يُستدعى **بعد** اعتماد صورةٍ في استوديو المنتجات (بعد commit المعاملة، fire-and-forget).
 * يبني الحقائق ⇒ يولّد بالمسار البصريّ (م٢) ⇒ يحفظ مسودّةً DRAFT عبر حوكمة المحتوى القائمة.
 * لا يرمي أبداً: كلّ فشلٍ عن سببه في النتيجة، فيُسجّلها المستدعي بلا إفشال اعتماد الاستوديو.
 * حالاتٌ حميدة معلَنة (لا صور مطابقة، تجاوز الميزانية، سقوط التحقّق) — يمكن للمشغّل قراءتها.
 */
export async function generateAndSaveContentDraftForProduct(
  productId: number,
  actor: { userId: number; branchId?: number | null },
): Promise<AutoContentDraftOutcome> {
  const facts = await buildProductFactsFromDb(productId).catch(() => null);
  if (!facts) return { draftId: null, reason: "product-not-found" };

  let result: ProductContentDraftResult;
  try {
    result = await generateProductContentDraft(facts, {
      productId,
      actor,
    });
  } catch (err: any) {
    const msg = String(err?.message ?? "");
    // الحوكمة القائمة تُرجع PRECONDITION_FAILED مع نصّ «سقف» عند نضوب الميزانية اليوميّة.
    if (err?.code === "PRECONDITION_FAILED" && msg.includes("سقف")) {
      return { draftId: null, reason: "budget-exhausted", detail: msg };
    }
    return { draftId: null, reason: "generate-failed", detail: msg };
  }

  // لا صور معتمَدة مرتبطة بالمنتج ⇒ النتيجة نصّية بحتة، ولا فائدة من مسودّةٍ تلقائيّة (المستخدم
  // يستطيع طلب التوليد النصّي يدوياً وقت الحاجة). هذا يمنع ملء الطابور بمسودّاتٍ ضعيفة عند
  // اعتماد صورةٍ لمنتجٍ آخر (سباق) أو حين تُلغى الصورة بين الاستدعاء والقراءة.
  if (result.imagesUsed === 0) return { draftId: null, reason: "no-images" };

  if (!result.validation.ok) return { draftId: null, reason: "validation-failed" };

  try {
    const saved = await saveProductContentDraft(
      {
        productId,
        sourceFacts: facts as unknown as Record<string, unknown>,
        sourceFactsHash: result.cacheKey,
        content: {
          internalName: null,
          storeTitle: result.draft.seoTitle,
          seoTitle: result.draft.seoTitle,
          shortTitle: result.draft.shortTitle,
          posLabel: result.draft.posLabel,
          invoiceLabel: result.draft.invoiceLabel,
          marketingCopy: result.draft.marketingCopy,
          description: result.draft.description,
        },
        validation: result.validation,
        promptVersion: result.promptVersion,
        model: result.model,
      },
      actor,
    );
    return { draftId: saved.draftId, reason: "created" };
  } catch (err: any) {
    return {
      draftId: null,
      reason: "save-failed",
      detail: String(err?.message ?? ""),
    };
  }
}
