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
  aiProductDraftSchema,
  canonicalJson,
  extractedProductFactsSchema,
  productFactsSchema,
  validateAiProductDraft,
  type AiProductDraft,
  type ExtractedProductFacts,
  type ProductFacts,
} from "../../shared/productContentAi";

const GEMINI_API_BASE = (
  process.env.GEMINI_API_BASE ??
  "https://generativelanguage.googleapis.com/v1beta"
).replace(/\/+$/, "");
const DEFAULT_TEXT_MODEL = "gemini-2.5-flash";
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

const OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
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
        additionalProperties: false,
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
        additionalProperties: false,
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

  const model = runtime.model.includes("image")
    ? DEFAULT_TEXT_MODEL
    : runtime.model;

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
  const cacheKey = productContentCacheKey(facts, model, visualContext);

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
    const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
    const fetchImpl = opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? TIMEOUT_MS,
    );

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

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "x-goog-api-key": runtime.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error: any) {
      clearTimeout(timeout);
      if (error?.name === "AbortError")
        throw new TRPCError({
          code: "TIMEOUT",
          message: "تأخر مزود الذكاء الاصطناعي؛ أعد المحاولة لاحقاً.",
        });
      throw new TRPCError({
        code: "TIMEOUT",
        message: "تعذر الوصول إلى مزود الذكاء الاصطناعي.",
      });
    }

    try {
      if (!response.ok) {
        let detail = "";
        try {
          const body = JSON.parse(await readBoundedText(response, 32 * 1024));
          detail = String(body?.error?.message ?? "").slice(0, 250);
        } catch {
          detail = "";
        }
        if (response.status === 401 || response.status === 403) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "مفتاح مزود الذكاء الاصطناعي غير صالح أو بلا صلاحية.",
          });
        }
        const code =
          response.status === 429
            ? "TOO_MANY_REQUESTS"
            : response.status >= 500
              ? "INTERNAL_SERVER_ERROR"
              : "BAD_REQUEST";
        throw new TRPCError({
          code,
          message:
            code === "INTERNAL_SERVER_ERROR"
              ? "تعذر الوصول إلى مزود الذكاء الاصطناعي مؤقتاً."
              : detail || "فشل توليد مسودة محتوى المنتج.",
        });
      }

      let body: any;
      try {
        body = JSON.parse(await readBoundedText(response, MAX_RESPONSE_BYTES));
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "ردّ مزود الذكاء الاصطناعي غير صالح.",
        });
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
        model,
        promptVersion: promptVersionUsed,
        cacheHit: false,
        imagesUsed: images.length,
      };
    } finally {
      clearTimeout(timeout);
    }
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

const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
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
    suggestedName: { type: ["string", "null"] },
    productType: { type: ["string", "null"] },
    brand: { type: ["string", "null"] },
    modelHint: { type: ["string", "null"] },
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
        additionalProperties: false,
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

  const model = runtime.model.includes("image")
    ? DEFAULT_TEXT_MODEL
    : runtime.model;

  const extract = async (): Promise<ExtractProductFactsResult> => {
    const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
    const fetchImpl = opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? TIMEOUT_MS,
    );

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

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "x-goog-api-key": runtime.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error: any) {
      clearTimeout(timeout);
      if (error?.name === "AbortError")
        throw new TRPCError({
          code: "TIMEOUT",
          message: "تأخر مزود الذكاء الاصطناعي؛ أعد المحاولة لاحقاً.",
        });
      throw new TRPCError({
        code: "TIMEOUT",
        message: "تعذر الوصول إلى مزود الذكاء الاصطناعي.",
      });
    }

    try {
      if (!response.ok) {
        let detail = "";
        try {
          const body = JSON.parse(await readBoundedText(response, 32 * 1024));
          detail = String(body?.error?.message ?? "").slice(0, 250);
        } catch {
          detail = "";
        }
        if (response.status === 401 || response.status === 403) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "مفتاح مزود الذكاء الاصطناعي غير صالح أو بلا صلاحية.",
          });
        }
        const code =
          response.status === 429
            ? "TOO_MANY_REQUESTS"
            : response.status >= 500
              ? "INTERNAL_SERVER_ERROR"
              : "BAD_REQUEST";
        throw new TRPCError({
          code,
          message:
            code === "INTERNAL_SERVER_ERROR"
              ? "تعذر الوصول إلى مزود الذكاء الاصطناعي مؤقتاً."
              : detail || "فشل استخراج حقائق المنتج من الصورة.",
        });
      }

      let body: any;
      try {
        body = JSON.parse(await readBoundedText(response, MAX_RESPONSE_BYTES));
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "ردّ مزود الذكاء الاصطناعي غير صالح.",
        });
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

      return { facts, model, promptVersion: EXTRACTION_PROMPT_VERSION };
    } finally {
      clearTimeout(timeout);
    }
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
