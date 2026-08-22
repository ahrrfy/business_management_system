import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import { getAiStudioRuntime } from "./imageStudioSettingsService";
import {
  aiProductDraftSchema,
  canonicalJson,
  productFactsSchema,
  validateAiProductDraft,
  type AiProductDraft,
  type ProductFacts,
} from "../../shared/productContentAi";

const GEMINI_API_BASE = (process.env.GEMINI_API_BASE ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
const DEFAULT_TEXT_MODEL = "gemini-2.5-flash";
const PROMPT_VERSION = "product-content-ar-v1";
const MAX_RESPONSE_BYTES = 512 * 1024;
const TIMEOUT_MS = 25_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

type TextFetch = typeof fetch;

type CachedDraft = { result: ProductContentDraftResult; expiresAt: number };
const draftCache = new Map<string, CachedDraft>();
const inFlightDrafts = new Map<string, Promise<ProductContentDraftResult>>();

const SYSTEM_PROMPT = `أنت محرر محتوى كتالوج عربي يعمل داخل نظام مبيعات ومخزون.
مصدر الحقيقة الوحيد هو VERIFIED_PRODUCT_FACTS الموجود في الطلب.
لا تستخدم معرفة خارجية ولا تكمل المعلومات الناقصة بالتخمين.
كل claim يجب أن يحتوي evidenceKeys تشير إلى مفاتيح موجودة في الحقائق.
لا تخترع مادة أو ميزة أو ضماناً أو بلداً للصناعة أو شهادة أو جودة أو توافقاً.
لا تستخدم عبارات مثل الأفضل، رقم 1، الأرخص، مضمون، أصلي، فاخر، مقاوم للماء، الأكثر مبيعاً أو صديق للبيئة إلا إذا كانت موجودة في verifiedClaims.
لا تضع السعر أو الخصم أو المخزون داخل الاسم أو الوصف.
إذا كان اللون أو المقاس متغيراً مستقلاً فلا تضعه في seoTitle أو shortTitle، ويمكن وضعه فقط في posLabel أو invoiceLabel عند الحاجة.
إذا كانت البيانات غير كافية، أعد نصاً محافظاً وأضف السبب إلى warnings أو unsupportedClaims.
استخدم عربية واضحة مناسبة للعراق بلا تشكيل ولا كشيدة.
أعد JSON فقط مطابقاً للمخطط المطلوب.`;

const OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["seoTitle", "shortTitle", "posLabel", "invoiceLabel", "marketingCopy", "description", "keywords", "claims", "unsupportedClaims", "warnings", "confidence"],
  properties: {
    seoTitle: { type: "string", maxLength: 160 },
    shortTitle: { type: "string", maxLength: 100 },
    posLabel: { type: "string", maxLength: 140 },
    invoiceLabel: { type: "string", maxLength: 160 },
    marketingCopy: { type: "string", maxLength: 300 },
    description: { type: "string", maxLength: 2_000 },
    keywords: { type: "array", maxItems: 20, items: { type: "string", maxLength: 80 } },
    claims: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "evidenceKeys"],
        properties: {
          text: { type: "string", maxLength: 300 },
          evidenceKeys: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", maxLength: 120 } },
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
        properties: { text: { type: "string", maxLength: 300 }, reason: { type: "string", maxLength: 300 } },
      },
    },
    warnings: { type: "array", maxItems: 20, items: { type: "string", maxLength: 300 } },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
} as const;

function textFromGeminiResponse(body: any): string {
  const parts = body?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => typeof part?.text === "string" ? part.text : "").join("\n").trim();
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("AI response too large");
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
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
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
};

export function productContentCacheKey(facts: ProductFacts, model: string): string {
  return createHash("sha256")
    .update(canonicalJson({ facts, model, promptVersion: PROMPT_VERSION }), "utf8")
    .digest("hex");
}

export async function generateProductContentDraft(
  rawFacts: unknown,
  opts: { fetchImpl?: TextFetch; timeoutMs?: number; forceRefresh?: boolean } = {},
): Promise<ProductContentDraftResult> {
  const facts = productFactsSchema.parse(rawFacts);
  const runtime = await getAiStudioRuntime();
  if (!runtime) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "مسار الذكاء الاصطناعي غير مفعّل أو لا يوجد مفتاح صالح في إعدادات الاستوديو.",
    });
  }
  if (runtime.provider !== "GEMINI") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "مزود محتوى المنتج غير مدعوم حالياً." });
  }

  const model = runtime.model.includes("image") ? DEFAULT_TEXT_MODEL : runtime.model;
  const cacheKey = productContentCacheKey(facts, model);
  if (!opts.forceRefresh) {
    const cached = draftCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return { ...cached.result, cacheHit: true };
    if (cached) draftCache.delete(cacheKey);
    const pending = inFlightDrafts.get(cacheKey);
    if (pending) return { ...(await pending), cacheHit: true };
  }

  const generate = async (): Promise<ProductContentDraftResult> => {
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? TIMEOUT_MS);

  const payload = {
    contents: [{ role: "user", parts: [{ text: `${SYSTEM_PROMPT}\n\nVERIFIED_PRODUCT_FACTS:\n${JSON.stringify(facts)}\n\nأعد مسودة المنتج الآن.` }] }],
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
      headers: { "x-goog-api-key": runtime.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error: any) {
    if (error?.name === "AbortError") throw new TRPCError({ code: "TIMEOUT", message: "تأخر مزود الذكاء الاصطناعي؛ أعد المحاولة لاحقاً." });
    throw new TRPCError({ code: "TIMEOUT", message: "تعذر الوصول إلى مزود الذكاء الاصطناعي." });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = JSON.parse(await readBoundedText(response, 32 * 1024));
      detail = String(body?.error?.message ?? "").slice(0, 250);
    } catch {
      detail = "";
    }
    const code = response.status === 429 ? "TOO_MANY_REQUESTS" : response.status === 401 || response.status === 403 ? "UNAUTHORIZED" : "BAD_REQUEST";
    throw new TRPCError({ code, message: detail || "فشل توليد مسودة محتوى المنتج." });
  }

  let body: any;
  try {
    body = JSON.parse(await readBoundedText(response, MAX_RESPONSE_BYTES));
  } catch {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "ردّ مزود الذكاء الاصطناعي غير صالح." });
  }

  let draft: AiProductDraft;
  try {
    draft = aiProductDraftSchema.parse(JSON.parse(stripCodeFence(textFromGeminiResponse(body))));
  } catch {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "مسودة الذكاء الاصطناعي لا تطابق مخطط المحتوى المطلوب." });
  }

  const validation = validateAiProductDraft(draft, facts);
  return { draft, validation, cacheKey, model, promptVersion: PROMPT_VERSION, cacheHit: false };
  };

  const pending = generate();
  inFlightDrafts.set(cacheKey, pending);
  try {
    const result = await pending;
    draftCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  } finally {
    inFlightDrafts.delete(cacheKey);
  }
}
