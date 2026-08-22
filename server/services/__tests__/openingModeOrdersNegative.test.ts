// توسعة «وضع الافتتاح» لقنوات التنفيذ (قرار المالك ١٠/٨) — بدء أمر الشغل (startWorkOrder) يستهلك
// مواد صنفٍ **غير مُفتتَح** بالسالب أثناء النافذة الفعّالة (تكلفة>0 + ضمن سقف السطر)، ويعود صارماً
// خارج النافذة أو للمادة المُفتتَحة (المجرودة). يكمّل حارس البيع في openingModeSaleGuard.test.ts.
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { startWorkOrder } from "../workOrder/lifecycle";

const actor = { userId: 1, branchId: 1, role: "admin" };
const DAY_MS = 86_400_000;

const TABLES = [
  "inventoryMovements",
  "branchStock",
  "openingModeSettings",
  "workOrderMaterials",
  "workOrders",
  "productUnits",
  "productVariants",
  "products",
  "suppliers",
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
  await d.insert(s.suppliers).values({ id: 9, name: "مودِع مواد", supplierKind: "CONSIGNOR" });
  await d.insert(s.products).values([
    { id: 1, name: "ورق" },
    { id: 2, name: "مادة بلا تكلفة" },
    { id: 3, name: "مادة أمانة", isConsignment: true, consignorId: 9 },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PAPER-1", costPrice: "4.00" },
    { id: 2, productId: 2, sku: "NOCST-1", costPrice: "0.00" },
    { id: 3, productId: 3, sku: "CONSIGN-1", costPrice: "6.00" },
  ]);
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
async function seedWorkOrder(materials: { variantId: number; baseQuantity: number }[], id = 1) {
  await db()
    .insert(s.workOrders)
    .values({ id, orderNumber: `WO-${id}`, branchId: 1, title: "طلب تنفيذ", status: "RECEIVED", assignedTo: 1, createdBy: 1 });
  if (materials.length)
    await db()
      .insert(s.workOrderMaterials)
      .values(materials.map((m) => ({ workOrderId: id, variantId: m.variantId, baseQuantity: m.baseQuantity })));
}
async function stockOf(variantId: number, branchId = 1): Promise<number> {
  const [r] = await db()
    .select({ q: s.branchStock.quantity })
    .from(s.branchStock)
    .where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, branchId)));
  return Number(r?.q ?? 0);
}
async function expectStart(id: number): Promise<TRPCError | null> {
  let err: unknown = null;
  try {
    await startWorkOrder(id, actor);
  } catch (e) {
    err = e;
  }
  return (err as TRPCError) ?? null;
}

describe("توسعة وضع الافتتاح — بدء أمر الشغل بالسالب (التنفيذ)", () => {
  it("النافذة مطفأة ⇒ بدء أمر بمادة بلا رصيد يُرفض «المخزون غير كافٍ» (ذرّية كاملة)", async () => {
    await seedWorkOrder([{ variantId: 1, baseQuantity: 3 }]);
    const err = await expectStart(1);
    expect(err?.code).toBe("CONFLICT");
    expect(err?.message).toMatch(/المخزون غير كافٍ/);
    expect(err?.message).not.toMatch(/وضع الافتتاح/);
    expect(await stockOf(1)).toBe(0); // لم يُستهلك شيء
    const [wo] = await db().select().from(s.workOrders).where(eq(s.workOrders.id, 1));
    expect(wo.status).toBe("RECEIVED"); // لم تتقدّم الحالة
  });

  it("النافذة فعّالة + مادة غير مُفتتَحة + تكلفة>0 ⇒ يبدأ ويستهلك بالسالب مع لقطة تكلفة", async () => {
    await enableOpeningMode();
    await seedWorkOrder([{ variantId: 1, baseQuantity: 3 }]);
    const res = await startWorkOrder(1, actor);
    expect(res.status).toBe("IN_PROGRESS");
    expect(res.materialsCost).toBe("12.00"); // 3 × 4.00 — COGS سليم رغم السالب
    expect(await stockOf(1)).toBe(-3);
  });

  it("مادة بلا تكلفة تُرفض حتى داخل النافذة برسالة «أدخِل تكلفتها» (سلامة COGS)", async () => {
    await enableOpeningMode();
    await seedWorkOrder([{ variantId: 2, baseQuantity: 2 }]);
    const err = await expectStart(1);
    expect(err?.code).toBe("CONFLICT");
    expect(err?.message).toMatch(/تكلفة مُدخلة للمادة/);
    expect(await stockOf(2)).toBe(0);
  });

  it("مادة أمانة مرفوضة من أمر الشغل حتى مع رصيد موجب، بلا حركة أو WIP", async () => {
    await db().insert(s.branchStock).values({ variantId: 3, branchId: 1, quantity: 5 });
    await seedWorkOrder([{ variantId: 3, baseQuantity: 2 }]);
    const err = await expectStart(1);
    expect(err?.code).toBe("BAD_REQUEST");
    expect(err?.message).toMatch(/الأمانة/);
    expect(await stockOf(3)).toBe(5);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
    const [wo] = await db().select().from(s.workOrders).where(eq(s.workOrders.id, 1));
    expect(wo.status).toBe("RECEIVED");
    const [material] = await db().select().from(s.workOrderMaterials).where(eq(s.workOrderMaterials.workOrderId, 1));
    expect(material.unitCost).toBe("0.00");
  });

  it("مادة مُفتتَحة (مجرودة) تُرفض بالسالب برسالة «مجرودة» — رصيدها مثبّت", async () => {
    await enableOpeningMode();
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 1, openedAt: new Date() });
    await seedWorkOrder([{ variantId: 1, baseQuantity: 3 }]);
    const err = await expectStart(1);
    expect(err?.code).toBe("CONFLICT");
    expect(err?.message).toMatch(/مجرودة/);
    expect(await stockOf(1)).toBe(1);
  });

  it("تجاوز سقف السطر السالب يُرفض برسالة السقف؛ وضمن السقف يمرّ", async () => {
    await enableOpeningMode({ maxNegativeQtyPerLine: 5 });
    await seedWorkOrder([{ variantId: 1, baseQuantity: 6 }]);
    const err = await expectStart(1);
    expect(err?.code).toBe("CONFLICT");
    expect(err?.message).toMatch(/سقف السطر السالب/);

    await seedWorkOrder([{ variantId: 1, baseQuantity: 5 }], 2);
    const res = await startWorkOrder(2, actor);
    expect(res.status).toBe("IN_PROGRESS");
    expect(await stockOf(1)).toBe(-5);
  });
});
