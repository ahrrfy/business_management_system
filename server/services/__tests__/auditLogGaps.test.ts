/**
 * اختبارات شريحة «إغلاق فجوات سجلّ التدقيق» (٢٣/٦/٢٦):
 *  H5) role.update يَلتقط oldValue/newValue كامل لخريطة الصلاحيات.
 *      تَوسعة دور خفيّة (admin مُخترَق يَمنح صلاحية ثم يُعيدها) ⇒ تَترك أَثَراً forensic.
 *  H6) catalog.updateProduct يَلتقط prices (priceTier × unit) في oldValue/newValue.
 *      تلاعب أسعار البيع لزبون-شريك ⇒ مكشوف في diff السجلّ.
 *  M)  role.create يُسجّل permissions الأوّليّة.
 *  M)  user.update يَلتقط oldValue + permissionsOverride.
 *  M)  period.unlock يَلتقط cutoffDate المُفتَك (لا «unlocked: true» مجرّد).
 *  M)  shift.close يَلتقط expectedCash/variance/handover (Z-report snapshot في audit).
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { hashPassword } from "../../auth/password";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { appRouter } from "../../routers";

const TABLES = [
  "auditLogs",
  "financialPeriods",
  "accountingEntries",
  "receipts",
  "shifts",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "roles",
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
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({
    id: 1,
    openId: "local_admin",
    name: "المدير",
    email: "admin@t.test",
    passwordHash: hashPassword("Admin@12345"),
    role: "admin",
    loginMethod: "local",
    branchId: 1,
  });
}

function makeCtx(user: any) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any;
}

async function admin() {
  return (await db().select().from(s.users).where(eq(s.users.id, 1)).limit(1))[0];
}

async function lastAudit(action: string) {
  const rows = await db()
    .select()
    .from(s.auditLogs)
    .where(eq(s.auditLogs.action, action))
    .orderBy(sql`${s.auditLogs.id} DESC`)
    .limit(1);
  return rows[0] ?? null;
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

// ─── (H5) role.update ─────────────────────────────────────────────────
describe("H5 — role.update يَلتقط oldValue/newValue لخريطة الصلاحيات", () => {
  it("توسعة صلاحية يَكشفها diff السجلّ", async () => {
    const caller = appRouter.createCaller(makeCtx(await admin()));
    const created = await caller.roles.create({
      label: "مشرف تقارير",
      baseRole: "cashier",
      permissions: { reports: "READU".slice(0, 4) as "READ" }, // = "READ"
    });

    // newValue للإنشاء يَحوي permissions (الخدمة تَحفظ الخريطة الكاملة المُطبَّعة في DB ⇒ الـaudit
    // يَلتقطها بنفس الشكل — وهذا أَدقّ لأنّه يَحفظ NONE الصريحة لكل الوحدات لحظة الإنشاء).
    const createRow = await lastAudit("role.create");
    expect(createRow).toBeTruthy();
    const created_new = createRow.newValue as { permissions?: Record<string, string> };
    expect(created_new.permissions).toMatchObject({ reports: "READ" });

    // الآن update لتوسعة الصلاحية: reports: READ ⇒ FULL.
    await caller.roles.update({
      id: created.id,
      permissions: { reports: "FULL" },
    });
    const updateRow = await lastAudit("role.update");
    expect(updateRow).toBeTruthy();

    const oldV = updateRow.oldValue as { permissions?: Record<string, string> };
    const newV = updateRow.newValue as { permissions?: Record<string, string> };
    // قبل: reports=READ. بعد: reports=FULL ⇒ التوسعة كاشفة بصرف النظر عن الوحدات الأخرى.
    expect(oldV.permissions).toMatchObject({ reports: "READ" });
    expect(newV.permissions).toMatchObject({ reports: "FULL" });
  });
});

// ─── (H6) catalog.updateProduct يَلتقط الأسعار ─────────────────────────
describe("H6 — catalog.updateProduct يَلتقط prices في oldValue/newValue", () => {
  it("تخفيض سعر بيع ثم إرجاعه ⇒ مكشوف في diff السجلّ", async () => {
    const d = db();
    // منتج بسيط بوحدة قطعة وسعر retail 10
    await d.insert(s.products).values({ id: 1, name: "قلم" });
    await d.insert(s.productVariants).values({
      id: 1, productId: 1, sku: "PEN-1", costPrice: "5.00",
    });
    await d.insert(s.productUnits).values({
      id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true,
    });
    await d.insert(s.productPrices).values({
      productUnitId: 1, priceTier: "RETAIL", price: "10.00",
    });

    const caller = appRouter.createCaller(makeCtx(await admin()));
    await caller.catalog.updateProduct({
      productId: 1,
      name: "قلم",
      variants: [
        {
          id: 1,
          sku: "PEN-1",
          costPrice: "5.00",
          units: [
            {
              id: 1,
              unitName: "قطعة",
              conversionFactor: "1",
              isBaseUnit: true,
              prices: [{ priceTier: "RETAIL", price: "7.00" }], // ⬇ من 10 إلى 7
            },
          ],
        },
      ],
    });
    const row = await lastAudit("product.update");
    expect(row).toBeTruthy();

    const oldV = row.oldValue as { variants: Array<{ units: Array<{ prices: Array<{ priceTier: string; price: string }> }> }> };
    const newV = row.newValue as { variants: Array<{ units: Array<{ prices: Array<{ priceTier: string; price: string }> }> }> };
    expect(oldV.variants[0].units[0].prices).toEqual([{ priceTier: "RETAIL", price: "10.00" }]);
    expect(newV.variants[0].units[0].prices).toEqual([{ priceTier: "RETAIL", price: "7.00" }]);
  });
});

// ─── (M) user.update يَلتقط oldValue + permissionsOverride ─────────────
describe("user.update — oldValue + permissionsOverride", () => {
  it("ترقية دور + منح override تَتركان أَثَرَ قبل/بعد", async () => {
    const d = db();
    await d.insert(s.users).values({
      id: 5, openId: "local_u5", name: "Old Name", email: "u5@t.test",
      role: "cashier", loginMethod: "local", branchId: 1,
    });

    const caller = appRouter.createCaller(makeCtx(await admin()));
    await caller.users.update({
      userId: 5,
      name: "New Name",
      role: "warehouse",
      permissionsOverride: { reports: "READ" },
    });
    const row = await lastAudit("user.update");
    expect(row).toBeTruthy();
    const oldV = row.oldValue as { name?: string; role?: string; permissionsOverride?: unknown };
    const newV = row.newValue as { name?: string; role?: string; permissionsOverride?: unknown };
    expect(oldV.name).toBe("Old Name");
    expect(oldV.role).toBe("cashier");
    expect(oldV.permissionsOverride).toBeNull();
    expect(newV.name).toBe("New Name");
    expect(newV.role).toBe("warehouse");
    expect(newV.permissionsOverride).toEqual({ reports: "READ" });
  });
});

// ─── (M) period.unlock يَلتقط cutoffDate ─────────────────────────────
describe("period.unlock — يَلتقط cutoffDate المُفتَك", () => {
  it("سجلٌّ يَربط الفتح بتاريخ القفل (لا «unlocked: true» مجرّد)", async () => {
    const caller = appRouter.createCaller(makeCtx(await admin()));
    await caller.periodLock.lock({ cutoffDate: "2026-03-31", notes: "Q1" });
    await caller.periodLock.unlock();
    const row = await lastAudit("period.unlock");
    expect(row).toBeTruthy();
    const oldV = row.oldValue as { cutoffDate?: string; notes?: string };
    const newV = row.newValue as { unlocked?: boolean };
    expect(oldV.cutoffDate).toBe("2026-03-31");
    expect(oldV.notes).toBe("Q1");
    expect(newV.unlocked).toBe(true);
  });
});

// ─── (M) shift.close — Z-report snapshot في audit ──────────────────────
describe("shift.close — يَلتقط expectedCash/variance/handover", () => {
  it("سجلّ الإغلاق يَحوي expectedCash + variance + countedCash", async () => {
    const d = db();
    // كاشير مع وردية مفتوحة بـopeningBalance=0
    await d.insert(s.users).values({
      id: 9, openId: "local_c9", name: "كاشير", email: "c9@t.test",
      role: "cashier", loginMethod: "local", branchId: 1,
    });
    const sh = await d.insert(s.shifts).values({
      userId: 9, branchId: 1, status: "OPEN",
      openedAt: new Date(), openGuard: "9:1", openingBalance: "100.00",
    });
    const shiftId = extractInsertId(sh);
    expect(shiftId).toBeGreaterThan(0);

    const cashier = (await db().select().from(s.users).where(eq(s.users.id, 9)).limit(1))[0];
    const caller = appRouter.createCaller(makeCtx(cashier));
    await caller.shifts.close({ shiftId, countedCash: "100.00" });
    const row = await lastAudit("shift.close");
    expect(row).toBeTruthy();
    const newV = row.newValue as {
      countedCash?: string;
      expectedCash?: string;
      variance?: string;
      openingBalance?: string;
    };
    expect(newV.countedCash).toBe("100.00");
    expect(newV.expectedCash).toBe("100.00");
    expect(newV.variance).toBe("0.00");
    expect(newV.openingBalance).toBe("100.00");
  });
});
