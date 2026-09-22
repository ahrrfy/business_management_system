import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createRecipe,
  deleteRecipe,
  listRecipes,
  listRunnableRecipes,
  setRecipeActive,
  updateRecipe,
} from "../recipeService";
import { truncateTables } from "./__testUtils__";

const actor = { userId: 1, branchId: 1, role: "admin" };

const TABLES = [
  "productionLines",
  "productionOrders",
  "productionRecipeLines",
  "productionRecipes",
  "productUnits",
  "productVariants",
  "products",
  "suppliers",
  "users",
  "branches",
] as const;

function db() {
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set for tests");
  return database;
}

async function resetAndSeed() {
  await truncateTables(TABLES);
  const database = db();
  await database.insert(s.branches).values({
    id: 1,
    name: "الفرع الرئيسي",
    code: "MAIN",
    type: "MAIN",
    isActive: true,
  });
  await database.insert(s.users).values({
    id: 1,
    openId: "recipe-integrity-admin",
    name: "admin",
    role: "admin",
    loginMethod: "local",
  });
  await database.insert(s.suppliers).values({
    id: 1,
    name: "مودع الاختبار",
    supplierKind: "CONSIGNOR",
    isActive: true,
  });
  await database.insert(s.products).values([
    { id: 1, name: "مادة مخزنية" },
    { id: 2, name: "ناتج مخزني" },
    { id: 3, name: "خدمة طباعة", isService: true },
    { id: 4, name: "بكج إرثي", isBundle: true },
    { id: 5, name: "ناتج معطّل", isActive: false },
    { id: 6, name: "ناتج بوحدة معيبة" },
    { id: 7, name: "مادة خدمة", isService: true },
    { id: 8, name: "مادة بكج", isBundle: true },
    {
      id: 9,
      name: "مادة أمانة",
      isConsignment: true,
      consignorId: 1,
    },
    { id: 10, name: "مادة معطّلة", isActive: false },
  ]);
  await database.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "MAT", costPrice: "2.00" },
    { id: 2, productId: 2, sku: "OUT-STOCK", costPrice: "0.00" },
    { id: 3, productId: 3, sku: "OUT-SERVICE", costPrice: "0.00" },
    { id: 4, productId: 4, sku: "OUT-BUNDLE", costPrice: "0.00" },
    { id: 5, productId: 5, sku: "OUT-DISABLED", costPrice: "0.00" },
    { id: 6, productId: 6, sku: "OUT-BAD-UNIT", costPrice: "0.00" },
    { id: 7, productId: 7, sku: "MAT-SERVICE", costPrice: "0.00" },
    { id: 8, productId: 8, sku: "MAT-BUNDLE", costPrice: "0.00" },
    { id: 9, productId: 9, sku: "MAT-CONSIGN", costPrice: "2.00" },
    { id: 10, productId: 10, sku: "MAT-DISABLED", costPrice: "2.00" },
  ]);
  await database.insert(s.productUnits).values([
    {
      id: 1,
      variantId: 1,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
    {
      id: 2,
      variantId: 2,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
    {
      id: 3,
      variantId: 3,
      unitName: "خدمة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
    {
      id: 4,
      variantId: 4,
      unitName: "بكج",
      conversionFactor: "1",
      isBaseUnit: true,
    },
    {
      id: 5,
      variantId: 5,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
    {
      id: 6,
      variantId: 6,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
    {
      id: 7,
      variantId: 7,
      unitName: "خدمة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
    {
      id: 8,
      variantId: 8,
      unitName: "بكج",
      conversionFactor: "1",
      isBaseUnit: true,
    },
    {
      id: 9,
      variantId: 9,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
    {
      id: 10,
      variantId: 10,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
  ]);
}

beforeEach(resetAndSeed);

function recipeInput(
  name: string,
  outputVariantId = 2,
  outputProductUnitId = 2,
  inputVariantId = 1,
) {
  return {
    name,
    outputVariantId,
    outputProductUnitId,
    lines: [{ inputVariantId, qtyPerOutputBase: "1" }],
  };
}

describe("سلامة وصفات الإنتاج", () => {
  it("يصنّف قائمة الإدارة ويفصل قائمة التشغيل المخزني عن الخدمة والبكج والناتج المعيب", async () => {
    await createRecipe(recipeInput("وصفة مخزنية"), actor);
    await createRecipe(recipeInput("وصفة خدمة", 3, 3), actor);

    // صفوف إرثية لا تسمح الخدمة الجديدة بإنشائها، لكنها يجب أن تبقى مرئيةً للإدارة.
    await db()
      .insert(s.productionRecipes)
      .values([
        {
          id: 40,
          name: "وصفة بكج إرثية",
          outputVariantId: 4,
          outputProductUnitId: 4,
          isActive: true,
        },
        {
          id: 50,
          name: "وصفة ناتج معطّل",
          outputVariantId: 5,
          outputProductUnitId: 5,
          isActive: true,
        },
        {
          id: 60,
          name: "وصفة وحدة لا تخص الناتج",
          outputVariantId: 6,
          outputProductUnitId: 2,
          isActive: true,
        },
        {
          id: 70,
          name: "وصفة ناتج أمانة إرثية",
          outputVariantId: 9,
          outputProductUnitId: 9,
          isActive: true,
        },
      ]);
    await db()
      .insert(s.productionRecipeLines)
      .values([
        { recipeId: 40, inputVariantId: 1, qtyPerOutputBase: "1" },
        { recipeId: 50, inputVariantId: 1, qtyPerOutputBase: "1" },
        { recipeId: 60, inputVariantId: 1, qtyPerOutputBase: "1" },
        { recipeId: 70, inputVariantId: 1, qtyPerOutputBase: "1" },
      ]);

    const management = await listRecipes();
    const stock = management.find((row) => row.name === "وصفة مخزنية")!;
    const service = management.find((row) => row.name === "وصفة خدمة")!;
    const bundle = management.find((row) => row.name === "وصفة بكج إرثية")!;
    const consignment = management.find((row) => row.name === "وصفة ناتج أمانة إرثية")!;
    expect(stock.executionKind).toBe("INVENTORY_PRODUCTION");
    expect(stock.canRunProduction).toBe(true);
    expect(service.executionKind).toBe("SERVICE_CONSUMPTION");
    expect(service.outputIsService).toBe(true);
    expect(service.canRunProduction).toBe(false);
    expect(bundle.executionKind).toBe("UNSUPPORTED");
    expect(bundle.outputIsBundle).toBe(true);
    expect(bundle.canRunProduction).toBe(false);
    expect(consignment.executionKind).toBe("UNSUPPORTED");
    expect(consignment.outputIsConsignment).toBe(true);
    expect(consignment.canRunProduction).toBe(false);

    const runnable = await listRunnableRecipes();
    expect(runnable.map((row) => row.name)).toEqual(["وصفة مخزنية"]);
  });

  it("ينشئ النسخة الخاملة اختيارياً ويرفض تفعيلها ما دامت وصفة الناتج الحالية فعالة", async () => {
    const current = await createRecipe(recipeInput("الحالية"), actor);
    const draft = await createRecipe(
      { ...recipeInput("نسخة خاملة"), isActive: false },
      actor,
    );
    expect(draft.isActive).toBe(false);
    await expect(setRecipeActive(draft.recipeId, true)).rejects.toThrow(
      /وصفة فعّالة أخرى/,
    );

    await setRecipeActive(current.recipeId, false);
    await setRecipeActive(draft.recipeId, true);
    const rows = await db()
      .select({
        id: s.productionRecipes.id,
        active: s.productionRecipes.isActive,
      })
      .from(s.productionRecipes)
      .where(eq(s.productionRecipes.outputVariantId, 2));
    expect(
      rows.filter((row) => row.active === true).map((row) => Number(row.id)),
    ).toEqual([draft.recipeId]);
  });

  it("يسلسل إنشاءين متزامنين على outputVariant ولا يسمح إلا برأس فعّال واحد", async () => {
    const results = await Promise.allSettled([
      createRecipe(recipeInput("سباق أ"), actor),
      createRecipe(recipeInput("سباق ب"), actor),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const active = await db()
      .select({ id: s.productionRecipes.id })
      .from(s.productionRecipes)
      .where(
        sql`${s.productionRecipes.outputVariantId} = 2 AND ${s.productionRecipes.isActive} = TRUE`,
      );
    expect(active).toHaveLength(1);
  });

  it("يرفض مكوّن الخدمة والبكج والأمانة والمعطّل ولا يترك رأس وصفة", async () => {
    for (const [name, inputVariantId] of [
      ["خدمة", 7],
      ["بكج", 8],
      ["أمانة", 9],
      ["معطّل", 10],
    ] as const) {
      await expect(
        createRecipe(
          {
            ...recipeInput(`مادة ${name}`),
            isActive: false,
            lines: [{ inputVariantId, qtyPerOutputBase: "1" }],
          },
          actor,
        ),
      ).rejects.toThrow();
    }
    await expect(
      createRecipe(
        { ...recipeInput("ناتج أمانة", 9, 9), isActive: false },
        actor,
      ),
    ).rejects.toThrow(/أمانة/);
    expect(await db().select().from(s.productionRecipes)).toHaveLength(0);
  });

  it("يرفض تكرار المادة والدقة التي تتجاوز أربع منازل بلا تقريب صامت", async () => {
    await expect(
      createRecipe(
        {
          ...recipeInput("مادة مكررة"),
          lines: [
            { inputVariantId: 1, qtyPerOutputBase: "1" },
            { inputVariantId: 1, qtyPerOutputBase: "2" },
          ],
        },
        actor,
      ),
    ).rejects.toThrow(/مكرر/);
    await expect(
      createRecipe(
        {
          ...recipeInput("دقة زائدة"),
          lines: [{ inputVariantId: 1, qtyPerOutputBase: "0.00001" }],
        },
        actor,
      ),
    ).rejects.toThrow(/أربع منازل/);
    expect(await db().select().from(s.productionRecipes)).toHaveLength(0);
  });

  it("يرفض تغيير هوية الناتج ويحافظ على الرأس والأسطر عند فشل التحديث", async () => {
    const created = await createRecipe(recipeInput("قبل التحديث"), actor);
    await expect(
      updateRecipe(created.recipeId, recipeInput("بعد التحديث", 6, 6)),
    ).rejects.toThrow(/هوية الوصفة/);
    const [head] = await db()
      .select()
      .from(s.productionRecipes)
      .where(eq(s.productionRecipes.id, created.recipeId));
    const lines = await db()
      .select()
      .from(s.productionRecipeLines)
      .where(eq(s.productionRecipeLines.recipeId, created.recipeId));
    expect(head.name).toBe("قبل التحديث");
    expect(Number(head.outputVariantId)).toBe(2);
    expect(lines).toHaveLength(1);
  });

  it("الحذف يرفض الفعّال والمستخدم ووصفة الخدمة، ويسمح بمسودة مخزنية غير مستخدمة", async () => {
    const active = await createRecipe(recipeInput("فعّالة"), actor);
    await expect(deleteRecipe(active.recipeId)).rejects.toThrow(/فعّالة/);
    await setRecipeActive(active.recipeId, false);
    await db().insert(s.productionOrders).values({
      docNumber: "PROD-RECIPE-1",
      branchId: 1,
      linkedRecipeId: active.recipeId,
      createdBy: 1,
    });
    await expect(deleteRecipe(active.recipeId)).rejects.toThrow(/مستند إنتاج/);

    const serviceDraft = await createRecipe(
      { ...recipeInput("مسودة خدمة", 3, 3), isActive: false },
      actor,
    );
    await expect(deleteRecipe(serviceDraft.recipeId)).rejects.toThrow(
      /وصفة الخدمة/,
    );

    const disposable = await createRecipe(
      { ...recipeInput("مسودة قابلة للحذف"), isActive: false },
      actor,
    );
    await deleteRecipe(disposable.recipeId);
    expect(
      await db()
        .select()
        .from(s.productionRecipes)
        .where(eq(s.productionRecipes.id, disposable.recipeId)),
    ).toHaveLength(0);
  });

  it("0359 تنشئ activeSlot مولّداً وفهرساً فريداً يسمح بخاملين ويرفض فعّالين", async () => {
    const columnResult = await db().execute(sql`
      SELECT
        DATA_TYPE AS dataType,
        COLUMN_TYPE AS columnType,
        IS_NULLABLE AS isNullable,
        EXTRA AS extra,
        COALESCE(GENERATION_EXPRESSION, '') AS expression
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'productionRecipes'
        AND COLUMN_NAME = 'activeSlot'
    `);
    const columns = Array.isArray(columnResult)
      ? (columnResult[0] as unknown as Array<{
          dataType: string;
          columnType: string;
          isNullable: string;
          extra: string;
          expression: string;
        }>)
      : [];
    expect(columns).toHaveLength(1);
    expect(columns[0]).toMatchObject({
      dataType: "tinyint",
      isNullable: "YES",
      extra: expect.stringContaining("VIRTUAL GENERATED"),
    });
    expect(columns[0].columnType.toLowerCase()).not.toContain("unsigned");
    expect(
      columns[0].expression.toLowerCase().replace(/[`()\s]/g, ""),
    ).toBe("casewhenisactive=1then1elsenullend");

    const indexResult = await db().execute(sql`
      SELECT
        INDEX_NAME AS indexName,
        COLUMN_NAME AS columnName,
        SEQ_IN_INDEX AS seqInIndex,
        NON_UNIQUE AS nonUnique,
        SUB_PART AS subPart,
        EXPRESSION AS indexExpression,
        INDEX_TYPE AS indexType,
        IS_VISIBLE AS isVisible,
        COLLATION AS collation
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'productionRecipes'
        AND INDEX_NAME = 'uq_recipe_active_output'
      ORDER BY SEQ_IN_INDEX
    `);
    const indexes = Array.isArray(indexResult)
      ? (indexResult[0] as unknown as Array<{
          indexName: string;
          columnName: string;
          seqInIndex: number;
          nonUnique: number;
          subPart: number | null;
          indexExpression: string | null;
          indexType: string;
          isVisible: string;
          collation: string;
        }>)
      : [];
    expect(
      indexes.map((row) => ({
        ...row,
        seqInIndex: Number(row.seqInIndex),
        nonUnique: Number(row.nonUnique),
      })),
    ).toEqual([
      {
        indexName: "uq_recipe_active_output",
        columnName: "outputVariantId",
        seqInIndex: 1,
        nonUnique: 0,
        subPart: null,
        indexExpression: null,
        indexType: "BTREE",
        isVisible: "YES",
        collation: "A",
      },
      {
        indexName: "uq_recipe_active_output",
        columnName: "activeSlot",
        seqInIndex: 2,
        nonUnique: 0,
        subPart: null,
        indexExpression: null,
        indexType: "BTREE",
        isVisible: "YES",
        collation: "A",
      },
    ]);

    const transitionTriggerResult = await db().execute(sql`
      SELECT TRIGGER_NAME AS triggerName
      FROM INFORMATION_SCHEMA.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE()
        AND EVENT_OBJECT_TABLE = 'productionRecipes'
        AND TRIGGER_NAME IN (
          'trg_0359_recipe_active_pre_bi',
          'trg_0359_recipe_active_pre_bu',
          'trg_0359_recipe_active_bi',
          'trg_0359_recipe_active_bu'
        )
    `);
    const transitionTriggers = Array.isArray(transitionTriggerResult)
      ? (transitionTriggerResult[0] as unknown as Array<{
          triggerName: string;
        }>)
      : [];
    expect(transitionTriggers).toEqual([]);

    await db().insert(s.productionRecipes).values({
      name: "DB فعالة أ",
      outputVariantId: 2,
      outputProductUnitId: 2,
      isActive: true,
    });
    await expect(
      db().insert(s.productionRecipes).values({
        name: "DB فعالة ب",
        outputVariantId: 2,
        outputProductUnitId: 2,
        isActive: true,
      }),
    ).rejects.toThrow();
    await db()
      .insert(s.productionRecipes)
      .values([
        {
          name: "DB خاملة أ",
          outputVariantId: 2,
          outputProductUnitId: 2,
          isActive: false,
        },
        {
          name: "DB خاملة ب",
          outputVariantId: 2,
          outputProductUnitId: 2,
          isActive: false,
        },
      ]);
  });
});
