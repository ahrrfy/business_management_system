// عزل مدير الفرع — قرار المالك ١٢/٨/٢٦: مدير الفرع يرى ويقرأ ويكتب فرعه المُسنَد **فقط**، لا عبورَ
// بين الفروع إطلاقاً. المالك (users.isOwner، يُطبَّع إلى admin في context.ts) والأدمن (تصحيح إداريّ)
// يعبُران كلَّ الفروع. يعكس هذا صراحةً سياسة ٢٣/٧ («المدير يقرأ كلَّ الفروع») — راجع inventoryBranchScope.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { canCrossBranches } from "../../lib/branchAuthority";

const TABLES = ["receipts", "accountingEntries", "invoiceItems", "invoices", "inventoryMovements", "branchStock", "productUnits", "productVariants", "products", "customers", "branches", "users"];
function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set for tests"); return d; }
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
    { id: 1, openId: "a", name: "أدمن", email: "a@t.test", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "m1", name: "مدير ف١", email: "m1@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    // المالك: دوره manager لكنّ isOwner=true (لا نطبّع هنا كـcontext.ts — نتحقّق من مسار isOwner الدفاعيّ).
    { id: 5, openId: "o1", name: "المالك", email: "o1@t.test", role: "manager", loginMethod: "local", branchId: 1, isOwner: true },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "منتج ف١" }, { id: 2, name: "منتج ف٢" }]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "V1-B1", costPrice: "5.00" },
    { id: 2, productId: 2, sku: "V2-B2", costPrice: "7.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  // variant 1 حصريّ في ف١، variant 2 حصريّ في ف٢ — كي يتمايز العزل بوضوح.
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 50 },
    { variantId: 2, branchId: 2, quantity: 10 },
  ]);
  // فاتورة في ف٢ لاختبار عزل تسديد الدفعات (sales.pay): مدير ف١ لا يُسدّد عليها.
  await d.insert(s.customers).values({ id: 1, name: "زبون تجريبي" });
  await d.insert(s.invoices).values({
    invoiceNumber: "INV-B2-1", sourceType: "POS", branchId: 2, customerId: 1,
    subtotal: "1000.00", total: "1000.00", paidAmount: "0.00", status: "PARTIALLY_PAID",
  });
}
function makeCtx(user: any) { return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any; }
async function userById(id: number) { return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0]; }
beforeEach(async () => { await reset(); await seed(); });

describe("canCrossBranches — مُسنَد عبور الفروع الموحّد (قرار المالك ١٢/٨)", () => {
  it("admin يعبُر", () => { expect(canCrossBranches({ role: "admin" })).toBe(true); });
  it("المالك (isOwner) يعبُر ولو كان دوره manager", () => { expect(canCrossBranches({ role: "manager", isOwner: true })).toBe(true); });
  it("مدير الفرع (manager بلا isOwner) لا يعبُر", () => { expect(canCrossBranches({ role: "manager" })).toBe(false); });
  it("الكاشير لا يعبُر", () => { expect(canCrossBranches({ role: "cashier" })).toBe(false); });
  it("null/undefined آمن (fail-closed)", () => { expect(canCrossBranches(null)).toBe(false); expect(canCrossBranches(undefined)).toBe(false); });
});

describe("عزل قراءة مدير الفرع — يقرأ فرعه فقط (branchScopedProcedure)", () => {
  it("مدير ف١: onHand لف٢ يُقصَر على فرعه ف١ (لا يرى مخزون ف٢)", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(4)));
    const rows = await caller.inventory.onHand({ branchId: 2 });
    // scopedBranchId=فرعه ⇒ كلّ الصفوف من ف١ (لا صفٌّ من ف٢).
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r: any) => Number(r.branchId) === 1)).toBe(true);
  });
  it("الأدمن يعبُر: onHand لف٢ يُرجِع صفوف ف٢", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(1)));
    const rows = await caller.inventory.onHand({ branchId: 2 });
    expect(rows.every((r: any) => Number(r.branchId) === 2)).toBe(true);
  });
  it("المالك (isOwner) يعبُر كالأدمن عبر مسار isOwner الدفاعيّ: يرى مخزون ف٢", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(5)));
    const rows = await caller.inventory.onHand({ branchId: 2 });
    expect(rows.every((r: any) => Number(r.branchId) === 2)).toBe(true);
  });
});

describe("عزل كتابة مدير الفرع — لا يحرّك مخزون فرعٍ آخر (transferService)", () => {
  it("مدير ف١ لا يُحوّل **من** ف٢ — FORBIDDEN، وصفر حركة", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(4)));
    await expect(
      caller.inventory.transferBatch({ fromBranchId: 2, toBranchId: 1, items: [{ variantId: 2, baseQuantity: 5 }] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
  });
  it("الأدمن يُحوّل من ف٢ بلا حظرٍ فرعيّ", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(1)));
    let err: any = null;
    try { await caller.inventory.transferBatch({ fromBranchId: 2, toBranchId: 1, items: [{ variantId: 2, baseQuantity: 5 }] }); } catch (e) { err = e; }
    expect(err?.code).not.toBe("FORBIDDEN");
  });
});

describe("عزل قراءة التقارير (reportViewerProcedure) — المدير مقيَّدٌ بفرعه", () => {
  it("مدير ف١ يطلب تقرير أعمار الذمم لف٢ — FORBIDDEN", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(4)));
    await expect(
      (caller.reports as any).arAging({ branchId: 2 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("الأدمن لا يُحظَر فرعياً على تقرير ف٢", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(1)));
    let err: any = null;
    try { await (caller.reports as any).arAging({ branchId: 2 }); } catch (e) { err = e; }
    expect(err?.code).not.toBe("FORBIDDEN");
  });
});

describe("عزل تسديد الدفعات (sales.pay) — المدير لا يُسدّد على فاتورة فرعٍ آخر", () => {
  async function branch2InvoiceId(): Promise<number> {
    const [inv] = await db().select({ id: s.invoices.id }).from(s.invoices).where(eq(s.invoices.invoiceNumber, "INV-B2-1")).limit(1);
    return Number(inv.id);
  }
  it("مدير ف١ يُسدّد نقداً على فاتورة ف٢ ⇒ FORBIDDEN (فاتورة فرعٍ آخر)", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(4))); // مدير ف١
    await expect(
      (caller.sales as any).pay({ invoiceId: await branch2InvoiceId(), amount: "100.00", method: "CASH" }),
    ).rejects.toThrow(/فرع/);
  });
  it("الأدمن لا يُحظَر فرعياً على تسديد فاتورة ف٢ (يعبُر فحص الفرع)", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(1))); // admin
    let err: any = null;
    try { await (caller.sales as any).pay({ invoiceId: await branch2InvoiceId(), amount: "100.00", method: "CASH" }); } catch (e) { err = e; }
    // admin يعبُر فحص الفرع (قد يفشل لسببٍ آخر كالوردية، لكن ليس رفضاً فرعياً).
    expect(String(err?.message ?? "")).not.toMatch(/فاتورة فرع آخر/);
  });
});
