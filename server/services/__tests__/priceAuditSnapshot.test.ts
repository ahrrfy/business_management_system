import { and, desc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

/**
 * المسار د-١ (١٧/٨): لقطة تدقيق تعديل المنتج كانت `{id, sku, isActive}` فقط ⇒ تعديل سعرٍ أو
 * تكلفةٍ لا يترك أثراً رقمياً («مَن ومتى» بلا «مِن كم إلى كم»)، فلا مراجعةَ تسعيرٍ بأثرٍ رجعيّ
 * ولا ردَّ اعتراضٍ على سعر.
 *
 * ويحرس الاختبار الثاني الحدَّ الآخر: **لا آلية إعادة تقييمٍ جديدة** — `postCostRevaluation`
 * قائمةٌ وتُرحّل قيد ADJUST واحداً؛ طبقةٌ ثانية كانت ستُنتج قيوداً مزدوجة.
 */

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES = [
  "auditLogs", "accountingEntries", "productPrices", "productUnits", "branchStock",
  "productImages", "productVariants", "products", "categories", "users", "branches",
];

function ctx(): TrpcContext {
  return {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: { id: 1, role: "admin", branchId: 1, name: "t", email: "t@t", isActive: true } as unknown as TrpcContext["user"],
  };
}
const caller = () => appRouter.createCaller(ctx());

const PRODUCT_ID = 1;
const VARIANT_ID = 1;

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.categories).values({ id: 1, name: "قرطاسية" });
  await d.insert(s.products).values({ id: PRODUCT_ID, name: "قلم", categoryId: 1 });
  await d.insert(s.productVariants).values({
    id: VARIANT_ID, productId: PRODUCT_ID, sku: "PEN-1", color: "أزرق", costPrice: "500.00",
  });
  await d.insert(s.productUnits).values({
    id: 1, variantId: VARIANT_ID, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true,
  });
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "700.00" },
    { productUnitId: 1, priceTier: "WHOLESALE", price: "650.00" },
    { productUnitId: 1, priceTier: "GOVERNMENT", price: "680.00" },
  ]);
});

function editInput(overrides: { costPrice?: string; retail?: string }) {
  return {
    productId: PRODUCT_ID,
    name: "قلم",
    categoryId: 1,
    unitTemplate: [
      {
        unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true,
        prices: [
          { priceTier: "RETAIL" as const, price: overrides.retail ?? "700.00" },
          { priceTier: "WHOLESALE" as const, price: "650.00" },
          { priceTier: "GOVERNMENT" as const, price: "680.00" },
        ],
      },
    ],
    variants: [
      {
        id: VARIANT_ID, sku: "PEN-1", color: "أزرق", size: null,
        costPrice: overrides.costPrice ?? "500.00",
        baseRetail: overrides.retail ?? "700.00",
        isActive: true,
        unitBarcodes: {},
      },
    ],
  } as Parameters<ReturnType<typeof caller>["catalog"]["updateProductVariants"]>[0];
}

async function lastProductAudit() {
  const rows = await db()
    .select({ oldValue: s.auditLogs.oldValue, newValue: s.auditLogs.newValue })
    .from(s.auditLogs)
    .where(and(eq(s.auditLogs.action, "product.update"), eq(s.auditLogs.entityId, PRODUCT_ID)))
    .orderBy(desc(s.auditLogs.id))
    .limit(1);
  const row = rows[0];
  const parse = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
  return { oldValue: parse(row?.oldValue), newValue: parse(row?.newValue) };
}

describe("د-١ — لقطة تدقيق تعديل الأسعار", () => {
  it("تعديل سعر البيع يترك سطر تدقيقٍ يحوي الرقمين (قبل وبعد)", async () => {
    await caller().catalog.updateProductVariants(editInput({ retail: "900.00" }));
    const { oldValue, newValue } = await lastProductAudit();

    expect(oldValue.variants[0].baseRetail).toBe("700.00");
    expect(newValue.variants[0].baseRetail).toBe("900.00");
    expect(oldValue.unitPrices[0]).toMatchObject({ unitName: "قطعة", retail: "700.00" });
    expect(newValue.unitPrices[0]).toMatchObject({ unitName: "قطعة", retail: "900.00" });
  });

  it("تعديل التكلفة يُسجَّل رقمياً أيضاً (كان يغيب عن اللقطة كلياً)", async () => {
    await caller().catalog.updateProductVariants(editInput({ costPrice: "600.00" }));
    const { oldValue, newValue } = await lastProductAudit();
    expect(oldValue.variants[0].costPrice).toBe("500.00");
    expect(newValue.variants[0].costPrice).toBe("600.00");
  });

  it("لا قيود ADJUST مزدوجة: التوسعة تدقيقٌ بحت لا آلية إعادة تقييمٍ ثانية", async () => {
    const adjustCount = async () =>
      Number(
        (
          await db()
            .select({ n: sql<number>`COUNT(*)` })
            .from(s.accountingEntries)
            .where(eq(s.accountingEntries.entryType, "ADJUST"))
        )[0]?.n ?? 0,
      );
    const before = await adjustCount();
    await caller().catalog.updateProductVariants(editInput({ costPrice: "600.00" }));
    const after = await adjustCount();
    // بلا مخزونٍ قائم لا يُرحَّل قيد إعادة تقييم أصلاً؛ المهمّ ألّا تُنتج التوسعة قيداً إضافياً.
    expect(after).toBe(before);
  });
});
