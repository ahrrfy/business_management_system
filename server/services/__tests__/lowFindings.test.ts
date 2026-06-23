/**
 * اختبارات شريحة «إغلاقات منخفضة» (٢٣/٦/٢٦):
 *  1) JWT setNotBefore — التوكن يحمل nbf = iat (يُرفض قبل لحظة إصداره).
 *  2) auth.register — يقبل أدواراً من الـenum الكامل (١٠ أدوار) لا فقط ٥.
 */
import { jwtVerify } from "jose";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { signSession } from "../../auth/session";
import { hashPassword } from "../../auth/password";
import { appRouter } from "../../routers";

const TABLES = [
  "idempotencyKeys", "auditLogs", "accountingEntries", "receipts",
  "inventoryMovements", "invoiceItems", "invoices", "workOrderImages",
  "workOrderMaterials", "workOrders", "cashTransfers", "branchStock",
  "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "suppliers", "branches", "users",
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
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([{
    id: 1, openId: "adm", name: "المدير", email: "admin@t.test",
    passwordHash: hashPassword("P@ss1"), role: "admin", loginMethod: "local", branchId: 1,
  }]);
}
function makeCtx(user: any) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any;
}

beforeEach(async () => { await reset(); await seed(); });

// ─── (1) JWT setNotBefore ────────────────────────────────────────────────────
describe("signSession — nbf = iat في التوكن المُصدَر", () => {
  it("التوكن يحمل nbf مساوياً لـiat", async () => {
    const token = await signSession(1, 3600_000);
    const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? "test_secret_32bytes_padding1234!");
    const { payload } = await jwtVerify(token, secret);
    expect(typeof payload.nbf).toBe("number");
    expect(payload.nbf).toBe(payload.iat);
  });

  it("التوكن يُرفَض قبل وقت nbf", async () => {
    // أصدر توكن بـiat = الآن + 300 ثانية (في المستقبل)
    const futureSec = Math.floor(Date.now() / 1000) + 300;
    const token = await signSession(1, 3600_000, null, futureSec);
    const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? "test_secret_32bytes_padding1234!");
    // nbf مستقبلي → يُرفض الآن ("nbf" claim timestamp check failed)
    await expect(jwtVerify(token, secret)).rejects.toThrow(/"nbf" claim/i);
  });
});

// ─── (2) auth.register — الأدوار الكاملة ١٠ ────────────────────────────────
describe("auth.register — يقبل أدواراً من الـenum الكامل", () => {
  it("دور accountant يُسجَّل بنجاح", async () => {
    const adminUser = (await db().select().from(s.users).where(eq(s.users.id, 1)).limit(1))[0];
    const caller = appRouter.createCaller(makeCtx(adminUser));
    const res = await caller.auth.register({
      email: "acct@t.test",
      name: "محاسب",
      password: "P@ssw0rd12345!",
      role: "accountant",
      branchId: 1,
    });
    expect(res.userId).toBeGreaterThan(0);
    const row = (await db().select({ role: s.users.role }).from(s.users).where(eq(s.users.id, res.userId)).limit(1))[0];
    expect(row?.role).toBe("accountant");
  });

  it("دور auditor يُسجَّل بنجاح", async () => {
    const adminUser = (await db().select().from(s.users).where(eq(s.users.id, 1)).limit(1))[0];
    const caller = appRouter.createCaller(makeCtx(adminUser));
    const res = await caller.auth.register({
      email: "aud@t.test",
      name: "مدقّق",
      password: "P@ssw0rd12345!",
      role: "auditor",
      branchId: 1,
    });
    expect(res.userId).toBeGreaterThan(0);
  });
});
