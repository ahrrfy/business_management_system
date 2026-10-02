import { readFileSync } from "node:fs";
import { asc, eq, inArray } from "drizzle-orm";
import mysql from "mysql2/promise";
import { beforeEach, describe, expect, it } from "vitest";

import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateAllTables } from "./__testUtils__";

const migration = readFileSync(
  new URL("../../../drizzle/migrations/0378_storefront_customization_defaults.sql", import.meta.url),
  "utf8",
);

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

type SeedField = Omit<typeof s.productCustomizationFields.$inferInsert, "id" | "templateId">;

const pristineFields: SeedField[] = [
  {
    fieldKey: "packaging",
    label: "التغليف",
    fieldType: "SELECT" as const,
    isRequired: false,
    sortOrder: 20,
    maxLength: null,
    optionsJson: [
      { value: "standard", label: "تغليف عادي", priceDelta: "0" },
      { value: "gift", label: "تغليف هدية", priceDelta: "0" },
    ],
    dependencyJson: null,
    priceDelta: "0",
    isActive: true,
  },
  {
    fieldKey: "recipient",
    label: "اسم المستلم",
    fieldType: "TEXT" as const,
    isRequired: false,
    sortOrder: 25,
    maxLength: 120,
    optionsJson: null,
    dependencyJson: null,
    priceDelta: "0",
    isActive: true,
  },
  {
    fieldKey: "message",
    label: "رسالة الإهداء",
    fieldType: "TEXTAREA" as const,
    isRequired: false,
    sortOrder: 30,
    maxLength: 300,
    optionsJson: null,
    dependencyJson: null,
    priceDelta: "0",
    isActive: true,
  },
];

beforeEach(async () => {
  await truncateAllTables();
});

describe("ترحيل قالب الأختام الافتراضي", () => {
  it("يحوّل البصمة البِكر بهوية جديدة ويحفظ كل قالب عدّله المدير حرفياً", async () => {
    await db().insert(s.categories).values({ id: 100, name: "الاختام التجارية والشخصية والشركات" });

    const variants: Array<{
      id: number;
      name: string;
      templateActive?: boolean;
      mutate?: (fields: SeedField[]) => void;
    }> = [
      { id: 100, name: "بكر" },
      { id: 101, name: "خيارات معدلة", mutate: (fields) => { fields[0]!.optionsJson![0]!.label = "تغليف خاص"; } },
      { id: 102, name: "الإلزام معدل", mutate: (fields) => { fields[1]!.isRequired = true; } },
      { id: 103, name: "الحد معدل", mutate: (fields) => { fields[1]!.maxLength = 121; } },
      { id: 104, name: "التبعية معدلة", mutate: (fields) => { fields[2]!.dependencyJson = { fieldKey: "packaging", operator: "equals", value: "gift" }; } },
      { id: 105, name: "السعر معدل", mutate: (fields) => { fields[0]!.priceDelta = "1"; } },
      { id: 106, name: "القالب موقف", templateActive: false },
      { id: 107, name: "الحقل موقف", mutate: (fields) => { fields[2]!.isActive = false; } },
    ];

    await db().insert(s.products).values(variants.map((variant) => ({
      id: variant.id,
      name: variant.name,
      categoryId: 100,
      isCustomizable: true,
    })));
    await db().insert(s.productCustomizationTemplates).values(variants.map((variant) => ({
      id: variant.id,
      productId: variant.id,
      kind: "GIFT" as const,
      title: "أضف لمسة الهدية",
      description: "خيارات الهدية تُجهّز مع المنتج قبل الإرسال.",
      isActive: variant.templateActive ?? true,
    })));

    let fieldId = 1_000;
    for (const variant of variants) {
      const fields = structuredClone(pristineFields);
      variant.mutate?.(fields);
      await db().insert(s.productCustomizationFields).values(fields.map((field) => ({
        id: fieldId++,
        templateId: variant.id,
        ...field,
      })));
    }

    const modifiedIds = variants.slice(1).map((variant) => variant.id);
    const templatesBefore = await db().select().from(s.productCustomizationTemplates)
      .where(inArray(s.productCustomizationTemplates.id, modifiedIds))
      .orderBy(asc(s.productCustomizationTemplates.id));
    const fieldsBefore = await db().select().from(s.productCustomizationFields)
      .where(inArray(s.productCustomizationFields.templateId, modifiedIds))
      .orderBy(asc(s.productCustomizationFields.id));

    const connection = await mysql.createConnection(process.env.DATABASE_URL!);
    try {
      for (const statement of migration.split(/-->\s*statement-breakpoint/g).map((part) => part.trim()).filter(Boolean)) {
        await connection.query(statement);
      }
    } finally {
      await connection.end();
    }

    const migratedTemplate = (await db().select().from(s.productCustomizationTemplates)
      .where(eq(s.productCustomizationTemplates.productId, 100)))[0];
    expect(migratedTemplate).toMatchObject({
      productId: 100,
      kind: "GENERAL",
      title: "تفاصيل تخصيص الختم",
      isActive: true,
    });
    expect(migratedTemplate.id).not.toBe(100);
    expect(await db().select().from(s.productCustomizationFields)
      .where(eq(s.productCustomizationFields.templateId, migratedTemplate.id))).toEqual([
      expect.objectContaining({
        fieldKey: "details",
        label: "تفاصيل الختم المطلوبة",
        fieldType: "TEXTAREA",
        isRequired: true,
        sortOrder: 10,
        maxLength: 2000,
        dependencyJson: null,
        priceDelta: "0.00",
        isActive: true,
      }),
    ]);

    expect(await db().select().from(s.productCustomizationTemplates)
      .where(inArray(s.productCustomizationTemplates.id, modifiedIds))
      .orderBy(asc(s.productCustomizationTemplates.id))).toEqual(templatesBefore);
    expect(await db().select().from(s.productCustomizationFields)
      .where(inArray(s.productCustomizationFields.templateId, modifiedIds))
      .orderBy(asc(s.productCustomizationFields.id))).toEqual(fieldsBefore);
  });
});
