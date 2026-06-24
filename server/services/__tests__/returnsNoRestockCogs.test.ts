/**
 * مرتجع البيع — علّتان أُصلحتا (٢٤/٦):
 *
 *  1) COGS لا تُعكَس إلا حين تعود البضاعة للمخزون:
 *     قبل الإصلاح كان قيد RETURN يعكس التكلفة دائماً حتى مع restock=false (تالف/أمر شغل) رغم أن
 *     البضاعة لا تعود للرفّ ⇒ تبخّر التكلفة من الدفتر (COGS صافيها صفر) = ربح مُبالَغ + نقص أصل
 *     بلا مصروف مقابل، مناقضةً لسياسة «التلف مصروفٌ بالكلفة». الآن: تُعكَس التكلفة فقط حين
 *     restock=true فيتعادل ازديادُ المخزون مع نقصان COGS؛ ومع restock=false تبقى الخسارة بالكلفة.
 *
 *  2) returns.getInvoice بلا عزل فرع (IDOR قراءة): مدير فرعٍ كان يقرأ تفاصيل فاتورة فرعٍ آخر
 *     (بنود/عميل/مبالغ). الآن FORBIDDEN لغير الأدمن خارج فرعه — مرآةٌ لفحص ملكية الفرع في create.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { returnSale } from "../returnService";
import { createSale } from "../saleService";

const actor = { userId: 1, branchId: 1, role: "admin" };

const TABLES = [
  "idempotencyKeys",
  "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
  "purchaseOrderItems", "purchaseOrders",
  "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "workOrderMaterials", "workOrders", "customers", "suppliers", "branches", "users",
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
  await d.insert(s.branches).values([
    { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
    { id: 2, name: "SALES", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([{ id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local" }]);
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "10.00" }]);
  await d.insert(s.customers).values({ id: 1, name: "تاجر", defaultPriceTier: "RETAIL", currentBalance: "0" });
}

async function setStock(variantId: number, branchId: number, qty: number) {
  await db().insert(s.branchStock).values({ variantId, branchId, quantity: qty });
}

/** بيع آجل لـ٥ قطع من الفرع ١ (إيراد ٥٠، تكلفة ٢٠، ربح ٣٠). */
async function sellFive() {
  await setStock(1, 1, 10);
  const sale = await createSale(
    { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }] },
    actor,
  );
  const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
  return { invoiceId: sale.invoiceId, itemId: Number(item.id) };
}

async function returnEntry(invoiceId: number) {
  return (
    await db()
      .select()
      .from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.invoiceId, invoiceId), eq(s.accountingEntries.entryType, "RETURN")))
  )[0];
}

async function stockQty() {
  return (await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0].quantity;
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("returnSale — COGS تُعكَس فقط حين تعود البضاعة للمخزون", () => {
  it("restock=true: يعكس COGS ويُعيد البضاعة للرفّ", async () => {
    const { invoiceId, itemId } = await sellFive();
    const before = await stockQty();
    await returnSale({ invoiceId, lines: [{ invoiceItemId: itemId, baseQuantity: 5 }], restock: true }, actor);
    const e = await returnEntry(invoiceId);
    expect(Number(e.revenue)).toBeCloseTo(-50, 2);
    expect(Number(e.cost)).toBeCloseTo(-20, 2); // COGS مُعكَسة (5×4) — البضاعة عادت
    expect(Number(e.profit)).toBeCloseTo(-30, 2); // −(50−20)
    expect(await stockQty()).toBe(before + 5); // عادت للمخزون
  });

  it("restock=false (تالف): لا يعكس COGS ولا يُعيد البضاعة", async () => {
    const { invoiceId, itemId } = await sellFive();
    const before = await stockQty();
    await returnSale({ invoiceId, lines: [{ invoiceItemId: itemId, baseQuantity: 5 }], restock: false }, actor);
    const e = await returnEntry(invoiceId);
    expect(Number(e.revenue)).toBeCloseTo(-50, 2);
    expect(Number(e.cost)).toBeCloseTo(0, 2); // التكلفة تبقى خسارة — لا تُعكَس
    expect(Number(e.profit)).toBeCloseTo(-50, 2); // الخسارة = الإيراد المُعكَس كاملاً (لا تعويض من عكس COGS)
    expect(await stockQty()).toBe(before); // لم تعد للمخزون
  });

  it("مرتجع جزئي restock=false يعكس التكلفة صفراً ويُبقي الباقي قابلاً للإرجاع", async () => {
    const { invoiceId, itemId } = await sellFive();
    const before = await stockQty();
    await returnSale({ invoiceId, lines: [{ invoiceItemId: itemId, baseQuantity: 2 }], restock: false }, actor);
    const e = await returnEntry(invoiceId);
    expect(Number(e.revenue)).toBeCloseTo(-20, 2); // 2×10
    expect(Number(e.cost)).toBeCloseTo(0, 2);
    expect(Number(e.profit)).toBeCloseTo(-20, 2);
    expect(await stockQty()).toBe(before); // التالف لا يعود
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.id, itemId)))[0];
    expect(item.returnedBaseQuantity).toBe(2); // الباقي (3) ما زال قابلاً للإرجاع
  });
});

describe("returns.getInvoice — عزل الفرع (IDOR قراءة)", () => {
  function ctxWith(role: string, branchId: number | null): TrpcContext {
    return {
      req: { headers: {} } as unknown as TrpcContext["req"],
      res: {} as unknown as TrpcContext["res"],
      user: { id: 1, role, branchId, name: "t", email: "t@t", isActive: true } as unknown as TrpcContext["user"],
    };
  }
  const caller = (role: string, branchId: number | null) => appRouter.createCaller(ctxWith(role, branchId));

  it("مدير فرعٍ آخر ⇒ FORBIDDEN؛ مدير الفرع وadmin ⇒ يقرآن", async () => {
    const { invoiceId } = await sellFive(); // فاتورة في الفرع ١
    await expect(caller("manager", 2).returns.getInvoice({ invoiceId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const asAdmin = await caller("admin", null).returns.getInvoice({ invoiceId });
    expect(asAdmin?.id).toBe(invoiceId);
    const asOwnMgr = await caller("manager", 1).returns.getInvoice({ invoiceId });
    expect(asOwnMgr?.id).toBe(invoiceId);
  });

  it("list: مدير بلا فرع مُسنَد ⇒ FORBIDDEN (لا تسريب مرتجعات كل الفروع)", async () => {
    await sellFive();
    await expect(caller("manager", null).returns.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    // مدير بفرعٍ مُسنَد يمرّ (يُقصَر على فرعه)، وadmin يرى الكل.
    await expect(caller("manager", 1).returns.list({})).resolves.toBeTruthy();
    await expect(caller("admin", null).returns.list({})).resolves.toBeTruthy();
  });
});
