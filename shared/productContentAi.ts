import { z } from "zod";

// ────────────────────────────────────────────────────────────────────────────────
// تصنيف أخطاء مزوّد الذكاء (Gemini) — عقدٌ مشترك بين الخادم والعميل
//
// المشكلة قبل هذا التصنيف: `TRPCError({code:"BAD_REQUEST", message:"Model not found..."})`
// كانت رسالته الإنجليزيّة تُبتلَع في `toArabicMessage` (لا حرف عربيّ ⇒ يرجع النصّ العامّ
// «طلب غير صالح»)، والعميل بدوره يحذفها لسببٍ أمنيّ (منع تسريب المفاتيح/PII). النتيجة:
// المستخدم يرى رسالةً عامّة ولا ندري ما رفضه المزوّد.
//
// الحلّ: تصنيفٌ صريحٌ مغلقٌ (٨ فئات فقط) ⇒ كلّ فئة لها رسالة عربيّة موحّدة، وإجراءٌ مُقترَح،
// وعلَم retryable. الخادم يُصنّف وينقل الفئة في `data.providerCategory`؛ العميل يعرضها
// بأمان (لا يمرّر نصّ الخادم الخام أبداً).
// ────────────────────────────────────────────────────────────────────────────────

export type AiProviderErrorCategory =
  | "MODEL_NOT_FOUND"
  | "SAFETY_BLOCK"
  | "QUOTA_EXCEEDED"
  | "INVALID_INPUT"
  | "AUTH"
  | "SERVER_TRANSIENT"
  | "TIMEOUT"
  | "UNKNOWN";

export const AI_PROVIDER_ERROR_CATEGORIES: readonly AiProviderErrorCategory[] = [
  "MODEL_NOT_FOUND",
  "SAFETY_BLOCK",
  "QUOTA_EXCEEDED",
  "INVALID_INPUT",
  "AUTH",
  "SERVER_TRANSIENT",
  "TIMEOUT",
  "UNKNOWN",
] as const;

type CategoryPresentation = {
  title: string;
  message: string;
  action?: string;
  retryable: boolean;
};

/** خريطةُ عرضٍ موحّدة لكلّ فئة — تستعملها الواجهة عبر `describeAiError`.
 *  ⛔ لا يوجد نصّ خام من المزوّد في هذه الرسائل — كل حرفٍ عربيّ من عندنا. */
export const AI_PROVIDER_ERROR_PRESENTATION: Record<AiProviderErrorCategory, CategoryPresentation> = {
  MODEL_NOT_FOUND: {
    title: "النموذج المضبوط غير متوفّر",
    message:
      "لا يصل مفتاح Gemini الحاليّ إلى النموذج الأساسيّ ولا إلى الاحتياطيّ. المطلوب من المدير: (١) تحديث اسم النموذج في إعدادات الاستوديو إلى اسمٍ متاح (مثل gemini-flash-latest)، أو (٢) التحقّق من صلاحيات المفتاح في Google AI Studio.",
    action: "اضبط النموذج من: إعدادات الاستوديو ← الذكاء الاصطناعي ← النموذج.",
    retryable: false,
  },
  SAFETY_BLOCK: {
    title: "حجب أمانٍ من مزوّد الذكاء",
    message:
      "رفض المزوّد المعالجة لأنّه اعتبر الصورة أو الطلب مخالفاً لسياساته. جرّب صورةً أوضح للمنتج أو تحقّق من الوصف المُدخَل.",
    retryable: false,
  },
  QUOTA_EXCEEDED: {
    title: "استُنفدت حصّة الاستخدام لدى المزوّد",
    message:
      "لدى مفتاح Gemini حدٌّ زمنيٌّ أو يوميّ بلغتَه. انتظر قليلاً ثمّ أعد المحاولة، أو ارفع الحصّة من لوحة Google AI Studio.",
    retryable: true,
  },
  INVALID_INPUT: {
    title: "رفض المزوّد الحمولة",
    message:
      "الصورة أو البيانات المُرسَلة لم يقبلها المزوّد. تأكّد أنّ الصورة سليمة (JPEG/PNG/WEBP) وأنّ الوصف قصير ومباشر.",
    retryable: false,
  },
  AUTH: {
    title: "مفتاح الذكاء الاصطناعي غير صالح",
    message:
      "رفض المزوّد المفتاح (منتهٍ أو مُبطَل أو بلا صلاحية). اطلب من المدير تحديث المفتاح من إعدادات الاستوديو.",
    retryable: false,
  },
  SERVER_TRANSIENT: {
    title: "خللٌ مؤقّت لدى مزوّد الذكاء",
    message: "أعِد المحاولة بعد لحظات — العطل من طرف المزوّد، لم يتغيّر منتجك.",
    retryable: true,
  },
  TIMEOUT: {
    title: "تأخّر مزوّد الذكاء",
    message: "لم يصل الردّ في الوقت المحدَّد. أعِد المحاولة، وسيبقى المنتج دون تغيير.",
    retryable: true,
  },
  UNKNOWN: {
    title: "خطأٌ غير مصنَّفٍ من المزوّد",
    message:
      "حدث خطأٌ لم يستطع النظام تصنيفه. أعد المحاولة، وإن استمرّ فأرسل رمز المتابعة للدعم.",
    retryable: true,
  },
};

/** يصنّف حالة HTTP + رسالة Gemini إلى فئةٍ داخليّة — نقطة استعمال واحدة على الخادم. */
export function classifyGeminiError(
  status: number,
  detail: string | null | undefined,
): AiProviderErrorCategory {
  const text = String(detail ?? "").toLowerCase();
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "QUOTA_EXCEEDED";
  if (status >= 500) return "SERVER_TRANSIENT";
  if (status === 404 || /not found for the requested|model.*not.*found|does not exist/.test(text)) {
    return "MODEL_NOT_FOUND";
  }
  if (/safety|blocked|harm/.test(text)) return "SAFETY_BLOCK";
  if (status === 400) return "INVALID_INPUT";
  return "UNKNOWN";
}


const factValue = z.string().trim().min(1).max(160);
const inputDescription = z.string().trim().max(5_000);

export const productFactsSchema = z
  .object({
    finalProductName: factValue.nullable().default(null),
    inputDescription: inputDescription.nullable().default(null),
    category: factValue.nullable().default(null),
    productType: factValue.nullable().default(null),
    brand: factValue.nullable().default(null),
    modelName: factValue.nullable().default(null),
    attributes: z
      .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/), factValue)
      .default({}),
    variants: z
      .array(
        z
          .object({
            color: factValue.nullable().optional(),
            size: factValue.nullable().optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    saleUnits: z
      .array(
        z
          .object({
            name: factValue,
            conversionFactor: z.string().regex(/^\d+(\.\d+)?$/),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    verifiedClaims: z.array(factValue).max(30).default([]),
    audience: factValue.nullable().default(null),
  })
  .strict();

export type ProductFacts = z.infer<typeof productFactsSchema>;

export const productChannelContentSchema = z.object({
  internalName: z.string().trim().max(255).nullable().optional(),
  storeTitle: z.string().trim().max(255).nullable().optional(),
  seoTitle: z.string().trim().max(255).nullable().optional(),
  shortTitle: z.string().trim().max(160).nullable().optional(),
  posLabel: z.string().trim().max(120).nullable().optional(),
  invoiceLabel: z.string().trim().max(255).nullable().optional(),
  marketingCopy: z.string().trim().max(10_000).nullable().optional(),
  description: z.string().trim().max(20_000).nullable().optional(),
}).strict();

export type ProductChannelContentInput = z.infer<typeof productChannelContentSchema>;

const evidenceKey = z
  .string()
  .regex(
    /^(category|productType|brand|modelName|attributes\.[a-zA-Z0-9_.-]+|variants\.[0-9]+\.(color|size)|saleUnits\.[0-9]+\.(name|conversionFactor)|verifiedClaims\.[0-9]+|audience|image\.[0-9]+)$/,
  )
  .max(120);

const claimSchema = z
  .object({
    text: z.string().trim().min(1).max(300),
    evidenceKeys: z.array(evidenceKey).min(1).max(10),
  })
  .strict();

export const aiProductDraftSchema = z
  .object({
    seoTitle: z.string().trim().min(1).max(160),
    shortTitle: z.string().trim().min(1).max(100),
    posLabel: z.string().trim().min(1).max(140),
    invoiceLabel: z.string().trim().min(1).max(160),
    marketingCopy: z.string().trim().max(300),
    description: z.string().trim().max(2_000),
    keywords: z.array(z.string().trim().min(1).max(80)).max(20),
    claims: z.array(claimSchema).max(10),
    unsupportedClaims: z
      .array(
        z
          .object({
            text: z.string().trim().min(1).max(300),
            reason: z.string().trim().min(1).max(300),
          })
          .strict(),
      )
      .max(10),
    warnings: z.array(z.string().trim().min(1).max(300)).max(20),
    confidence: z.enum(["low", "medium", "high"]),
  })
  .strict();

export type AiProductDraft = z.infer<typeof aiProductDraftSchema>;

// م٣ — عقد الاستخراج «من صورة»: مساعد إنشاء منتجٍ جديد. الموظّف يرفع صورة، والنظام
// يقترح الحقول الأساسية (اسم، نوع، ماركة، وصف قصير). لا يُنشئ منتجاً — يُطبَّق على النموذج
// فقط بعد مراجعة الموظّف. النتيجة قصيرة، بلا claims/evidenceKeys، لأنّها مدخل تعبئةٍ لا مخرج
// نشر — التحقّق التسويقي/المرجعيّ يجري لاحقاً عبر generateProductContentDraft.
export const extractedProductFactsSchema = z
  .object({
    suggestedName: z.string().trim().min(1).max(160).nullable(),
    productType: z.string().trim().min(1).max(80).nullable(),
    brand: z.string().trim().min(1).max(80).nullable(),
    modelHint: z.string().trim().min(1).max(80).nullable(),
    description: z.string().trim().max(500),
    keywords: z.array(z.string().trim().min(1).max(60)).max(10),
    confidence: z.enum(["low", "medium", "high"]),
    // ما اقترحه النموذج ثمّ حجبه — يُعرَض للموظّف كمعرفةٍ نافعة (مثلاً «رأيت رقماً غير واضح»)
    // ليعوّضه يدوياً إن أراد. لا يُطبَّق على النموذج تلقائياً.
    unsupportedGuesses: z
      .array(
        z
          .object({
            text: z.string().trim().min(1).max(200),
            reason: z.string().trim().min(1).max(200),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();

export type ExtractedProductFacts = z.infer<typeof extractedProductFactsSchema>;

export type DraftValidation = {
  blockers: string[];
  warnings: string[];
  ok: boolean;
};

export type ProductContentValidationSnapshot = DraftValidation;

const UNSUPPORTED_MARKETING_TERMS = [
  "الأفضل",
  "أفضل",
  "رقم 1",
  "الأرخص",
  "مضمون",
  "أصلي",
  "فاخر",
  "مقاوم للماء",
  "الأكثر مبيعاً",
  "صديق للبيئة",
];

function flattenFacts(facts: ProductFacts): Map<string, string> {
  const out = new Map<string, string>();
  if (facts.category) out.set("category", facts.category);
  if (facts.productType) out.set("productType", facts.productType);
  if (facts.brand) out.set("brand", facts.brand);
  if (facts.modelName) out.set("modelName", facts.modelName);
  if (facts.audience) out.set("audience", facts.audience);
  Object.entries(facts.attributes).forEach(([key, value]) =>
    out.set(`attributes.${key}`, value),
  );
  facts.variants.forEach((variant, index) => {
    if (variant.color) out.set(`variants.${index}.color`, variant.color);
    if (variant.size) out.set(`variants.${index}.size`, variant.size);
  });
  facts.saleUnits.forEach((unit, index) => {
    out.set(`saleUnits.${index}.name`, unit.name);
    out.set(`saleUnits.${index}.conversionFactor`, unit.conversionFactor);
  });
  facts.verifiedClaims.forEach((claim, index) =>
    out.set(`verifiedClaims.${index}`, claim),
  );
  return out;
}

function normalizeDigits(value: string): string {
  const arabic = "٠١٢٣٤٥٦٧٨٩";
  const persian = "۰۱۲۳۴۵۶۷۸۹";
  return Array.from(value)
    .map((ch) => {
      const ai = arabic.indexOf(ch);
      if (ai >= 0) return String(ai);
      const pi = persian.indexOf(ch);
      return pi >= 0 ? String(pi) : ch;
    })
    .join("");
}

function extractNumericTokens(value: string): string[] {
  return normalizeDigits(value).match(/\d+(?:[×xX*./-]\d+)?/g) ?? [];
}

function normalizeClaimText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .toLocaleLowerCase("ar")
    .replace(/[^\w\u0600-\u06FF]+/g, " ")
    .trim();
}

const SAFE_CLAIM_TOKENS = new Set([
  "و",
  "في",
  "من",
  "على",
  "مع",
  "الى",
  "إلى",
  "عن",
  "هذا",
  "هذه",
  "ذلك",
  "تلك",
  "يحتوي",
  "تحتوي",
  "مناسب",
  "مناسبة",
  "للاستخدام",
  "للاستخدامات",
  "الاستخدام",
  "لـ",
  "ذو",
  "ذات",
  "بحجم",
  "بلون",
  "ب",
]);

function claimTokens(value: string): string[] {
  return normalizeClaimText(value)
    .split(/\s+/)
    .map((token) => token.replace(/^ال(?=.{3,})/, ""))
    .filter((token) => token.length >= 3 && !SAFE_CLAIM_TOKENS.has(token));
}

function claimIsGrounded(claimText: string, evidenceValues: string[]): boolean {
  const claim = normalizeClaimText(claimText);
  const claimTokenSet = new Set(claimTokens(claimText));
  const claimNumbers = extractNumericTokens(claim);
  const evidenceTokenSets = evidenceValues.map((value) => new Set(claimTokens(value)));
  const evidenceNumbers = evidenceValues.flatMap(extractNumericTokens);

  if (claimNumbers.some((token) => !evidenceNumbers.includes(token))) return false;
  if (claimTokenSet.size === 0) return claimNumbers.length > 0 && evidenceNumbers.length > 0;

  return evidenceTokenSets.some((tokens) =>
    Array.from(claimTokenSet).every((token) => tokens.has(token)),
  );
}

export function validateAiProductDraft(
  draft: AiProductDraft,
  facts: ProductFacts,
): DraftValidation {
  const factMap = flattenFacts(facts);
  const blockers: string[] = [];
  const warnings = [...draft.warnings];

  draft.claims.forEach((claim, index) => {
    const textEvidenceValues: string[] = [];
    claim.evidenceKeys.forEach((key) => {
      // مفاتيح image.N: البروتوكول البصريّ في البرومبت يعنونها (image.0 = الصورة الأولى…) ومراجعة
      // المدير تحكمها. لا factMap لها ولا تطابق نصّيٍّ ممكن — لكنّها **دليلٌ مقبول** ما دام الادّعاء
      // بصريّاً بحتاً. إن اختلط بصريّ ونصّيّ، يبقى فحص التطابق نافذاً على النصّيّ فقط.
      if (/^image\.\d+$/.test(key)) return;
      const evidence = factMap.get(key);
      if (!evidence) {
        blockers.push(
          `الادعاء رقم ${index + 1} يستخدم دليلاً غير موجود: ${key}`,
        );
        return;
      }
      textEvidenceValues.push(evidence);
    });
    if (
      textEvidenceValues.length > 0 &&
      !claimIsGrounded(claim.text, textEvidenceValues)
    ) {
      blockers.push(
        `الادعاء رقم ${index + 1} لا يتطابق نصياً مع القيم التي استند إليها`,
      );
    }
  });

  const allText = [
    draft.seoTitle,
    draft.shortTitle,
    draft.posLabel,
    draft.invoiceLabel,
    draft.marketingCopy,
    draft.description,
    ...draft.keywords,
  ].join(" ");
  const knownNumbers = new Set(
    Array.from(factMap.values()).flatMap(extractNumericTokens),
  );
  for (const token of extractNumericTokens(allText)) {
    if (!knownNumbers.has(token))
      blockers.push(`رقم أو قياس غير موجود في حقائق المنتج: ${token}`);
  }

  const normalizedText = allText.toLocaleLowerCase("ar");
  const approvedClaims = facts.verifiedClaims.join(" ").toLocaleLowerCase("ar");
  for (const term of UNSUPPORTED_MARKETING_TERMS) {
    const normalizedTerm = term.toLocaleLowerCase("ar");
    if (
      normalizedText.includes(normalizedTerm) &&
      !approvedClaims.includes(normalizedTerm)
    ) {
      blockers.push(`ادعاء تسويقي غير معتمد: ${term}`);
    }
  }

  const generalTitles = `${draft.seoTitle} ${draft.shortTitle}`;
  for (const variant of facts.variants) {
    for (const value of [variant.color, variant.size]) {
      if (value && generalTitles.includes(value))
        warnings.push(`قيمة متغير ظهرت في عنوان عام: ${value}`);
    }
  }

  if (draft.description && draft.claims.length === 0)
    blockers.push("الوصف موجود بلا ادعاءات مرتبطة بأدلة");
  if (draft.marketingCopy && draft.claims.length === 0)
    blockers.push("النص الترويجي موجود بلا ادعاءات مرتبطة بأدلة");

  return {
    blockers: Array.from(new Set(blockers)),
    warnings: Array.from(new Set(warnings)),
    ok: blockers.length === 0,
  };
}

/**
 * يُطبِّع مُدخَل «معامل التحويل» ليطابق regex السكيمة على الخادم:
 * أرقام عربية/فارسية ⇒ لاتينية · فاصلة عشرية ⇒ نقطة · إسقاط نقطةٍ زائدة/أصفارٍ بادئة.
 * السبب: النموذج يقبل «١٢» أو «1,5» من الموظّف، والخادم يرفضهما ⇒ BAD_REQUEST غامض.
 */
export function normalizeConversionFactor(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "1";
  const latin = normalizeDigits(raw).replace(/[،٫]/g, ".").replace(/,/g, ".");
  const match = latin.match(/^0*(\d+)(?:\.(\d*?)0*)?\.?$/);
  if (!match) return raw; // نُبقيه كما هو ⇒ يُحمَّر الحقل خادمياً برسالةٍ واضحة
  const intPart = match[1] || "0";
  const frac = match[2] ?? "";
  return frac.length > 0 ? `${intPart}.${frac}` : intPart;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
