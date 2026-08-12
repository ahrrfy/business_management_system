// عزل المدير في المخزون — «قراءة/كتابة فرعه فقط» (قرار المالك ١٢/٨/٢٦ يعكس ٢٣/٧).
// ١٢/٨: لا عبورَ للمدير بين الفروع إطلاقاً — لا قراءةً ولا كتابةً. المالك (isOwner→admin) والأدمن يعبُران.
// (سابقاً ٢٣/٧ كان المدير يقرأ كلَّ الفروع؛ أُلغي.) عزل القراءة مُوسَّعٌ في managerBranchIsolation.test.ts.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

const TABLES = ["inventoryMovements", "branchStock", "productUnits", "productVariants", "products", "branches", "users"];
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
  ]);
  await d.insert(s.products).values([{ id: 1, name: "ورق A4" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "PAP-1", costPrice: "5.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 50 },
    { variantId: 1, branchId: 2, quantity: 10 },
  ]);
}
function makeCtx(user: any) { return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any; }
async function userById(id: number) { return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0]; }
beforeEach(async () => { await reset(); await seed(); });

describe("عزل المدير في المخزون — «قراءة/كتابة فرعه فقط» (قرار المالك ١٢/٨ يعكس ٢٣/٧)", () => {
  // عزل القراءة (المدير يقرأ فرعه فقط، لا يعبُر) مُغطّى في managerBranchIsolation.test.ts (stockByBranch).
  // هنا ثابت الكتابة: لا يُحوّل المدير من فرعٍ ليس فرعه (transferService)، والأدمن يعبُر.
  it("كتابة فرعه: مدير ف١ لا يُحوّل **من** ف٢ (فرعٌ ليس له) — FORBIDDEN", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(4)));
    await expect(
      caller.inventory.transfer({ variantId: 1, fromBranchId: 2, toBranchId: 1, baseQuantity: 5 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // لم تُنشأ أيّ حركة (ارتدّ قبل التنفيذ).
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
  });

  it("الأدمن يبقى عابر الفروع: يقرأ ف٢ ولا يُحظَر فرعياً على التحويل منه", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(1)));
    const rows = await caller.inventory.onHand({ branchId: 2 });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // تحويل الأدمن من ف٢ لا يُرفَض بحظرٍ فرعيّ (قد ينجح فعلياً — ف٢ فيه رصيد ١٠).
    let err: any = null;
    try { await caller.inventory.transfer({ variantId: 1, fromBranchId: 2, toBranchId: 1, baseQuantity: 5 }); } catch (e) { err = e; }
    expect(err?.code).not.toBe("FORBIDDEN");
  });
});
