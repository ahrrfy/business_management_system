import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

const TABLES = [
  "auditLogs",
  "inventoryMovements",
  "branchStock",
  "productUnits",
  "productVariants",
  "products",
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

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_admin", name: "المدير", email: "admin@t.local", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_wh", name: "مخزن", email: "wh@t.local", role: "warehouse", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.products).values({ id: 1, name: "ورق A4" });
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "SKU-1", variantName: "عادي", minStock: 10 },
    { id: 2, productId: 1, sku: "SKU-2", variantName: "فاخر", minStock: 0 },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 5 }, // تحت الحد الأدنى (10)
    { variantId: 2, branchId: 1, quantity: 100 },
    { variantId: 1, branchId: 2, quantity: 50 }, // فرع آخر
  ]);
}

function makeCtx(user: any) {
  const res = { cookie() {}, clearCookie() {} };
  const req = { headers: {} as Record<string, string> };
  return { req, res, user } as any;
}

async function userRow(id: number) {
  return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0];
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("inventory.onHand", () => {
  it("يعرض الأرصدة بالأسماء وعلم «تحت الحد الأدنى»", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const rows = await caller.inventory.onHand({ branchId: 1 });
    expect(rows).toHaveLength(2);
    const v1 = rows.find((r) => Number(r.variantId) === 1)!;
    const v2 = rows.find((r) => Number(r.variantId) === 2)!;
    expect(v1.productName).toBe("ورق A4");
    expect(v1.quantity).toBe(5);
    expect(v1.isLow).toBe(true);
    expect(v2.quantity).toBe(100);
    expect(v2.isLow).toBe(false);
  });

  it("lowOnly يُرجع المنخفض فقط", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const rows = await caller.inventory.onHand({ branchId: 1, lowOnly: true });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].variantId)).toBe(1);
  });

  it("البحث يطابق اسم المنتج وSKU", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    expect(await caller.inventory.onHand({ branchId: 1, q: "A4" })).toHaveLength(2);
    const bySku = await caller.inventory.onHand({ branchId: 1, q: "SKU-2" });
    expect(bySku).toHaveLength(1);
    expect(Number(bySku[0].variantId)).toBe(2);
  });

  it("لا يُسرّب التكلفة في المخرجات", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const rows = await caller.inventory.onHand({ branchId: 1 });
    for (const r of rows) expect("costPrice" in r).toBe(false);
  });

  it("عزل الفرع: مستخدم المخزن مقيَّد بفرعه ويتجاهل branchId المُرسَل", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(2))); // warehouse, branch 2
    const rows = await caller.inventory.onHand({ branchId: 1 }); // يحاول فرع 1
    // مُجبَر على فرعه (2): يرى V1@branch2=50 فقط، لا أصناف فرع 1.
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].branchId)).toBe(2);
    expect(rows[0].quantity).toBe(50);
  });
});

describe("inventory.adjust (تسوية ذرّية)", () => {
  it("يضبط الرصيد المطلق ويكتب حركة ADJUST + تدقيق", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    await caller.inventory.adjust({ variantId: 1, branchId: 1, targetQuantity: 30, notes: "جرد" });

    const after = await caller.inventory.onHand({ branchId: 1 });
    expect(after.find((r) => Number(r.variantId) === 1)!.quantity).toBe(30);

    const mv = await db()
      .select()
      .from(s.inventoryMovements)
      .where(and(eq(s.inventoryMovements.variantId, 1), eq(s.inventoryMovements.movementType, "ADJUST")))
      .limit(1);
    expect(mv).toHaveLength(1);
    expect(mv[0].quantity).toBe(25); // |30 - 5|

    const audit = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.action, "inventory.adjust"))
      .limit(1);
    expect(audit).toHaveLength(1);
  });
});
