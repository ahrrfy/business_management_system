/**
 * اختبارات نوع وردية «خدمات الطباعة» (PRINT_SERVICES) — الفصل الكامل عن التجزئة (قرار المالك ٢٣/٧/٢٦):
 *  1) يُمكن فتح ورديات RETAIL + RECEPTION + PRINT_SERVICES معاً لنفس (موظّف×فرع) — openGuard يشمل النوع.
 *  2) فتح وردية ثانية من نوع PRINT_SERVICES يفشل (CONFLICT) — درجٌ واحد مفتوح لكل نوع.
 *  3) getOpenShift يفلتر بـPRINT_SERVICES صراحةً (لا يخلط بدرج التجزئة).
 *  4) openShiftIdTx الحلّ المرن الحتمي: ٣ ورديات ⇒ تُختار بالنوع المفضّل (نسب النقد للدرج الصحيح).
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getOpenShift, openShift, openShiftIdTx } from "../shiftService";
import { withTx } from "../tx";

const TABLES = ["receipts", "shifts", "users", "branches"];

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
  await d.insert(s.users).values([
    { id: 1, openId: "local_admin", name: "المدير", email: "admin@t.test", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_print", name: "كاشير الطباعة", email: "p@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
}

describe("نوع الوردية — PRINT_SERVICES (فصل درج الطباعة عن التجزئة)", () => {
  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("يفتح RETAIL وRECEPTION وPRINT_SERVICES معاً لنفس الموظّف/الفرع", async () => {
    const retail = await openShift({ branchId: 1, openingBalance: "100", shiftType: "RETAIL" }, { userId: 2, branchId: 1 });
    const recep = await openShift({ branchId: 1, openingBalance: "200", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const print = await openShift({ branchId: 1, openingBalance: "300", shiftType: "PRINT_SERVICES" }, { userId: 2, branchId: 1 });
    expect(retail.shiftId).toBeGreaterThan(0);
    expect(recep.shiftId).toBeGreaterThan(0);
    expect(print.shiftId).toBeGreaterThan(0);
    const ids = new Set([retail.shiftId, recep.shiftId, print.shiftId]);
    expect(ids.size).toBe(3);
    const open = await db().select().from(s.shifts).where(eq(s.shifts.status, "OPEN"));
    expect(open.length).toBe(3);
  });

  it("يرفض وردية طباعة ثانية (درجٌ واحد مفتوح لكل نوع)", async () => {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "PRINT_SERVICES" }, { userId: 2, branchId: 1 });
    await expect(
      openShift({ branchId: 1, openingBalance: "0", shiftType: "PRINT_SERVICES" }, { userId: 2, branchId: 1 }),
    ).rejects.toThrow();
  });

  it("getOpenShift يفلتر بـPRINT_SERVICES (لا يخلط بدرج التجزئة)", async () => {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RETAIL" }, { userId: 2, branchId: 1 });
    const print = await openShift({ branchId: 1, openingBalance: "0", shiftType: "PRINT_SERVICES" }, { userId: 2, branchId: 1 });
    const g = await getOpenShift(2, 1, "PRINT_SERVICES");
    expect(Number(g?.id)).toBe(print.shiftId);
    expect(g?.shiftType).toBe("PRINT_SERVICES");
  });

  it("openShiftIdTx: ٣ ورديات ⇒ تُختار بالنوع المفضّل (نسب النقد للدرج الصحيح)", async () => {
    const retail = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RETAIL" }, { userId: 2, branchId: 1 });
    const recep = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const print = await openShift({ branchId: 1, openingBalance: "0", shiftType: "PRINT_SERVICES" }, { userId: 2, branchId: 1 });
    const asPrint = await withTx((tx) => openShiftIdTx(tx, 2, 1, "PRINT_SERVICES"));
    const asRetail = await withTx((tx) => openShiftIdTx(tx, 2, 1, "RETAIL"));
    const asRecep = await withTx((tx) => openShiftIdTx(tx, 2, 1, "RECEPTION"));
    expect(asPrint).toBe(print.shiftId);
    expect(asRetail).toBe(retail.shiftId);
    expect(asRecep).toBe(recep.shiftId);
  });
});
