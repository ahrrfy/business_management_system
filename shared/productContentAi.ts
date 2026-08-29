import { z } from "zod";

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
    /^(category|productType|brand|modelName|attributes\.[a-zA-Z0-9_.-]+|variants\.[0-9]+\.(color|size)|saleUnits\.[0-9]+\.(name|conversionFactor)|verifiedClaims\.[0-9]+|audience)$/,
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
    const evidenceValues: string[] = [];
    claim.evidenceKeys.forEach((key) => {
      const evidence = factMap.get(key);
      if (!evidence)
        blockers.push(
          `الادعاء رقم ${index + 1} يستخدم دليلاً غير موجود: ${key}`,
        );
      else evidenceValues.push(evidence);
    });
    if (
      evidenceValues.length > 0 &&
      !claimIsGrounded(claim.text, evidenceValues)
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
