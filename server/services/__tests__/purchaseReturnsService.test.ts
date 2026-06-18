import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { purchaseReturnsRouter } from "../../routers/purchaseReturns";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";
import { createPurchaseReturn } from "../purchaseReturnsService";
import { truncateTables } from "./__testUtils__";

const actor = { userId: 1, branchId: 1 };

const TABLES = [
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "branchStock",
  "purchaseOrderItems",
  "purchaseOrders",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "auditLogs",
  "suppliers",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await truncateTables(TABLES);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "0.00" });
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 1, unitName: "درزن", conversionFactor: "12", isBaseUnit: false },
  ]);
  await d.insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0" });
}

async function stockOf(variantId: number, branchId: number): Promise<number> {
  const rows = await db()
    .select({ q: s.branchStock.quantity })
    .from(s.branchStock)
    .where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, branchId)));
  return rows[0]?.q ?? 0;
}

async function receivePurchaseOf100() {
  const po = await createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      taxRatePercent: "0",
      status: "CONFIRMED",
      items: [{ variantId: 1, productUnitId: 1, quantity: "100", unitPrice: "5.00" }],
    },
    actor
  );
  const poItem = (
    await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId))
  )[0];
  await receivePurchase(
    {
      purchaseOrderId: po.purchaseOrderId,
      lines: [{ purchaseOrderItemId: Number(poItem.id), receivedBaseQuantity: 100 }],
    },
    actor
  );
  return po.purchaseOrderId;
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("مرتجع المشتريات", () => {
  it("إرجاع جزئي (CREDIT): المخزون ينقص + قيد RETURN سالب + AP تنخفض، بلا receipt", async () => {
    await receivePurchaseOf100();
    expect(await stockOf(1, 1)).toBe(100);
    const supBefore = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(supBefore.currentBalance).toBe("500.00");

    const res = await createPurchaseReturn(
      {
        supplierId: 1,
        branchId: 1,
        items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "5.00" }],
        settlement: "CREDIT",
      },
      actor
    );
    expect(res.returnedTotal).toBe("50.00");

    // المخزون
    expect(await stockOf(1, 1)).toBe(90);
    const mvs = await db().select().from(s.inventoryMovements);
    const outMv = mvs.find((m) => m.movementType === "OUT");
    expect(outMv).toBeTruthy();
    expect(outMv!.quantity).toBe(10);
    expect(outMv!.referenceType).toBe("PURCHASE_RETURN");

    // قيد RETURN سالب
    const ret = (
      await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "RETURN"))
    )[0];
    expect(ret.supplierId).toBe(1);
    expect(ret.amount).toBe("-50.00");
    expect(ret.cost).toBe("-50.00");

    // AP تنخفض
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe("450.00");

    // لا receipt في حالة CREDIT
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("إرجاع نقدي (CASH): receipt IN + قيد PAYMENT_IN + الذمم تظل ثابتة صافياً (الصندوق ارتفع بدلها)", async () => {
    await receivePurchaseOf100();
    const supBefore = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(supBefore.currentBalance).toBe("500.00");

    await createPurchaseReturn(
      {
        supplierId: 1,
        branchId: 1,
        items: [{ variantId: 1, productUnitId: 1, quantity: "20", unitPrice: "5.00" }],
        settlement: "CASH",
        paymentMethod: "CASH",
      },
      actor
    );

    // receipt IN بالقيمة الكاملة (المورد ردّ النقد)
    const rcs = await db().select().from(s.receipts);
    expect(rcs).toHaveLength(1);
    expect(rcs[0].direction).toBe("IN");
    expect(rcs[0].amount).toBe("100.00");

    // قيدا RETURN و PAYMENT_IN موجودان
    const ret = (await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "RETURN")))[0];
    expect(ret.amount).toBe("-100.00");
    const pin = (await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_IN")))[0];
    expect(pin.amount).toBe("100.00");

    // صافي AP: 500 − 100 (مرتجع) + 100 (نقد عاد ⇒ يُلغي خصم الذمم) = 500
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe("500.00");
  });

  it("ذرّية: مخزون غير كافٍ ⇒ ROLLBACK كامل (لا حركة ولا قيد ولا تغيير ذمم)", async () => {
    await receivePurchaseOf100();
    expect(await stockOf(1, 1)).toBe(100);
    const supBefore = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];

    await expect(
      createPurchaseReturn(
        {
          supplierId: 1,
          branchId: 1,
          items: [{ variantId: 1, productUnitId: 1, quantity: "999", unitPrice: "5.00" }],
        },
        actor
      )
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // كل شيء ثابت
    expect(await stockOf(1, 1)).toBe(100);
    const rets = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "RETURN"));
    expect(rets).toHaveLength(0);
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe(supBefore.currentBalance);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("idempotency: نفس clientRequestId مرّتين ⇒ القيد واحد فقط ومُعلَّم idempotent", async () => {
    await receivePurchaseOf100();
    const first = await createPurchaseReturn(
      {
        clientRequestId: "req-abc-123",
        supplierId: 1,
        branchId: 1,
        items: [{ variantId: 1, productUnitId: 1, quantity: "7", unitPrice: "5.00" }],
      },
      actor
    );
    expect(first.idempotent).toBe(false);

    const second = await createPurchaseReturn(
      {
        clientRequestId: "req-abc-123",
        supplierId: 1,
        branchId: 1,
        items: [{ variantId: 1, productUnitId: 1, quantity: "7", unitPrice: "5.00" }],
      },
      actor
    );
    expect(second.idempotent).toBe(true);
    expect(second.returnedTotal).toBe(first.returnedTotal);

    // قيد واحد فقط، وحركة OUT واحدة فقط
    const rets = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "RETURN"));
    expect(rets).toHaveLength(1);
    const outMvs = (await db().select().from(s.inventoryMovements)).filter((m) => m.movementType === "OUT");
    expect(outMvs).toHaveLength(1);
    // الذمم: انخفضت مرة واحدة فقط (500 - 35 = 465)
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe("465.00");
    expect(await stockOf(1, 1)).toBe(93);
  });

  it("سقف الكميّات حسب أمر شراء مرجعي: تجاوز المستلَم يُرفض", async () => {
    const poId = await receivePurchaseOf100();
    // أرجِع 60 (مسموح)
    await createPurchaseReturn(
      {
        supplierId: 1,
        branchId: 1,
        purchaseOrderRefId: poId,
        items: [{ variantId: 1, productUnitId: 1, quantity: "60", unitPrice: "5.00" }],
      },
      actor
    );
    expect(await stockOf(1, 1)).toBe(40);

    // ثم 50 — يتجاوز المتبقّي (40) ⇒ يُرفض
    await expect(
      createPurchaseReturn(
        {
          supplierId: 1,
          branchId: 1,
          purchaseOrderRefId: poId,
          items: [{ variantId: 1, productUnitId: 1, quantity: "50", unitPrice: "5.00" }],
        },
        actor
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("أمر شراء مرجعي بمورد مختلف ⇒ يُرفض", async () => {
    const poId = await receivePurchaseOf100();
    await db().insert(s.suppliers).values({ id: 2, name: "مورد آخر", currentBalance: "0" });
    await expect(
      createPurchaseReturn(
        {
          supplierId: 2,
          branchId: 1,
          purchaseOrderRefId: poId,
          items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "5.00" }],
        },
        actor
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("بنود فارغة ⇒ يُرفض قبل أي عمل", async () => {
    await expect(
      createPurchaseReturn({ supplierId: 1, branchId: 1, items: [] }, actor)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// RBAC: تمنع البوّابة الكاشير وأمين المخزن من إنشاء مرتجع شراء.
function ctxWith(role: string, branchId: number | null = 1): TrpcContext {
  return {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: { id: 1, role, branchId, name: "t", email: "t@t", isActive: true } as unknown as TrpcContext["user"],
  };
}

describe("RBAC — مرتجع المشتريات (managerProcedure)", () => {
  it("الكاشير لا يستطيع إنشاء مرتجع شراء", async () => {
    const caller = purchaseReturnsRouter.createCaller(ctxWith("cashier"));
    await expect(
      caller.create({
        supplierId: 1,
        branchId: 1,
        items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "1.00" }],
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("أمين المخزن لا يستطيع إنشاء مرتجع شراء (يحمل تكلفة وذمم)", async () => {
    const caller = purchaseReturnsRouter.createCaller(ctxWith("warehouse"));
    await expect(
      caller.create({
        supplierId: 1,
        branchId: 1,
        items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "1.00" }],
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("الكاشير لا يطّلع على قائمة مرتجعات الشراء", async () => {
    const caller = purchaseReturnsRouter.createCaller(ctxWith("cashier"));
    await expect(caller.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
