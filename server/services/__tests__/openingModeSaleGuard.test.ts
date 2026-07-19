// «وضع الافتتاح» (ش٢ ١٩/٧) — حارس البيع بالسالب المشروط في createSale/applyMovement:
// نقدي كامل من قناة POS + صنف غير مُفتتَح + تكلفة مُدخلة + ضمن سقف الكمية ⇒ يمرّ بالسالب؛
// وكل ما عداه (آجل/جزئي/غير نقدي/ORDER/مُفتتَح/بلا تكلفة/فوق السقف/نافذة منقضية) صارم كما كان،
// مع رسائل رفض مُثراة وقناة الأوفلاين (allowNegativeStock) مستقلة لا تتراكب.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { createSale } from "../saleService";
import { applyMovement } from "../inventoryService";

const actor = { userId: 1, branchId: 1, role: "admin" };
const DAY_MS = 86_400_000;

const TABLES = [
  "accountingEntries",
  "receipts",
  "invoiceItemBundleComponents",
  "invoiceItems",
  "invoices",
  "inventoryMovements",
  "branchStock",
  "openingModeSettings",
  "bundleComponents",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "customers",
  "shifts",
  "auditLogs",
  "users",
  "branches",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}
async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الفرع", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values([
    { id: 1, name: "قلم" },
    { id: 2, name: "صنف بلا تكلفة" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" },
    { id: 2, productId: 2, sku: "NOCST-1", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "10.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "5.00" },
  ]);
  await d.insert(s.shifts).values({
    id: 1, userId: 1, branchId: 1, status: "OPEN",
    openedAt: new Date(), openGuard: "1:1", openingBalance: "0",
  });
}
beforeEach(async () => {
  await reset();
  await seedBase();
});

async function enableOpeningMode(over: Partial<typeof s.openingModeSettings.$inferInsert> = {}) {
  await db()
    .insert(s.openingModeSettings)
    .values({ id: 1, enabled: true, endsAt: new Date(Date.now() + 7 * DAY_MS), maxNegativeQtyPerLine: 100, ...over });
}

function cashSale(qty: string, amount: string, over: Record<string, unknown> = {}) {
  return createSale(
    {
      branchId: 1,
      shiftId: 1,
      priceTier: "RETAIL",
      sourceType: "POS",
      lines: [{ variantId: 1, productUnitId: 1, quantity: qty }],
      payment: { amount, method: "CASH" },
      ...over,
    } as Parameters<typeof createSale>[0],
    actor,
  );
}

async function stockOf(variantId: number, branchId = 1): Promise<number> {
  const [r] = await db()
    .select({ q: s.branchStock.quantity })
    .from(s.branchStock)
    .where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, branchId)));
  return Number(r?.q ?? 0);
}

async function expectConflict(p: Promise<unknown>, msgRe: RegExp) {
  let err: unknown = null;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(TRPCError);
  expect((err as TRPCError).code).toBe("CONFLICT");
  expect((err as TRPCError).message).toMatch(msgRe);
}

describe("حارس البيع بالسالب المشروط — وضع الافتتاح", () => {
  it("خط الأساس: الوضع مطفأ ⇒ بيع نقدي كامل يتجاوز الرصيد يُرفض بالرسالة التاريخية بلا إثراء", async () => {
    let err: TRPCError | null = null;
    try {
      await cashSale("2", "20.00"); // لا رصيد إطلاقاً
    } catch (e) {
      err = e as TRPCError;
    }
    expect(err?.code).toBe("CONFLICT");
    expect(err?.message).toMatch(/المخزون غير كافٍ/);
    expect(err?.message).not.toMatch(/وضع الافتتاح/);
    expect((await db().select().from(s.invoices)).length).toBe(0); // ذرّية كاملة
  });

  it("المسار الذهبي: نقدي كامل + غير مُفتتَح ⇒ يمرّ بالسالب مع حركة موسومة وnegativeDips وقيد SALE سليم", async () => {
    await enableOpeningMode();
    const res = await cashSale("3", "30.00"); // رصيد 0 ⇒ -3
    expect(res.status).toBe("PAID");
    expect(res.negativeDips).toEqual([{ variantId: 1, newQuantity: -3 }]);
    expect(await stockOf(1)).toBe(-3);

    const [mv] = await db()
      .select()
      .from(s.inventoryMovements)
      .where(and(eq(s.inventoryMovements.movementType, "OUT"), eq(s.inventoryMovements.referenceType, "INVOICE")));
    expect(String(mv.notes ?? "")).toContain("وضع الافتتاح");

    // قيد SALE سليم بتكلفة حقيقية (COGS من costPrice لا من الرصيد).
    const [entry] = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "SALE"));
    expect(entry.revenue).toBe("30.00");
    expect(entry.cost).toBe("12.00"); // 3 × 4.00
    expect(entry.profit).toBe("18.00");
  });

  it("البيع الآجل (بلا دفعة) يُرفض برسالة مُثراة تشرح شرط النقدي الكامل", async () => {
    await enableOpeningMode();
    await db().insert(s.customers).values({ id: 1, name: "تاجر", defaultPriceTier: "RETAIL", currentBalance: "0", creditLimit: null });
    await expectConflict(
      createSale(
        { branchId: 1, customerId: 1, sourceType: "POS", shiftId: 1, priceTier: "RETAIL", lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }] },
        actor,
      ),
      /نقدياً مدفوعاً بالكامل/,
    );
    expect(await stockOf(1)).toBe(0);
  });

  it("الدفعة الجزئية (عربون نقدي) تُرفض — unpaid > 0", async () => {
    await enableOpeningMode();
    await db().insert(s.customers).values({ id: 1, name: "تاجر", defaultPriceTier: "RETAIL", currentBalance: "0", creditLimit: null });
    await expectConflict(
      createSale(
        { branchId: 1, customerId: 1, sourceType: "POS", shiftId: 1, priceTier: "RETAIL", lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], payment: { amount: "5.00", method: "CASH" } },
        actor,
      ),
      /نقدياً مدفوعاً بالكامل/,
    );
  });

  it("الدفع غير النقدي (CARD كاملاً) يُرفض — الشرط CASH حصراً", async () => {
    await enableOpeningMode();
    await expectConflict(
      createSale(
        { branchId: 1, shiftId: 1, priceTier: "RETAIL", sourceType: "POS", lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], payment: { amount: "20.00", method: "CARD" } },
        actor,
      ),
      /نقدياً مدفوعاً بالكامل/,
    );
  });

  it("قناة ORDER (تحويل عرض سعر) لا تستفيد من الوضع", async () => {
    await enableOpeningMode();
    await db().insert(s.customers).values({ id: 1, name: "تاجر", defaultPriceTier: "RETAIL", currentBalance: "0", creditLimit: null });
    await expectConflict(
      createSale(
        { branchId: 1, customerId: 1, sourceType: "ORDER", shiftId: 1, priceTier: "RETAIL", lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], payment: { amount: "20.00", method: "CASH" } },
        actor,
      ),
      /نقدياً مدفوعاً بالكامل/,
    );
  });

  it("الصنف المُفتتَح يُرفض بالسالب حتى نقداً — رسالته تشرح أنه مجرود", async () => {
    await enableOpeningMode();
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 1, openedAt: new Date() });
    await expectConflict(cashSale("3", "30.00"), /مُفتتَح \(مجرود\)/);
    expect(await stockOf(1)).toBe(1);
  });

  it("صنف بلا تكلفة يُرفض بالسالب برسالة «أدخِل تكلفته»", async () => {
    await enableOpeningMode();
    await expectConflict(
      createSale(
        { branchId: 1, shiftId: 1, priceTier: "RETAIL", sourceType: "POS", lines: [{ variantId: 2, productUnitId: 2, quantity: "2" }], payment: { amount: "10.00", method: "CASH" } },
        actor,
      ),
      /تكلفة مُدخلة/,
    );
  });

  it("تجاوز سقف كمية السطر السالب يُرفض برسالة السقف", async () => {
    await enableOpeningMode({ maxNegativeQtyPerLine: 5 });
    await expectConflict(cashSale("6", "60.00"), /سقف السطر السالب/);
    // وضمن السقف يمرّ.
    const ok = await cashSale("5", "50.00");
    expect(ok.negativeDips?.[0]?.newQuantity).toBe(-5);
  });

  it("انقضاء النافذة يعيد الصرامة الكاملة (رسالة تاريخية بلا إثراء)", async () => {
    await enableOpeningMode({ endsAt: new Date(Date.now() - DAY_MS) });
    let err: TRPCError | null = null;
    try {
      await cashSale("2", "20.00");
    } catch (e) {
      err = e as TRPCError;
    }
    expect(err?.code).toBe("CONFLICT");
    expect(err?.message).not.toMatch(/وضع الافتتاح|مُفتتَح/);
  });

  it("idempotency: تكرار clientRequestId لا يكرّر الخصم السالب — وreplay لا يعيد negativeDips (استشارية)", async () => {
    await enableOpeningMode();
    const reqId = randomUUID();
    const r1 = await cashSale("2", "20.00", { clientRequestId: reqId });
    expect(r1.negativeDips?.length).toBe(1);
    const r2 = await cashSale("2", "20.00", { clientRequestId: reqId });
    expect(r2.idempotentReplay).toBe(true);
    expect(r2.negativeDips).toBeUndefined();
    expect(await stockOf(1)).toBe(-2); // خصم واحد فقط
    expect((await db().select().from(s.invoices)).length).toBe(1);
  });

  it("قناة الأوفلاين مستقلة: allowNegative يعمل حتى على صنف مُفتتَح (سالب موسوم originatedOffline) والوضع مطفأ", async () => {
    // بلا تفعيل وضع الافتتاح إطلاقاً — قناة replay الأوفلايني لها قرارها الخاص.
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 0, openedAt: new Date() });
    const moved = await withTx((tx) =>
      applyMovement(tx, {
        variantId: 1,
        branchId: 1,
        baseQuantity: 4,
        movementType: "OUT",
        referenceType: "INVOICE",
        allowNegative: true,
      }),
    );
    expect(moved.newQuantity).toBe(-4);
  });

  it("allowNegativeUnopened وحدها لا تسمح لصنف مُفتتَح (تُفحص تحت القفل)", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 0, openedAt: new Date() });
    let err: unknown = null;
    try {
      await withTx((tx) =>
        applyMovement(tx, {
          variantId: 1,
          branchId: 1,
          baseQuantity: 1,
          movementType: "OUT",
          referenceType: "INVOICE",
          allowNegativeUnopened: true,
        }),
      );
    } catch (e) {
      err = e;
    }
    expect((err as TRPCError)?.code).toBe("CONFLICT");
    // وغير المُفتتَح يمرّ.
    const moved = await withTx((tx) =>
      applyMovement(tx, {
        variantId: 2,
        branchId: 1,
        baseQuantity: 1,
        movementType: "OUT",
        referenceType: "INVOICE",
        allowNegativeUnopened: true,
      }),
    );
    expect(moved.newQuantity).toBe(-1);
  });

  it("TRANSFER_OUT لا يتأثر بوضع الافتتاح إطلاقاً", async () => {
    await enableOpeningMode();
    let err: unknown = null;
    try {
      await withTx((tx) =>
        applyMovement(tx, { variantId: 1, branchId: 1, baseQuantity: 1, movementType: "TRANSFER_OUT", relatedBranchId: 1 }),
      );
    } catch (e) {
      err = e;
    }
    expect((err as TRPCError)?.code).toBe("CONFLICT");
  });
});
