import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { copyProductCustomizationTemplate, saveProductCustomizationTemplate, searchProductCustomizationTargets, setProductCustomizationTemplateActive } from "../productCustomizationService";
import { truncateAllTables } from "./__testUtils__";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

const actor = { userId: 1, branchId: 1, role: "admin" as const };

beforeEach(async () => {
  await truncateAllTables();
  await db().insert(s.categories).values([
    { id: 1, name: "الأختام" },
    { id: 2, name: "فئة أخرى" },
  ]);
  await db().insert(s.products).values([
    { id: 1, name: "الختم المصدر", categoryId: 1, isCustomizable: true },
    { id: 2, name: "ختم بلا قالب", categoryId: 1, isCustomizable: false },
    { id: 3, name: "ختم بقالب سابق", categoryId: 1, isCustomizable: true },
    { id: 4, name: "منتج خارج الفئة", categoryId: 2, isCustomizable: false },
    { id: 5, name: "ختم غير نشط", categoryId: 1, isCustomizable: false, isActive: false },
  ]);
  await db().insert(s.productCustomizationTemplates).values([
    { id: 1, productId: 1, kind: "GENERAL", title: "تفاصيل الختم", description: "اكتب التفاصيل" },
    { id: 3, productId: 3, kind: "GENERAL", title: "قالب سابق" },
  ]);
  await db().insert(s.productCustomizationFields).values([
    {
      id: 1,
      templateId: 1,
      fieldKey: "service",
      label: "نوع التنفيذ",
      fieldType: "SELECT",
      isRequired: true,
      sortOrder: 5,
      maxLength: 20,
      optionsJson: [
        { value: "standard", label: "عادي", priceDelta: "10.00" },
        { value: "premium", label: "مميز", priceDelta: "25.50" },
      ],
      dependencyJson: null,
      priceDelta: "1.25",
      isActive: true,
    },
    {
      id: 2,
      templateId: 1,
      fieldKey: "details",
      label: "تفاصيل الختم المطلوبة",
      fieldType: "TEXTAREA",
      isRequired: false,
      sortOrder: 30,
      maxLength: 2000,
      optionsJson: null,
      dependencyJson: { fieldKey: "service", operator: "equals", value: ["premium"] },
      priceDelta: "2.50",
      isActive: false,
    },
    { id: 3, templateId: 3, fieldKey: "old", label: "حقل سابق", fieldType: "TEXT", sortOrder: 10 },
  ]);
});

function portableFields(rows: Array<typeof s.productCustomizationFields.$inferSelect>) {
  return rows
    .map(({ id: _id, templateId: _templateId, createdAt: _createdAt, updatedAt: _updatedAt, ...field }) => field)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

describe("نسخ قالب تخصيص المنتج", () => {
  it("ينشئ هوية قالب جديدة عند الحفظ كي لا تُفسر سلة قديمة بمخطط جديد", async () => {
    const saved = await saveProductCustomizationTemplate({
      productId: 1,
      expectedTemplateId: 1,
      kind: "GENERAL",
      title: "تفاصيل ختم محدّثة",
      description: "اكتب المطلوب",
      fields: [{
        fieldKey: "newDetails",
        label: "التفاصيل الجديدة",
        fieldType: "TEXTAREA",
        isRequired: true,
        sortOrder: 10,
        maxLength: 1000,
      }],
    }, actor);

    expect(saved.id).not.toBe(1);
    expect(saved.fields).toEqual([
      expect.objectContaining({ fieldKey: "newDetails", label: "التفاصيل الجديدة" }),
    ]);
  });

  it("يعرض للموظف المنتجات مع تنبيه واضح إن كان لها قالب سابق", async () => {
    const result = await searchProductCustomizationTargets({ q: "ختم", limit: 10 });

    expect(result.total).toBe(3);
    expect(result.withTemplate).toBe(2);
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: 2, hasTemplate: false }),
      expect.objectContaining({ productId: 3, hasTemplate: true }),
    ]));
  });

  it("يرفض معاينة فئة قديمة ولا يحفظ مسودة المصدر جزئياً", async () => {
    await expect(copyProductCustomizationTemplate({
      sourceProductId: 1,
      sourceTemplate: {
        productId: 1,
        expectedTemplateId: 1,
        kind: "GENERAL",
        title: "عنوان لا يجب حفظه",
        fields: [{
          fieldKey: "replacement",
          label: "حقل بديل",
          fieldType: "TEXTAREA",
          isRequired: true,
        }],
      },
      scope: "CATEGORY",
      categoryId: 1,
      expectedMatched: 2,
      expectedExisting: 0,
      overwriteExisting: true,
    }, actor)).rejects.toMatchObject({ code: "CONFLICT" });

    expect((await db().select().from(s.productCustomizationTemplates).where(eq(s.productCustomizationTemplates.productId, 1)))[0])
      .toMatchObject({ id: 1, title: "تفاصيل الختم" });
    expect(await db().select().from(s.productCustomizationFields).where(eq(s.productCustomizationFields.templateId, 1)))
      .toHaveLength(2);
  });

  it("يرفض حمولة النسخ الضخمة قبل استبدال قالب المصدر", async () => {
    const targetIds = [10, 11, 12, 13, 14, 15];
    await db().insert(s.products).values(targetIds.map((id) => ({
      id,
      name: `هدف ${id}`,
      categoryId: 2,
      isCustomizable: false,
    })));
    const fields = Array.from({ length: 50 }, (_, fieldIndex) => ({
      fieldKey: `f${fieldIndex + 1}`,
      label: "ح".repeat(160),
      fieldType: "SELECT" as const,
      isRequired: true,
      options: Array.from({ length: 100 }, (_, optionIndex) => ({
        value: `v${fieldIndex}_${optionIndex}`,
        label: "خ".repeat(160),
        priceDelta: "0",
      })),
    }));

    await expect(copyProductCustomizationTemplate({
      sourceProductId: 1,
      sourceTemplate: {
        productId: 1,
        expectedTemplateId: 1,
        kind: "GENERAL",
        title: "عنوان ضخم لا يجب حفظه",
        fields,
      },
      scope: "PRODUCTS",
      productIds: targetIds,
      overwriteExisting: false,
    }, actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect((await db().select().from(s.productCustomizationTemplates).where(eq(s.productCustomizationTemplates.productId, 1)))[0])
      .toMatchObject({ id: 1, title: "تفاصيل الختم" });
    expect(await db().select().from(s.productCustomizationTemplates)
      .where(inArray(s.productCustomizationTemplates.productId, targetIds))).toHaveLength(0);
  });

  it("يرفض مسودة مصدر قديمة قبل أن تمحو قالباً أحدث", async () => {
    await expect(saveProductCustomizationTemplate({
      productId: 1,
      expectedTemplateId: 999,
      kind: "GENERAL",
      title: "مسودة قديمة",
      fields: [{ fieldKey: "details", label: "تفاصيل قديمة", fieldType: "TEXTAREA" }],
    }, actor)).rejects.toMatchObject({ code: "CONFLICT" });

    expect((await db().select().from(s.productCustomizationTemplates).where(eq(s.productCustomizationTemplates.productId, 1)))[0])
      .toMatchObject({ id: 1, title: "تفاصيل الختم" });
  });

  it("يرفض شرط ظهور يستخدم اسم الخيار بدلاً من قيمته التقنية", async () => {
    await expect(saveProductCustomizationTemplate({
      productId: 1,
      expectedTemplateId: 1,
      kind: "GENERAL",
      title: "قالب بشرط غير صالح",
      fields: [
        { fieldKey: "service", label: "الخدمة", fieldType: "SELECT", options: [{ value: "premium", label: "مميز" }] },
        { fieldKey: "details", label: "التفاصيل", fieldType: "TEXTAREA", dependency: { fieldKey: "service", operator: "equals", value: "مميز" } },
      ],
    }, actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect((await db().select().from(s.productCustomizationTemplates).where(eq(s.productCustomizationTemplates.productId, 1)))[0])
      .toMatchObject({ id: 1, title: "تفاصيل الختم" });
  });

  it("يرفض تغيير الظهور من شاشة قديمة بعد حفظ قالب أحدث", async () => {
    const saved = await saveProductCustomizationTemplate({
      productId: 1,
      expectedTemplateId: 1,
      kind: "GENERAL",
      title: "القالب الأحدث",
      isActive: true,
      fields: [{ fieldKey: "details", label: "التفاصيل", fieldType: "TEXTAREA" }],
    }, actor);

    await expect(setProductCustomizationTemplateActive(1, false, actor, 1))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect((await db().select().from(s.productCustomizationTemplates).where(eq(s.productCustomizationTemplates.id, saved.id)))[0])
      .toMatchObject({ isActive: true });
  });

  it("يرفض مجموعة منتجات ناقصة ذرياً ولا يحفظ مسودة المصدر", async () => {
    await expect(copyProductCustomizationTemplate({
      sourceProductId: 1,
      sourceTemplate: {
        productId: 1,
        expectedTemplateId: 1,
        kind: "GENERAL",
        title: "عنوان لا يجب حفظه",
        fields: [{ fieldKey: "details", label: "التفاصيل", fieldType: "TEXTAREA" }],
      },
      scope: "PRODUCTS",
      productIds: [2, 999],
      overwriteExisting: false,
    }, actor)).rejects.toMatchObject({ code: "CONFLICT" });

    expect((await db().select().from(s.productCustomizationTemplates).where(eq(s.productCustomizationTemplates.productId, 1)))[0])
      .toMatchObject({ id: 1, title: "تفاصيل الختم" });
    expect(await db().select().from(s.productCustomizationTemplates).where(eq(s.productCustomizationTemplates.productId, 2)))
      .toHaveLength(0);
  });

  it("ينسخ إلى المنتجات المختارة ويفعّل التخصيص مع حماية القوالب الموجودة", async () => {
    const result = await copyProductCustomizationTemplate({
      sourceProductId: 1,
      scope: "PRODUCTS",
      productIds: [2, 3],
      overwriteExisting: false,
    }, actor);

    expect(result).toEqual({ sourceTemplateId: 1, matched: 2, copied: 1, skipped: 1 });
    const copiedProduct = (await db().select().from(s.products).where(eq(s.products.id, 2)))[0];
    expect(copiedProduct?.isCustomizable).toBe(true);
    const templates = await db().select().from(s.productCustomizationTemplates);
    expect(templates.find((template) => template.productId === 2)).toMatchObject({ kind: "GENERAL", title: "تفاصيل الختم" });
    expect(templates.find((template) => template.productId === 3)).toMatchObject({ title: "قالب سابق" });
    const copiedTemplate = templates.find((template) => template.productId === 2)!;
    const sourceFields = await db().select().from(s.productCustomizationFields).where(eq(s.productCustomizationFields.templateId, 1));
    const copiedFields = await db().select().from(s.productCustomizationFields).where(eq(s.productCustomizationFields.templateId, copiedTemplate.id));
    expect(portableFields(copiedFields)).toEqual(portableFields(sourceFields));
  });

  it("يسلسل حفظ المصدر ونسخه المتزامنين دون دورة أقفال", async () => {
    const results = await Promise.allSettled([
      saveProductCustomizationTemplate({
        productId: 1,
        expectedTemplateId: 1,
        kind: "GENERAL",
        title: "حفظ متزامن",
        fields: [{ fieldKey: "details", label: "التفاصيل", fieldType: "TEXTAREA", isRequired: true }],
      }, actor),
      copyProductCustomizationTemplate({
        sourceProductId: 1,
        scope: "PRODUCTS",
        productIds: [2],
        overwriteExisting: false,
      }, actor),
    ]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
  });

  it("يعمم القالب على الفئة ويستبدل القالب السابق فقط عند طلب ذلك صراحة", async () => {
    const result = await copyProductCustomizationTemplate({
      sourceProductId: 1,
      scope: "CATEGORY",
      categoryId: 1,
      overwriteExisting: true,
    }, actor);

    expect(result).toEqual({ sourceTemplateId: 1, matched: 2, copied: 2, skipped: 0 });
    const templates = await db().select().from(s.productCustomizationTemplates);
    expect(templates.filter((template) => template.productId !== 1).sort((a, b) => Number(a.productId) - Number(b.productId))).toEqual([
      expect.objectContaining({ productId: 2, title: "تفاصيل الختم" }),
      expect.objectContaining({ productId: 3, title: "تفاصيل الختم" }),
    ]);
    const replaced = templates.find((template) => template.productId === 3)!;
    expect(replaced.id).not.toBe(3);
    const sourceFields = await db().select().from(s.productCustomizationFields).where(eq(s.productCustomizationFields.templateId, 1));
    const replacedFields = await db().select().from(s.productCustomizationFields).where(eq(s.productCustomizationFields.templateId, replaced.id));
    expect(portableFields(replacedFields)).toEqual(portableFields(sourceFields));
    expect(templates.some((template) => template.productId === 4)).toBe(false);
    expect(templates.some((template) => template.productId === 5)).toBe(false);
    expect((await db().select().from(s.products).where(eq(s.products.id, 4)))[0]?.isCustomizable).toBe(false);
    expect((await db().select().from(s.products).where(eq(s.products.id, 5)))[0]).toMatchObject({ isActive: false, isCustomizable: false });
  });
});
