import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import {
  productCustomizationFields,
  productCustomizationTemplates,
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
  fields: Array<{ fieldKey: string; label: string; dependency: ProductCustomizationDependency | null }>,
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

export async function saveProductCustomizationTemplate(input: CustomizationTemplateInput, _actor: Actor): Promise<CustomizationTemplateAdmin> {
  const fields = validateTemplateInput(input);
  return withTx(async (tx) => {
    const product = (await tx.select({ id: products.id, isCustomizable: products.isCustomizable }).from(products).where(eq(products.id, input.productId)).limit(1))[0];
    if (!product) throw new TRPCError({ code: "NOT_FOUND", message: "المنتج غير موجود." });
    if (!product.isCustomizable) throw new TRPCError({ code: "BAD_REQUEST", message: "فعّل «قابل للتخصيص» للمنتج قبل حفظ القالب." });

    const existing = (await tx.select({ id: productCustomizationTemplates.id }).from(productCustomizationTemplates).where(eq(productCustomizationTemplates.productId, input.productId)).limit(1))[0];
    const templateId = existing
      ? Number(existing.id)
      : extractInsertId(await tx.insert(productCustomizationTemplates).values({
          productId: input.productId,
          kind: input.kind,
          title: input.title.trim(),
          description: input.description?.trim() || null,
          isActive: input.isActive !== false,
        }));

    if (existing) {
      await tx.update(productCustomizationTemplates).set({
        kind: input.kind,
        title: input.title.trim(),
        description: input.description?.trim() || null,
        isActive: input.isActive !== false,
      }).where(eq(productCustomizationTemplates.id, templateId));
    }

    await tx.delete(productCustomizationFields).where(eq(productCustomizationFields.templateId, templateId));
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
    const result = await mapTemplate(tx, input.productId);
    if (!result) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر قراءة قالب التخصيص بعد الحفظ." });
    return result;
  }, { gate: "NONE" });
}

export async function setProductCustomizationTemplateActive(productId: number, isActive: boolean, _actor: Actor) {
  return withTx(async (tx) => {
    const template = (await tx.select({ id: productCustomizationTemplates.id }).from(productCustomizationTemplates).where(eq(productCustomizationTemplates.productId, productId)).limit(1))[0];
    if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "لا يوجد قالب تخصيص لهذا المنتج." });
    if (isActive) {
      const fields = await tx.select({
        fieldKey: productCustomizationFields.fieldKey,
        label: productCustomizationFields.label,
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
    return { productId, isActive };
  }, { gate: "NONE" });
}
