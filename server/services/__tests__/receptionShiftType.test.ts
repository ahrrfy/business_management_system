/**
 * اختبارات Slice 0 — نوع الوردية (RECEPTION/RETAIL):
 *  1) يُمكن فتح وردية RETAIL ووردية RECEPTION معاً لنفس (موظّف×فرع) — openGuard يَشمل النوع.
 *  2) فتح وردية ثانية من نفس النوع يَفشل (CONFLICT).
 *  3) openShiftIdTx الحلّ المرن الحتمي: وردية واحدة ⇒ تُستعمَل أيّاً كان نوعها؛ ورديتان ⇒ بالنوع المفضّل.
 *  4) getOpenShift يُفلتر بالنوع عند تمريره.
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
    { id: 2, openId: "local_recep", name: "خدمة الزبائن", email: "r@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
}

describe("Slice 0 — shiftType (RECEPTION/RETAIL)", () => {
  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("يفتح RETAIL وRECEPTION معاً لنفس الموظّف/الفرع", async () => {
    const a = await openShift({ branchId: 1, openingBalance: "100", shiftType: "RETAIL" }, { userId: 2, branchId: 1 });
    const b = await openShift({ branchId: 1, openingBalance: "200", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    expect(a.shiftId).toBeGreaterThan(0);
    expect(b.shiftId).toBeGreaterThan(0);
    expect(a.shiftId).not.toBe(b.shiftId);
    const open = await db().select().from(s.shifts).where(eq(s.shifts.status, "OPEN"));
    expect(open.length).toBe(2);
  });

  it("يرفض وردية ثانية من نفس النوع", async () => {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    await expect(
      openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 }),
    ).rejects.toThrow();
  });

  it("openShiftIdTx: وردية واحدة تُستعمَل أيّاً كان النوع (المشغّل الواحد)", async () => {
    // وردية RETAIL فقط، لكن نطلب RECEPTION ⇒ الحلّ المرن يستعملها (وردية واحدة).
    const r = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RETAIL" }, { userId: 2, branchId: 1 });
    const resolved = await withTx((tx) => openShiftIdTx(tx, 2, 1, "RECEPTION"));
    expect(resolved).toBe(r.shiftId);
  });

  it("openShiftIdTx: ورديتان ⇒ تُختار بالنوع المفضّل (حتميّ)", async () => {
    const retail = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RETAIL" }, { userId: 2, branchId: 1 });
    const recep = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const asRecep = await withTx((tx) => openShiftIdTx(tx, 2, 1, "RECEPTION"));
    const asRetail = await withTx((tx) => openShiftIdTx(tx, 2, 1, "RETAIL"));
    expect(asRecep).toBe(recep.shiftId);
    expect(asRetail).toBe(retail.shiftId);
  });

  it("getOpenShift يفلتر بالنوع", async () => {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RETAIL" }, { userId: 2, branchId: 1 });
    const recep = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const g = await getOpenShift(2, 1, "RECEPTION");
    expect(Number(g?.id)).toBe(recep.shiftId);
    expect(g?.shiftType).toBe("RECEPTION");
  });
});
