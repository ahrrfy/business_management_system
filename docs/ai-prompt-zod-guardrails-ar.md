# هيكلية Prompt والتحقق من مخرجات AI قبل اعتماد محتوى المنتج

## المبدأ الأمني الأساسي

يجب التمييز بين أمرين مختلفين:

> **Zod يثبت أن المخرجات منظمة وتطابق الأنواع والأطوال، لكنه لا يثبت أن الجملة صحيحة واقعياً.**

لذلك نحتاج إلى أربع طبقات متتالية:

| الطبقة | الوظيفة | الأداة |
|---|---|---|
| 1. تقييد المدخلات | إرسال حقائق المنتج المعتمدة فقط | Zod + كائن حقائق منظم |
| 2. تقييد الإخراج | منع النص الحر وفرض JSON معروف | `response_format` + JSON Schema |
| 3. التحقق البرمجي | فحص الأنواع والأطوال والبنية | Zod |
| 4. التحقق الدلالي | مطابقة الأرقام والسمات والكلمات والادعاءات مع الحقائق | TypeScript قواعد حتمية |
| 5. الاعتماد | منع الحفظ التلقائي وإتاحة مراجعة المستخدم | حالة `DRAFT` ثم `APPROVED` |

إذا كان المطلوب أعلى مستوى ممكن من عدم الاختلاق، فلا تجعل النموذج يكتب مواصفات حرة بالكامل. اجعله يختار **مفاتيح حقائق معتمدة** ويقترح ترتيبها، ثم يستطيع الخادم تركيب النسخة النهائية من الحقائق. فالنموذج اللغوي قد يلتزم بالتعليمات بدرجة عالية، لكنه ليس قاعدة بيانات ولا محرك إثبات.

## 1. هيكلية Prompt المقترحة

الأفضل تقسيم الطلب إلى أربع رسائل منطقية، حتى لو أرسلت في مصفوفة `messages` واحدة:

### أ. رسالة النظام: الدور والحدود

```text
أنت محرر محتوى كتالوج عربي يعمل داخل نظام مبيعات ومخزون.

مصدر الحقيقة الوحيد هو كائن VERIFIED_PRODUCT_FACTS المرسل في رسالة المستخدم.
لا تستخدم أي معرفة خارجية عن المنتج، ولا تكمل المعلومات الناقصة من التخمين.

قواعد عدم الاختلاق:
1. لا تضف مادة أو ميزة أو ضماناً أو بلداً للصناعة أو شهادة أو توافقاً أو جودة غير موجودة حرفياً أو دلالياً في الحقائق المعتمدة.
2. لا تحول النوع أو الفئة إلى ادعاء جودة. كلمة «دفتر» لا تسمح بكتابة «دفتر ممتاز».
3. لا تحول وجود اللون أو المقاس إلى ادعاء تسويقي؛ اعرضه كصفة فقط.
4. لا تستخدم: الأفضل، رقم 1، مضمون، أصلي، فاخر، مقاوم للماء، صديق للبيئة، الأكثر مبيعاً، الأرخص، أو أي ادعاء مشابه، إلا إذا كان موجوداً داخل verifiedClaims.
5. كل جملة في description أو marketingCopy يجب أن تذكر evidenceKeys تشير إلى حقائق استخدمتها.
6. إذا لم توجد حقيقة تسمح بإنتاج جملة، لا تنتج الجملة. أضف المشكلة إلى warnings أو unsupportedClaims.
7. لا تضع سعراً أو خصماً أو كمية مخزون أو رقم هاتف أو تاريخاً متغيراً في الاسم أو الوصف الدائم.
8. إذا كانت الألوان أو المقاسات متغيرات مستقلة، لا تضعها في الاسم المركزي. يمكن وضع القيمة المختارة فقط في posLabel أو invoiceLabel.
9. وحّد الأرقام إلى الشكل اللاتيني، وأزل التشكيل والكشيدة والمسافات الزائدة.
10. أعد JSON مطابقاً للمخطط فقط، بلا Markdown ولا شرح خارجي.
```

### ب. رسالة سياسة الفئة

هذه الرسالة تأتي من الخادم، وليست من الموظف حتى لا يستطيع المستخدم تغيير قواعدها:

```text
CATEGORY_POLICY:
- category: قرطاسية
- requiredFactsForStore: [productType]
- preferredTitleOrder: [productType, brand, modelName, size, capacity]
- variantFacts: [color, size]
- forbiddenInCanonicalName: [price, discount, stock, promotion, color_when_variant]
- maxLengths:
  seoTitle: 70
  shortTitle: 60
  posLabel: 70
  invoiceLabel: 90
  marketingCopy: 180
  description: 1500
```

### ج. رسالة الحقائق الموثوقة

لا ترسل `products` كاملة ولا تسمح للنموذج باختيار حقول غير معروفة. استخدم مفاتيح محددة وقيم مطبّعة:

```json
{
  "VERIFIED_PRODUCT_FACTS": {
    "category": "قرطاسية",
    "productType": "دفتر ملاحظات",
    "brand": "روتا",
    "modelName": "سلك A5",
    "attributes": {
      "size": "A5",
      "sheets": "100 ورقة",
      "binding": "سلك معدني"
    },
    "variants": [
      { "color": "أزرق" }
    ],
    "saleUnits": [
      { "name": "قطعة", "conversionFactor": "1" }
    ],
    "verifiedClaims": [],
    "audience": "طلاب وموظفون"
  }
}
```

### د. مهمة الإخراج

```text
أنشئ مسودة محتوى من الحقائق والسياسة أعلاه.

أعد:
- عنوان SEO تعريفياً لا إعلانياً.
- عنواناً مختصراً.
- اسماً سريع القراءة في POS.
- اسماً مناسباً للفواتير.
- نصاً ترويجياً يذكر فائدة حقيقية مستندة إلى الحقائق فقط.
- وصفاً فنياً لا يتجاوز 5 جمل.
- كلمات بحث مشتقة من الكلمات الموجودة في الحقائق، لا أسماء جديدة.

لكل claim أخرج evidenceKeys. إذا لم تجد دليلاً، لا تضع claim في المحتوى وأضفه إلى unsupportedClaims.
```

## 2. مخطط حقائق المنتج باستخدام Zod

يجب التحقق من المدخلات قبل إرسالها إلى النموذج أيضاً. هذا يمنع تمرير كائن غير موثوق أو حقولاً لا يعرفها النظام:

```ts
import { z } from "zod";

const FactValue = z.string().trim().min(1).max(160);

export const ProductFactsSchema = z.object({
  category: FactValue,
  productType: FactValue,
  brand: FactValue.nullable(),
  modelName: FactValue.nullable(),
  attributes: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/), FactValue).default({}),
  variants: z.array(z.object({
    color: FactValue.nullable().optional(),
    size: FactValue.nullable().optional(),
  }).strict()).max(100).default([]),
  saleUnits: z.array(z.object({
    name: FactValue,
    conversionFactor: z.string().regex(/^\d+(\.\d+)?$/),
  }).strict()).max(20).default([]),
  verifiedClaims: z.array(FactValue).max(30).default([]),
  audience: FactValue.nullable().default(null),
}).strict();

export type ProductFacts = z.infer<typeof ProductFactsSchema>;
```

في الإنتاج، لا ينبغي أخذ `verifiedClaims` من نص حر يكتبه أي موظف دون صلاحية. الأفضل أن تأتي من سمات أو موافقات إدارية، مثل `isWaterResistant: true` من مصدر موثوق، وليس من رغبة تسويقية.

## 3. مخطط مخرجات AI باستخدام Zod

اجعل الإخراج مغلقاً بواسطة `.strict()` حتى لا تمرر حقولاً مجهولة:

```ts
const EvidenceKey = z.string()
  .regex(/^(category|productType|brand|modelName|attributes\.[a-zA-Z0-9_.-]+|variants\.[0-9]+\.(color|size)|saleUnits\.[0-9]+\.(name|conversionFactor)|verifiedClaims\.[0-9]+|audience)$/)
  .max(120);

const AiClaimSchema = z.object({
  text: z.string().trim().min(1).max(300),
  evidenceKeys: z.array(EvidenceKey).min(1).max(10),
}).strict();

export const AiProductDraftSchema = z.object({
  seoTitle: z.string().trim().min(1).max(70),
  shortTitle: z.string().trim().min(1).max(60),
  posLabel: z.string().trim().min(1).max(70),
  invoiceLabel: z.string().trim().min(1).max(90),
  marketingCopy: z.string().trim().max(180),
  description: z.string().trim().max(1500),
  keywords: z.array(z.string().trim().min(1).max(80)).max(15),
  claims: z.array(AiClaimSchema).max(10),
  unsupportedClaims: z.array(z.object({
    text: z.string().trim().min(1).max(300),
    reason: z.string().trim().min(1).max(300),
  }).strict()).max(10),
  warnings: z.array(z.string().trim().min(1).max(300)).max(20),
  confidence: z.enum(["low", "medium", "high"]),
}).strict();

export type AiProductDraft = z.infer<typeof AiProductDraftSchema>;
```

`max()` هنا يقيس طول السلسلة كما يراه JavaScript. إذا أردت قياساً أكثر ملاءمة للعربية، أضف فحصاً بـ`Array.from(value).length` بعد `safeParse`.

## 4. استخراج JSON والتحقق البنيوي

حتى مع `response_format` يجب ألا تثق بالنموذج قبل `JSON.parse` و`safeParse`:

```ts
export function parseAiDraft(rawContent: unknown): AiProductDraft {
  if (typeof rawContent !== "string") {
    throw new Error("استجابة الذكاء الاصطناعي ليست نصاً");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw new Error("استجابة الذكاء الاصطناعي ليست JSON صالحاً");
  }

  const result = AiProductDraftSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("؛ ");
    throw new Error(`مخرجات AI غير مطابقة للمخطط: ${details}`);
  }

  return result.data;
}
```

استخدم `safeParse` بدلاً من `parse` داخل مسار API حتى تعيد رسالة عربية نظيفة وتسجل الخطأ داخلياً دون كشف تفاصيل حساسة.

## 5. التحقق الدلالي من مفاتيح الأدلة

كل `claim` يجب أن يشير إلى مفاتيح موجودة فعلاً في كائن الحقائق. هذه الخطوة تمنع النموذج من اختراع `attributes.waterproof` ثم استخدامه كدليل:

```ts
function flattenFacts(facts: ProductFacts): Map<string, string> {
  const out = new Map<string, string>();

  out.set("category", facts.category);
  out.set("productType", facts.productType);
  if (facts.brand) out.set("brand", facts.brand);
  if (facts.modelName) out.set("modelName", facts.modelName);
  if (facts.audience) out.set("audience", facts.audience);

  for (const [key, value] of Object.entries(facts.attributes)) {
    out.set(`attributes.${key}`, value);
  }

  facts.variants.forEach((variant, index) => {
    if (variant.color) out.set(`variants.${index}.color`, variant.color);
    if (variant.size) out.set(`variants.${index}.size`, variant.size);
  });

  facts.saleUnits.forEach((unit, index) => {
    out.set(`saleUnits.${index}.name`, unit.name);
    out.set(`saleUnits.${index}.conversionFactor`, unit.conversionFactor);
  });

  facts.verifiedClaims.forEach((claim, index) => {
    out.set(`verifiedClaims.${index}`, claim);
  });

  return out;
}

function validateEvidenceKeys(
  draft: AiProductDraft,
  facts: ProductFacts,
): string[] {
  const factMap = flattenFacts(facts);
  const issues: string[] = [];

  for (const [index, claim] of draft.claims.entries()) {
    for (const key of claim.evidenceKeys) {
      if (!factMap.has(key)) {
        issues.push(`الادعاء رقم ${index + 1} يشير إلى دليل غير موجود: ${key}`);
      }
    }
  }

  if (draft.description && draft.claims.length === 0) {
    issues.push("الوصف موجود لكن لا توجد claims مرتبطة بأدلة");
  }

  if (draft.marketingCopy && draft.claims.length === 0) {
    issues.push("النص الترويجي موجود لكن لا توجد claims مرتبطة بأدلة");
  }

  return issues;
}
```

## 6. فحص الأرقام والقياسات والألوان

الأرقام من أسهل الأشياء التي يمكن فحصها حتمياً. إذا كانت الحقائق تحتوي `100 ورقة` و`A5` فلا يسمح النظام بمرور `200 ورقة` أو `A4` في النص:

```ts
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

function normalizeDigits(value: string): string {
  return Array.from(value).map((ch) => {
    const ar = ARABIC_DIGITS.indexOf(ch);
    if (ar >= 0) return String(ar);
    const fa = PERSIAN_DIGITS.indexOf(ch);
    if (fa >= 0) return String(fa);
    return ch;
  }).join("");
}

function extractComparableTokens(value: string): string[] {
  const normalized = normalizeDigits(value).toLocaleLowerCase("ar");
  return normalized.match(/[a-z0-9]+(?:[×x*./-][a-z0-9]+)*|[٠-٩۰-۹]+/gi) ?? [];
}

function knownTokens(facts: ProductFacts): Set<string> {
  const values = Array.from(flattenFacts(facts).values());
  return new Set(values.flatMap(extractComparableTokens));
}

function validateNumbersAndTokens(
  draft: AiProductDraft,
  facts: ProductFacts,
): string[] {
  const allowed = knownTokens(facts);
  const text = [
    draft.seoTitle,
    draft.shortTitle,
    draft.posLabel,
    draft.invoiceLabel,
    draft.marketingCopy,
    draft.description,
    ...draft.keywords,
  ].join(" ");

  const issues: string[] = [];
  for (const token of extractComparableTokens(text)) {
    // نتحقق فقط من الأرقام/المقاسات والوحدات، لا من كل الكلمات العربية.
    if (/\d/.test(token) && !allowed.has(token)) {
      issues.push(`رقم أو قياس غير موجود في الحقائق: ${token}`);
    }
  }
  return issues;
}
```

في التطبيق الفعلي، من الأفضل بناء قائمة `protectedTokens` من الحقول الرقمية والمقاسات والوحدات فقط، حتى لا تتحول أسماء الماركات التي تحتوي أرقاماً إلى إنذارات غير دقيقة.

## 7. الكلمات والادعاءات المحظورة

```ts
const UNSUPPORTED_MARKETING_TERMS = [
  "الأفضل",
  "رقم 1",
  "الأرخص",
  "مضمون",
  "أصلي",
  "فاخر",
  "مقاوم للماء",
  "الأكثر مبيعاً",
  "صديق للبيئة",
];

function validateMarketingLanguage(
  draft: AiProductDraft,
  facts: ProductFacts,
): string[] {
  const approvedClaims = facts.verifiedClaims.join(" ").toLocaleLowerCase("ar");
  const text = `${draft.seoTitle} ${draft.marketingCopy} ${draft.description}`
    .toLocaleLowerCase("ar");
  const issues: string[] = [];

  for (const term of UNSUPPORTED_MARKETING_TERMS) {
    if (text.includes(term.toLocaleLowerCase("ar")) && !approvedClaims.includes(term.toLocaleLowerCase("ar"))) {
      issues.push(`ادعاء تسويقي غير معتمد: ${term}`);
    }
  }
  return issues;
}
```

## 8. التحقق من اللون والمقاس داخل الاسم

إذا كان المنتج يحتوي متغيرات ألوان أو مقاسات، فوجود هذه الكلمات في الاسم المركزي قد يسبب تكراراً مثل «قلم أزرق أزرق». لا تمنعها بالضرورة في `invoiceLabel`، لكن امنعها أو حذّر منها في `seoTitle` و`shortTitle` والاسم المركزي حسب سياسة الفئة:

```ts
function validateVariantPlacement(
  draft: AiProductDraft,
  facts: ProductFacts,
): string[] {
  const issues: string[] = [];
  const colors = facts.variants.map((v) => v.color).filter(Boolean) as string[];
  const sizes = facts.variants.map((v) => v.size).filter(Boolean) as string[];

  const title = `${draft.seoTitle} ${draft.shortTitle}`;
  for (const value of [...colors, ...sizes]) {
    if (title.includes(value)) {
      issues.push(`قيمة متغير ظهرت في عنوان عام: ${value}`);
    }
  }
  return issues;
}
```

## 9. جامع التحقق النهائي

```ts
export function validateDraftBeforeApproval(
  draft: AiProductDraft,
  facts: ProductFacts,
): { ok: boolean; blockers: string[]; warnings: string[] } {
  const blockers = [
    ...validateEvidenceKeys(draft, facts),
    ...validateNumbersAndTokens(draft, facts),
    ...validateMarketingLanguage(draft, facts),
  ];

  const warnings = [
    ...validateVariantPlacement(draft, facts),
    ...draft.warnings,
  ];

  return {
    ok: blockers.length === 0,
    blockers,
    warnings: Array.from(new Set(warnings)),
  };
}
```

إذا كان `ok` يساوي `false` فلا يجوز إرسال أي mutation للحفظ. تعرض الواجهة الأخطاء للمستخدم، وتبقى المسودة في الذاكرة أو في جدول `DRAFT` مع تسجيل سبب الرفض.

## 10. استدعاء النموذج من الخادم

```ts
import { invokeLLM } from "../_core/llm";

export async function generateProductDraft(factsInput: unknown) {
  const facts = ProductFactsSchema.parse(factsInput);

  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: JSON.stringify({
          CATEGORY_POLICY,
          VERIFIED_PRODUCT_FACTS: facts,
          TASK: "Generate a draft and return JSON only.",
        }),
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "ai_product_content_draft",
        strict: true,
        schema: AI_PRODUCT_DRAFT_JSON_SCHEMA,
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  const draft = parseAiDraft(content);
  const validation = validateDraftBeforeApproval(draft, facts);

  return {
    draft,
    validation,
    status: validation.ok ? "DRAFT_READY" : "REJECTED",
  } as const;
}
```

`SYSTEM_PROMPT` و`CATEGORY_POLICY` يجب أن يكونا ثابتين على الخادم أو يأتيا من إعدادات إدارية محمية، وليس من نص يرسله الموظف في الطلب.

## 11. الاعتماد والحفظ في قاعدة البيانات

المسار الصحيح هو:

```text
facts validated
    ↓
AI draft generated
    ↓
JSON parsed
    ↓
Zod validation
    ↓
semantic validation
    ↓
DRAFT returned to UI
    ↓
employee reviews and clicks Apply
    ↓
manager approves if required
    ↓
server validates again
    ↓
content saved as APPROVED/PUBLISHED
```

لا تحفظ ناتج AI مباشرة في `products.description` ولا في `products.name`. خزنه في سجل محتوى قناة بحالة `DRAFT`، ثم عند الاعتماد انقل الحقول المحددة إلى `productChannelContent`. وقبل الاعتماد النهائي أعد بناء `facts` من قاعدة البيانات، ولا تعتمد على نسخة أرسلها المتصفح؛ لأن المستخدم قد يغيرها بعد توليد النص.

## 12. أقوى وضع لمنع الاختلاق

للمتطلبات الحساسة، اجعل AI لا يعيد النص النهائي فقط، بل يعيد قائمة مفاتيح حقائق:

```json
{
  "titleFactKeys": ["productType", "brand", "attributes.size", "attributes.sheets"],
  "benefitFactKeys": ["attributes.binding", "audience"],
  "warnings": []
}
```

ثم يستطيع الخادم تركيب النسخة النهائية بقوالب ثابتة:

```ts
function renderSafeMarketingCopy(facts: ProductFacts): string {
  const parts = [
    facts.productType,
    facts.brand,
    facts.attributes.size,
    facts.attributes.sheets,
  ].filter(Boolean);

  return `${parts.join("، ")} — خيار عملي للاستخدام اليومي.`;
}
```

في هذا الوضع تكون الجملة الأخيرة نفسها من قالب مسموح، أو تُبنى من فائدة موجودة في `verifiedClaims`. هنا يصبح دور AI اختيار الحقائق وترتيبها، وليس اختراع خصائص المنتج.

## الخلاصة

الـPrompt وحده لا يضمن عدم الاختلاق، وZod وحده لا يضمن صحة المحتوى. التصميم الموثوق يجمع بين **حقائق منظمة مغلقة، إخراج JSON صارم، مفاتيح أدلة لكل claim، تحقق حتمي للأرقام والسمات والعبارات، ثم مراجعة بشرية قبل الاعتماد**. وإذا أردت منع الاختلاق بأقصى درجة، اجعل الخادم هو الذي يركب النص النهائي من fact keys وقوالب معتمدة، واجعل AI مساعداً في الاختيار والترتيب فقط.
