import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
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
    const options = normalizeOptions(field.options);
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
    return {
      ...field,
      fieldKey,
      label,
      sortOrder: Number.isInteger(field.sortOrder) ? field.sortOrder : (index + 1) * 10,
      options,
      dependency,
      priceDelta: String(field.priceDelta ?? "0"),
      isRequired: !!field.isRequired,
      isActive: field.isActive !== false,
    };
  });

  for (const field of fields) {
    if (field.dependency && !keys.has(field.dependency.fieldKey)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `تبعية الحقل ${field.label} تشير إلى حقل غير موجود.` });
    }
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
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة." });
  const template = (await db.select({ id: productCustomizationTemplates.id }).from(productCustomizationTemplates).where(eq(productCustomizationTemplates.productId, productId)).limit(1))[0];
  if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "لا يوجد قالب تخصيص لهذا المنتج." });
  await db.update(productCustomizationTemplates).set({ isActive }).where(eq(productCustomizationTemplates.id, Number(template.id)));
  return { productId, isActive };
}
