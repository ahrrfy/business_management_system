import { TRPCError } from "@trpc/server";
import { and, asc, count, eq, inArray, like, ne, or } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import {
  productCustomizationFields,
  productCustomizationTemplates,
  categories,
  products,
  type ProductCustomizationDependency,
  type ProductCustomizationOption,
} from "../../drizzle/schema";
import { getDb, type Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { withTx, type Actor } from "./tx";

export type CustomizationFieldInput = {
  id?: number;
  fieldKey: string;
  label: string;
  fieldType: "TEXT" | "TEXTAREA" | "SELECT" | "FILE" | "NUMBER" | "SWATCH";
  isRequired?: boolean;
  sortOrder?: number;
  maxLength?: number | null;
  options?: ProductCustomizationOption[];
  dependency?: ProductCustomizationDependency | null;
  priceDelta?: string;
  isActive?: boolean;
};

export type CustomizationTemplateInput = {
  productId: number;
  expectedTemplateId?: number | null;
  kind: "PRINT" | "GIFT" | "GENERAL";
  title: string;
  description?: string | null;
  isActive?: boolean;
  fields: CustomizationFieldInput[];
};

export type CustomizationTemplateAdmin = {
  id: number;
  productId: number;
  kind: "PRINT" | "GIFT" | "GENERAL";
  title: string;
  description: string | null;
  isActive: boolean;
  fields: Array<{
    id: number;
    fieldKey: string;
    label: string;
    fieldType: CustomizationFieldInput["fieldType"];
    isRequired: boolean;
    sortOrder: number;
    maxLength: number | null;
    options: ProductCustomizationOption[];
    dependency: ProductCustomizationDependency | null;
    priceDelta: string;
    isActive: boolean;
  }>;
};

export type CopyCustomizationTemplateInput = {
  sourceProductId: number;
  sourceTemplate?: CustomizationTemplateInput;
  scope: "PRODUCTS" | "CATEGORY";
  productIds?: number[];
  categoryId?: number;
  expectedMatched?: number;
  expectedExisting?: number;
  overwriteExisting?: boolean;
};

export type CopyCustomizationTemplateResult = {
  sourceTemplateId: number;
  matched: number;
  copied: number;
  skipped: number;
};

export type CustomizationTargetSearchItem = {
  productId: number;
  productName: string;
  categoryName: string | null;
  hasTemplate: boolean;
};

export const CUSTOMIZATION_COPY_MAX_PRODUCTS = 100;
export const CUSTOMIZATION_COPY_MAX_CATEGORY_PRODUCTS = 500;
export const CUSTOMIZATION_TARGET_SEARCH_DEFAULT_LIMIT = 20;
export const CUSTOMIZATION_TARGET_SEARCH_MAX_LIMIT = 50;
const CUSTOMIZATION_FIELD_INSERT_BATCH_SIZE = 1_000;
const CUSTOMIZATION_FIELD_INSERT_BATCH_MAX_BYTES = 512 * 1_024;
const CUSTOMIZATION_COPY_MAX_PAYLOAD_BYTES = 8 * 1_024 * 1_024;

function normalizeOptions(options: ProductCustomizationOption[] | undefined): ProductCustomizationOption[] {
  return (options ?? [])
    .map((option) => ({
      value: String(option.value ?? "").trim(),
      label: String(option.label ?? "").trim(),
      ...(option.priceDelta != null ? { priceDelta: String(option.priceDelta) } : {}),
    }))
    .filter((option) => option.value && option.label);
}

function assertUniqueOptionValues(options: ProductCustomizationOption[], label: string, what: string): void {
  const seen = new Set<string>();
  for (const option of options) {
    const value = String(option.value ?? "").trim();
    if (!value) continue;
    if (seen.has(value)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what,
          why: `قيمة الخيار «${value}» مكررة في الحقل «${label}»`,
          doThis: "اجعل قيمة كل خيار فريدة ثم أعد المحاولة",
        }),
      });
    }
    seen.add(value);
  }
}

function assertOptionValuesFitMaxLength(
  options: ProductCustomizationOption[],
  maxLength: number | null | undefined,
  label: string,
  what: string,
): void {
  if (maxLength == null) return;
  const oversized = options.find((option) => String(option.value ?? "").length > maxLength);
  if (!oversized) return;
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: appErrorMessage({
      what,
      why: `قيمة الخيار «${oversized.value}» أطول من الحد الأقصى للحقل «${label}»`,
      doThis: "ارفع الحد الأقصى للحقل أو قصّر قيمة الخيار ثم أعد المحاولة",
    }),
  });
}

function assertValidDependencyGraph(
  fields: Array<{
    fieldKey: string;
    label: string;
    fieldType?: CustomizationFieldInput["fieldType"];
    options?: ProductCustomizationOption[] | null;
    dependency: ProductCustomizationDependency | null;
  }>,
  what: string,
): void {
  const byKey = new Map(fields.map((field) => [field.fieldKey, field]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (field: (typeof fields)[number]): void => {
    if (visited.has(field.fieldKey)) return;
    if (visiting.has(field.fieldKey)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what,
          why: `تبعيات الحقول تحتوي دورة عند الحقل «${field.label}»`,
          doThis: "اجعل تبعيات الحقول متسلسلة بلا اعتماد دائري ثم أعد المحاولة",
        }),
      });
    }
    visiting.add(field.fieldKey);
    if (field.dependency) {
      const parent = byKey.get(field.dependency.fieldKey);
      if (!parent) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what,
            why: `تبعية الحقل «${field.label}» تشير إلى حقل غير موجود أو غير نشط`,
            doThis: "اختر حقل تبعية نشطاً من القالب ثم أعد المحاولة",
          }),
        });
      }
      if (["SELECT", "SWATCH"].includes(parent.fieldType ?? "") || (parent.options?.length ?? 0) > 0) {
        const allowedValues = new Set((parent.options ?? []).map((option) => String(option.value)));
        const dependencyValues = Array.isArray(field.dependency.value) ? field.dependency.value : [field.dependency.value];
        const unknownValue = dependencyValues.find((value) => !allowedValues.has(String(value)));
        if (unknownValue != null) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what,
              why: `شرط ظهور الحقل «${field.label}» يشير إلى خيار محذوف أو غير موجود في «${parent.label}»`,
              doThis: "اختر قيم شرط الظهور من خيارات الحقل الأب ثم أعد الحفظ",
            }),
          });
        }
      }
      visit(parent);
    }
    visiting.delete(field.fieldKey);
    visited.add(field.fieldKey);
  };
  for (const field of fields) visit(field);
}

function normalizePriceDelta(value: string | undefined, subject: string, what = "تعذّر حفظ قالب التخصيص"): string {
  const normalized = String(value ?? "0").trim();
  if (!/^\d{1,13}(?:\.\d{1,2})?$/.test(normalized)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what,
        why: `فرق السعر في ${subject} يجب أن يكون مبلغاً غير سالب، بمنزلتين عشريتين على الأكثر، وضمن سعة النظام`,
        doThis: "صحّح فرق السعر ثم أعد الحفظ",
      }),
    });
  }
  return normalized;
}

function normalizeDependency(dependency: ProductCustomizationDependency | null | undefined): ProductCustomizationDependency | null {
  if (!dependency) return null;
  const value = Array.isArray(dependency.value)
    ? dependency.value.map((item) => String(item).trim()).filter(Boolean)
    : String(dependency.value).trim();
  if (Array.isArray(value) && value.length === 0) return null;
  if (!Array.isArray(value) && !value) return null;
  return { fieldKey: dependency.fieldKey.trim(), operator: dependency.operator, value };
}

function validateTemplateInput(input: CustomizationTemplateInput): Array<CustomizationFieldInput & { options: ProductCustomizationOption[]; dependency: ProductCustomizationDependency | null }> {
  const title = input.title.trim();
  if (!title) throw new TRPCError({ code: "BAD_REQUEST", message: "عنوان قالب التخصيص مطلوب." });
  if (input.fields.length > 50) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن أن يحتوي القالب على أكثر من 50 حقلاً." });

  const keys = new Set<string>();
  const fields = input.fields.map((field, index) => {
    const fieldKey = field.fieldKey.trim();
    const label = field.label.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{1,79}$/.test(fieldKey)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `مفتاح الحقل غير صالح: ${fieldKey || "فارغ"}.` });
    }
    if (keys.has(fieldKey)) throw new TRPCError({ code: "BAD_REQUEST", message: `مفتاح الحقل مكرر: ${fieldKey}.` });
    keys.add(fieldKey);
    if (!label) throw new TRPCError({ code: "BAD_REQUEST", message: `اسم الحقل مطلوب: ${fieldKey}.` });
    const options = normalizeOptions(field.options).map((option) => ({
      ...option,
      priceDelta: normalizePriceDelta(option.priceDelta, `خيار «${option.label}» في حقل «${label}»`),
    }));
    assertUniqueOptionValues(options, label, "تعذّر حفظ قالب التخصيص");
    const dependency = normalizeDependency(field.dependency);
    if (["SELECT", "SWATCH"].includes(field.fieldType) && options.length === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `الحقل ${label} يحتاج خياراً واحداً على الأقل.` });
    }
    if (dependency?.fieldKey === fieldKey) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `لا يمكن أن يعتمد الحقل ${label} على نفسه.` });
    }
    if (field.maxLength != null && (!Number.isInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > 10_000)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `الحد الأقصى للنص في ${label} غير صالح.` });
    }
    assertOptionValuesFitMaxLength(options, field.maxLength, label, "تعذّر حفظ قالب التخصيص");
    return {
      ...field,
      fieldKey,
      label,
      sortOrder: Number.isInteger(field.sortOrder) ? field.sortOrder : (index + 1) * 10,
      options,
      dependency,
      priceDelta: normalizePriceDelta(field.priceDelta, `الحقل «${label}»`),
      isRequired: !!field.isRequired,
      isActive: field.isActive !== false,
    };
  });

  assertValidDependencyGraph(fields, "تعذّر حفظ قالب التخصيص");
  if (input.isActive !== false) {
    assertValidDependencyGraph(fields.filter((field) => field.isActive !== false), "تعذّر حفظ قالب التخصيص");
  }
  return fields;
}

async function mapTemplate(exec: Pick<Tx, "select">, productId: number): Promise<CustomizationTemplateAdmin | null> {
  const template = (await exec
    .select()
    .from(productCustomizationTemplates)
    .where(eq(productCustomizationTemplates.productId, productId))
    .limit(1))[0];
  if (!template) return null;
  const fields = await exec
    .select()
    .from(productCustomizationFields)
    .where(eq(productCustomizationFields.templateId, Number(template.id)))
    .orderBy(asc(productCustomizationFields.sortOrder), asc(productCustomizationFields.id));
  return {
    id: Number(template.id),
    productId: Number(template.productId),
    kind: template.kind,
    title: template.title,
    description: template.description ?? null,
    isActive: !!template.isActive,
    fields: fields.map((field: typeof productCustomizationFields.$inferSelect) => ({
      id: Number(field.id),
      fieldKey: field.fieldKey,
      label: field.label,
      fieldType: field.fieldType,
      isRequired: !!field.isRequired,
      sortOrder: Number(field.sortOrder ?? 0),
      maxLength: field.maxLength == null ? null : Number(field.maxLength),
      options: Array.isArray(field.optionsJson) ? field.optionsJson : [],
      dependency: field.dependencyJson ?? null,
      priceDelta: String(field.priceDelta ?? "0"),
      isActive: !!field.isActive,
    })),
  };
}

export async function getProductCustomizationTemplate(productId: number): Promise<CustomizationTemplateAdmin | null> {
  const db = getDb();
  if (!db) return null;
  return mapTemplate(db, productId);
}

export async function searchProductCustomizationTargets(input: {
  q?: string;
  categoryId?: number | null;
  excludeProductId?: number;
  limit?: number;
}): Promise<{ items: CustomizationTargetSearchItem[]; total: number; withTemplate: number }> {
  const db = getDb();
  if (!db) return { items: [], total: 0, withTemplate: 0 };
  const q = input.q?.trim() ?? "";
  if (!q && input.categoryId == null) return { items: [], total: 0, withTemplate: 0 };
  const conditions = [eq(products.isActive, true)];
  if (input.categoryId != null) conditions.push(eq(products.categoryId, input.categoryId));
  if (input.excludeProductId != null) conditions.push(ne(products.id, input.excludeProductId));
  if (q) {
    const term = `%${q}%`;
    conditions.push(or(
      like(products.name, term),
      like(products.internalName, term),
      like(products.storeTitle, term),
    )!);
  }
  const where = and(...conditions);
  const items = await db.select({
      productId: products.id,
      productName: products.name,
      categoryName: categories.name,
      templateId: productCustomizationTemplates.id,
    })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .leftJoin(productCustomizationTemplates, eq(productCustomizationTemplates.productId, products.id))
      .where(where)
      .orderBy(asc(products.name))
      .limit(Math.min(Math.max(input.limit ?? CUSTOMIZATION_TARGET_SEARCH_DEFAULT_LIMIT, 1), CUSTOMIZATION_TARGET_SEARCH_MAX_LIMIT));
  const totals = input.categoryId == null
    ? [{
        total: items.length,
        withTemplate: items.filter((item) => item.templateId != null).length,
      }]
    : await db.select({
        total: count(),
        withTemplate: count(productCustomizationTemplates.id),
      })
        .from(products)
        .leftJoin(productCustomizationTemplates, eq(productCustomizationTemplates.productId, products.id))
        .where(where);
  return {
    items: items.map((item) => ({
      productId: Number(item.productId),
      productName: item.productName,
      categoryName: item.categoryName ?? null,
      hasTemplate: item.templateId != null,
    })),
    total: Number(totals[0]?.total ?? 0),
    withTemplate: Number(totals[0]?.withTemplate ?? 0),
  };
}

type ValidatedCustomizationField = ReturnType<typeof validateTemplateInput>[number];

async function replaceProductCustomizationTemplateInTx(
  tx: Tx,
  input: CustomizationTemplateInput,
  fields: ValidatedCustomizationField[],
  lockedProduct?: { id: number; isCustomizable: boolean },
  lockedTemplateId?: number | null,
): Promise<number> {
  const product = lockedProduct ?? (await tx
    .select({ id: products.id, isCustomizable: products.isCustomizable })
    .from(products)
    .where(eq(products.id, input.productId))
    .limit(1)
    .for("update"))[0];
  if (!product) throw new TRPCError({ code: "NOT_FOUND", message: "المنتج غير موجود." });
  if (!product.isCustomizable) throw new TRPCError({ code: "BAD_REQUEST", message: "فعّل «قابل للتخصيص» للمنتج قبل حفظ القالب." });

  const existingTemplateId = lockedTemplateId === undefined
    ? Number((await tx.select({ id: productCustomizationTemplates.id })
        .from(productCustomizationTemplates)
        .where(eq(productCustomizationTemplates.productId, input.productId))
        .limit(1)
        .for("update"))[0]?.id ?? 0) || null
    : lockedTemplateId;
  if (input.expectedTemplateId !== undefined && input.expectedTemplateId !== existingTemplateId) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "لم يُحفظ قالب التخصيص",
        why: "حُدّث القالب من مستخدم آخر بعد فتح هذه الشاشة",
        doThis: "أعد تحميل المنتج وراجع التعديل الأحدث ثم أعد الحفظ",
      }),
    });
  }
  // هوية القالب جزء من عقد السلة العامة. أي تغيير في المخطط يجب أن ينشئ هوية
  // جديدة كي ترفض عملية الدفع السلال القديمة بدلاً من تفسير قيمها بمخطط مختلف.
  if (existingTemplateId != null) {
    await tx.delete(productCustomizationTemplates).where(eq(productCustomizationTemplates.id, existingTemplateId));
  }
  const templateId = extractInsertId(await tx.insert(productCustomizationTemplates).values({
    productId: input.productId,
    kind: input.kind,
    title: input.title.trim(),
    description: input.description?.trim() || null,
    isActive: input.isActive !== false,
  }));

  if (fields.length > 0) {
    await tx.insert(productCustomizationFields).values(fields.map((field) => ({
      templateId,
      fieldKey: field.fieldKey,
      label: field.label,
      fieldType: field.fieldType,
      isRequired: field.isRequired,
      sortOrder: field.sortOrder,
      maxLength: field.maxLength ?? null,
      optionsJson: field.options,
      dependencyJson: field.dependency,
      priceDelta: field.priceDelta,
      isActive: field.isActive,
    })));
  }
  return templateId;
}

export async function saveProductCustomizationTemplate(input: CustomizationTemplateInput, _actor: Actor): Promise<CustomizationTemplateAdmin> {
  const fields = validateTemplateInput(input);
  return withTx(async (tx) => {
    await replaceProductCustomizationTemplateInTx(tx, input, fields);
    const result = await mapTemplate(tx, input.productId);
    if (!result) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر قراءة قالب التخصيص بعد الحفظ." });
    return result;
  }, { gate: "NONE" });
}

/**
 * ينسخ قالباً محفوظاً إلى منتجات بعينها أو إلى فئة كاملة.
 *
 * الحماية هي الافتراضية: أي منتج له قالب سابق يُتخطّى ما لم يطلب المدير الاستبدال صراحةً.
 * تُنفّذ العملية كلها في معاملة واحدة كي لا تنتهي الفئة بنصف قالب عند فشل أي حقل.
 */
export async function copyProductCustomizationTemplate(
  input: CopyCustomizationTemplateInput,
  _actor: Actor,
): Promise<CopyCustomizationTemplateResult> {
  const draftFields = input.sourceTemplate ? validateTemplateInput(input.sourceTemplate) : null;
  if (input.sourceTemplate && input.sourceTemplate.productId !== input.sourceProductId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حفظ قالب المصدر ونسخه",
        why: "معرّف المنتج داخل القالب لا يطابق المنتج المصدر",
        doThis: "أعد فتح المنتج الصحيح ثم نفّذ النسخ من شاشة تعديله",
      }),
    });
  }
  const requestedIds = Array.from(new Set((input.productIds ?? []).map(Number)))
    .filter((productId) => Number.isInteger(productId) && productId > 0 && productId !== input.sourceProductId);
  if (input.scope === "PRODUCTS" && requestedIds.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "لم يبدأ نسخ قالب التخصيص",
        why: "لم تحدد أي منتج مستهدف",
        doThis: "اختر منتجاً واحداً على الأقل ثم أعد النسخ",
      }),
    });
  }
  if (input.scope === "CATEGORY" && !input.categoryId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "لم يبدأ تعميم قالب التخصيص",
        why: "لم تحدد الفئة المستهدفة",
        doThis: "اختر فئة واحدة ثم أعد التعميم",
      }),
    });
  }
  if (requestedIds.length > CUSTOMIZATION_COPY_MAX_PRODUCTS) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر نسخ قالب التخصيص إلى المنتجات المختارة",
        why: `الاختيار يضم ${requestedIds.length} منتجاً والحد الأعلى للعملية الواحدة ${CUSTOMIZATION_COPY_MAX_PRODUCTS} منتج`,
        doThis: `قسّم المنتجات إلى مجموعات لا تتجاوز ${CUSTOMIZATION_COPY_MAX_PRODUCTS} منتج ثم أعد النسخ`,
      }),
    });
  }

  return withTx(async (tx) => {
    const lockedProducts = await tx
      .select({
        id: products.id,
        isCustomizable: products.isCustomizable,
        isActive: products.isActive,
        categoryId: products.categoryId,
      })
      .from(products)
      .where(input.scope === "CATEGORY"
        ? or(
            eq(products.id, input.sourceProductId),
            and(eq(products.isActive, true), eq(products.categoryId, Number(input.categoryId))),
          )
        : inArray(products.id, [input.sourceProductId, ...requestedIds]))
      .orderBy(asc(products.id))
      .limit(input.scope === "CATEGORY" ? CUSTOMIZATION_COPY_MAX_CATEGORY_PRODUCTS + 2 : requestedIds.length + 1)
      // قفل القراءة نفسه يصنع لقطة عضوية ثابتة للفئة ويمنع phantom عضواً جديداً
      // حتى انتهاء النسخ، مع إبقاء ترتيب الأقفال: المنتجات ثم القوالب.
      .for("update");
    const candidateTargetIds = lockedProducts
      .filter((product) => product.isActive === true)
      .filter((product) => input.scope === "CATEGORY"
        ? Number(product.categoryId) === Number(input.categoryId)
        : requestedIds.includes(Number(product.id)))
      .map((product) => Number(product.id))
      .filter((productId) => productId !== input.sourceProductId);
    if (input.scope === "CATEGORY" && candidateTargetIds.length > CUSTOMIZATION_COPY_MAX_CATEGORY_PRODUCTS) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تعميم قالب التخصيص على الفئة",
          why: `الفئة تضم أكثر من ${CUSTOMIZATION_COPY_MAX_CATEGORY_PRODUCTS} منتج وهو الحد الأعلى للعملية الواحدة`,
          doThis: `اختر المنتجات المطلوبة على مجموعات لا تتجاوز ${CUSTOMIZATION_COPY_MAX_PRODUCTS} منتج بدلاً من تعميم الفئة`,
        }),
      });
    }
    if (candidateTargetIds.length === 0) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "لم يُنسخ قالب التخصيص",
          why: "لا توجد منتجات نشطة مطابقة غير المنتج المصدر",
          doThis: "اختر منتجات نشطة أخرى أو فئة تحتوي منتجات أخرى ثم أعد النسخ",
        }),
      });
    }
    const sourceProduct = lockedProducts.find((product) => Number(product.id) === input.sourceProductId);
    if (!sourceProduct) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر نسخ قالب التخصيص",
          why: "المنتج المصدر لم يعد موجوداً",
          doThis: "ارجع إلى قائمة المنتجات واختر منتجاً موجوداً ثم أعد النسخ",
        }),
      });
    }
    const targetIds = candidateTargetIds;
    if (input.scope === "PRODUCTS" && (
      targetIds.length !== requestedIds.length
      || requestedIds.some((productId) => !targetIds.includes(productId))
    )) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "لم يُنسخ قالب التخصيص",
          why: "أحد المنتجات المحددة حُذف أو أصبح غير نشط بعد اختياره",
          doThis: "أعد تحميل قائمة المنتجات وحدد المنتجات النشطة من جديد",
        }),
      });
    }
    if (targetIds.length === 0) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "لم يُنسخ قالب التخصيص",
          why: "تغيّرت حالة المنتجات المستهدفة قبل بدء العملية",
          doThis: "أعد اختيار المنتجات النشطة ثم أعد النسخ",
        }),
      });
    }

    const lockedTemplates = await tx
      .select({
        id: productCustomizationTemplates.id,
        productId: productCustomizationTemplates.productId,
        kind: productCustomizationTemplates.kind,
        title: productCustomizationTemplates.title,
        description: productCustomizationTemplates.description,
        isActive: productCustomizationTemplates.isActive,
      })
      .from(productCustomizationTemplates)
      .where(inArray(productCustomizationTemplates.productId, [input.sourceProductId, ...targetIds]))
      .orderBy(asc(productCustomizationTemplates.productId))
      .for("update");
    const sourceTemplateRow = lockedTemplates.find((template) => Number(template.productId) === input.sourceProductId);
    const existingTemplates = lockedTemplates.filter((template) => Number(template.productId) !== input.sourceProductId);
    if (input.scope === "CATEGORY" && (
      (input.expectedMatched != null && input.expectedMatched !== targetIds.length)
      || (input.expectedExisting != null && input.expectedExisting !== existingTemplates.length)
    )) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تغيّرت منتجات الفئة منذ عرض المعاينة",
          why: "أضيف منتج أو قالب تخصيص أو تغيّرت حالته أثناء تجهيز العملية",
          doThis: "أعد تحميل معاينة الفئة ثم راجع الأعداد وأعد التنفيذ",
        }),
      });
    }

    let source: {
      id: number;
      kind: CustomizationTemplateInput["kind"];
      title: string;
      description: string | null;
      isActive: boolean;
    };
    let sourceFields: Array<{
      fieldKey: string;
      label: string;
      fieldType: CustomizationFieldInput["fieldType"];
      isRequired: boolean;
      sortOrder: number;
      maxLength: number | null;
      optionsJson: ProductCustomizationOption[] | null;
      dependencyJson: ProductCustomizationDependency | null;
      priceDelta: string;
      isActive: boolean;
    }>;
    if (input.sourceTemplate && draftFields) {
      source = {
        id: Number(sourceTemplateRow?.id ?? 0),
        kind: input.sourceTemplate.kind,
        title: input.sourceTemplate.title.trim(),
        description: input.sourceTemplate.description?.trim() || null,
        isActive: input.sourceTemplate.isActive !== false,
      };
      sourceFields = draftFields.map((field) => ({
        fieldKey: field.fieldKey,
        label: field.label,
        fieldType: field.fieldType,
        isRequired: field.isRequired === true,
        sortOrder: field.sortOrder ?? 0,
        maxLength: field.maxLength ?? null,
        optionsJson: field.options,
        dependencyJson: field.dependency,
        priceDelta: field.priceDelta ?? "0",
        isActive: field.isActive !== false,
      }));
    } else {
      if (!sourceTemplateRow) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "تعذّر نسخ قالب التخصيص",
            why: "المنتج المصدر لا يملك قالب تخصيص محفوظاً",
            doThis: "احفظ قالب المنتج الحالي أولاً ثم أعد النسخ",
          }),
        });
      }
      source = {
        id: Number(sourceTemplateRow.id),
        kind: sourceTemplateRow.kind,
        title: sourceTemplateRow.title,
        description: sourceTemplateRow.description,
        isActive: sourceTemplateRow.isActive,
      };
      sourceFields = await tx.select({
        fieldKey: productCustomizationFields.fieldKey,
        label: productCustomizationFields.label,
        fieldType: productCustomizationFields.fieldType,
        isRequired: productCustomizationFields.isRequired,
        sortOrder: productCustomizationFields.sortOrder,
        maxLength: productCustomizationFields.maxLength,
        optionsJson: productCustomizationFields.optionsJson,
        dependencyJson: productCustomizationFields.dependencyJson,
        priceDelta: productCustomizationFields.priceDelta,
        isActive: productCustomizationFields.isActive,
      }).from(productCustomizationFields)
        .where(eq(productCustomizationFields.templateId, Number(sourceTemplateRow.id)))
        .orderBy(asc(productCustomizationFields.sortOrder), asc(productCustomizationFields.id))
        .for("update");
    }
    const existingByProduct = new Map(existingTemplates.map((template) => [Number(template.productId), Number(template.id)]));
    const copyTargetIds = targetIds.filter((productId) => input.overwriteExisting || !existingByProduct.has(productId));
    const skipped = targetIds.length - copyTargetIds.length;

    const serializedTemplateBytes = Buffer.byteLength(JSON.stringify({
      kind: source.kind,
      title: source.title,
      description: source.description,
      isActive: source.isActive,
      fields: sourceFields,
    }), "utf8");
    const totalPayloadBytes = serializedTemplateBytes * (copyTargetIds.length + (input.sourceTemplate ? 1 : 0));
    if (totalPayloadBytes > CUSTOMIZATION_COPY_MAX_PAYLOAD_BYTES) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر نسخ قالب التخصيص بهذه الدفعة",
          why: `الحجم الإجمالي المقدر ${Math.ceil(totalPayloadBytes / 1_048_576)} ميغابايت ويتجاوز حد العملية الآمن`,
          doThis: "قلّل عدد المنتجات في الدفعة أو بسّط خيارات القالب ثم أعد النسخ",
        }),
      });
    }

    // حفظ مسودة المصدر جزء من المعاملة نفسها، وبعد اجتياز كل حدود النطاق والحجم.
    if (input.sourceTemplate && draftFields) {
      source.id = await replaceProductCustomizationTemplateInTx(
        tx,
        input.sourceTemplate,
        draftFields,
        { id: Number(sourceProduct.id), isCustomizable: sourceProduct.isCustomizable === true },
        sourceTemplateRow ? Number(sourceTemplateRow.id) : null,
      );
    }

    if (copyTargetIds.length > 0) {
      await tx.update(products).set({ isCustomizable: true }).where(inArray(products.id, copyTargetIds));

      const replacedTemplateIds = copyTargetIds
        .map((productId) => existingByProduct.get(productId))
        .filter((templateId): templateId is number => templateId != null);
      if (replacedTemplateIds.length > 0) {
        // الحذف المتسلسل للحقول ثم إنشاء القالب بهوية جديدة يبطل السلال القديمة بأمان.
        await tx.delete(productCustomizationTemplates).where(inArray(productCustomizationTemplates.id, replacedTemplateIds));
      }

      await tx.insert(productCustomizationTemplates).values(copyTargetIds.map((productId) => ({
        productId,
        kind: source.kind,
        title: source.title,
        description: source.description,
        isActive: source.isActive,
      })));

      const insertedTemplates = await tx
        .select({ id: productCustomizationTemplates.id, productId: productCustomizationTemplates.productId })
        .from(productCustomizationTemplates)
        .where(inArray(productCustomizationTemplates.productId, copyTargetIds))
        .for("update");
      const insertedByProduct = new Map(insertedTemplates.map((template) => [Number(template.productId), Number(template.id)]));
      if (insertedByProduct.size !== copyTargetIds.length) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "تعذّر التحقق من اكتمال قوالب التخصيص المنسوخة.",
        });
      }

      const fieldRows: Array<typeof productCustomizationFields.$inferInsert> = [];
      for (const productId of copyTargetIds) {
        const templateId = insertedByProduct.get(productId)!;
        for (const field of sourceFields) {
          fieldRows.push({
            templateId,
            fieldKey: field.fieldKey,
            label: field.label,
            fieldType: field.fieldType,
            isRequired: field.isRequired,
            sortOrder: field.sortOrder,
            maxLength: field.maxLength,
            optionsJson: field.optionsJson,
            dependencyJson: field.dependencyJson,
            priceDelta: field.priceDelta,
            isActive: field.isActive,
          });
        }
      }
      let batch: Array<typeof productCustomizationFields.$inferInsert> = [];
      let batchBytes = 0;
      for (const row of fieldRows) {
        const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8") + 64;
        if (batch.length > 0 && (
          batch.length >= CUSTOMIZATION_FIELD_INSERT_BATCH_SIZE
          || batchBytes + rowBytes > CUSTOMIZATION_FIELD_INSERT_BATCH_MAX_BYTES
        )) {
          await tx.insert(productCustomizationFields).values(batch);
          batch = [];
          batchBytes = 0;
        }
        batch.push(row);
        batchBytes += rowBytes;
      }
      if (batch.length > 0) {
        await tx.insert(productCustomizationFields).values(batch);
      }
    }

    return {
      sourceTemplateId: source.id,
      matched: targetIds.length,
      copied: copyTargetIds.length,
      skipped,
    };
  }, { gate: "NONE" });
}

export async function setProductCustomizationTemplateActive(productId: number, isActive: boolean, _actor: Actor, expectedTemplateId?: number) {
  return withTx(async (tx) => {
    await tx.select({ id: products.id }).from(products).where(eq(products.id, productId)).limit(1).for("update");
    const template = (await tx.select({ id: productCustomizationTemplates.id }).from(productCustomizationTemplates).where(eq(productCustomizationTemplates.productId, productId)).limit(1).for("update"))[0];
    if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "لا يوجد قالب تخصيص لهذا المنتج." });
    if (expectedTemplateId !== undefined && Number(template.id) !== expectedTemplateId) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "لم تتغير حالة ظهور قالب التخصيص",
          why: "حُدّث القالب من مستخدم آخر بعد فتح هذه الشاشة",
          doThis: "أعد تحميل المنتج وراجع القالب الأحدث ثم أعد المحاولة",
        }),
      });
    }
    if (isActive) {
      const fields = await tx.select({
        fieldKey: productCustomizationFields.fieldKey,
        label: productCustomizationFields.label,
        fieldType: productCustomizationFields.fieldType,
        maxLength: productCustomizationFields.maxLength,
        options: productCustomizationFields.optionsJson,
        dependency: productCustomizationFields.dependencyJson,
        priceDelta: productCustomizationFields.priceDelta,
      }).from(productCustomizationFields).where(and(
        eq(productCustomizationFields.templateId, Number(template.id)),
        eq(productCustomizationFields.isActive, true),
      ));
      assertValidDependencyGraph(fields, "تعذّر تفعيل قالب التخصيص");
      for (const field of fields) {
        normalizePriceDelta(String(field.priceDelta ?? "0"), `الحقل «${field.label}»`, "تعذّر تفعيل قالب التخصيص");
        assertUniqueOptionValues(field.options ?? [], field.label, "تعذّر تفعيل قالب التخصيص");
        assertOptionValuesFitMaxLength(field.options ?? [], field.maxLength, field.label, "تعذّر تفعيل قالب التخصيص");
        for (const option of field.options ?? []) {
          normalizePriceDelta(option.priceDelta, `خيار «${option.label}» في حقل «${field.label}»`, "تعذّر تفعيل قالب التخصيص");
        }
      }
    }
    await tx.update(productCustomizationTemplates).set({ isActive }).where(eq(productCustomizationTemplates.id, Number(template.id)));
    return { productId, templateId: Number(template.id), isActive };
  }, { gate: "NONE" });
}
