/**
 * ورديات مستقلّة — كلّ وردية برصيدها الافتتاحيّ الخاصّ (عهدة جديدة تُصرَف عند البدء) ورصيدها الذي
 * تنتهي به، بمعزلٍ تامٍّ عن الوردية السابقة واللاحقة (قرار المالك ٢٨/٧/٢٦: تسليمٌ كامل للخزينة بين
 * الورديتين، ثم تبدأ التالية بعهدةٍ من الخزينة). لا مطابقةَ لمتبقّي وردية سابقة ولا حظر عند الفتح —
 * أيّ رصيدٍ افتتاحيٍّ يُقبَل. الضبط ضدّ التسرّب يبقى *داخل* الوردية (closeShift يحسب فرقها بمعزل).
 * يستبدل هذا الملفُّ اختباراتِ «استمرارية نقد الورديات» (#320) بعد إلغاء القرن بقرار المالك.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { closeShift, openShift } from "../shiftService";
import { appRouter } from "../../routers";
import { truncateTables } from "./__testUtils__";

function makeCtx(user: any) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any;
}

const TABLES = ["auditLogs", "accountingEntries", "receipts", "shifts", "users", "branches"];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const ADMIN = 1;
const MANAGER1 = 2; // فرع ١ — مستلِم التسليم
const CASHIER1 = 3; // فرع ١
const CASHIER2 = 4; // فرع ١ — الكاشير التالي على نفس الدرج
const MANAGER2 = 5; // فرع ٢

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: ADMIN, openId: "local_admin", name: "المدير العام", role: "admin", loginMethod: "local" },
    { id: MANAGER1, openId: "local_mgr1", name: "مدير الفرع١", role: "manager", loginMethod: "local", branchId: 1 },
    { id: CASHIER1, openId: "local_c1", name: "كاشير١", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: CASHIER2, openId: "local_c2", name: "كاشير٢", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: MANAGER2, openId: "local_mgr2", name: "مدير الفرع٢", role: "manager", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.receipts).values([
    {
      branchId: 1,
      direction: "IN",
      amount: "1000000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "TEST-TREASURY-SHIFT-CONTINUITY-1",
      createdBy: ADMIN,
    },
    {
      branchId: 2,
      direction: "IN",
      amount: "1000000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "TEST-TREASURY-SHIFT-CONTINUITY-2",
      createdBy: ADMIN,
    },
  ]);
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
});

async function shiftRow(id: number) {
  return (await db().select().from(s.shifts).where(eq(s.shifts.id, id)).limit(1))[0];
}

describe("ورديات مستقلّة — الخدمة (openShift/closeShift)", () => {
  it("أوّل وردية: أيّ رصيدٍ افتتاحيّ يُقبَل بلا مطابقة ولا حظر", async () => {
    const res = await openShift(
      { branchId: 1, openingBalance: "100000", shiftType: "RETAIL" },
      { userId: CASHIER1, branchId: 1 },
    );
    expect(res.expectedOpening).toBeNull();
    expect(res.hasDiscrepancy).toBe(false);
    const row = await shiftRow(res.shiftId);
    expect(row.openingBalance).toBe("100000.00");
    expect(row.openingExpectedCash).toBeNull();
    expect(row.openingDiscrepancyReason).toBeNull();
  });

  it("الوردية التالية تبدأ بعهدتها الخاصّة بمعزلٍ عن متبقّي السابقة — لا قرن ولا حظر", async () => {
    // A: تُفتَح بـ500، تُغلَق بمعدود 500؛ يعود كامل نقدها للخزينة (درجها ⇒ صفر) بلا قرنٍ بالتالية.
    const a = await openShift(
      { branchId: 1, openingBalance: "500", shiftType: "RETAIL" },
      { userId: CASHIER1, branchId: 1 },
    );
    await closeShift(
      { shiftId: a.shiftId, countedCash: "500" }, // العهدة الوسيطة: يعود كامل المعدود (500) للخزينة تلقائياً
      { userId: CASHIER1, branchId: 1, role: "cashier" },
    );
    // B: تبدأ بعهدةٍ جديدة 100000 (مستقلّة تماماً عن السابقة) ⇒ تُقبَل دائماً (لا PRECONDITION_FAILED).
    const b = await openShift(
      { branchId: 1, openingBalance: "100000", shiftType: "RETAIL" },
      { userId: CASHIER2, branchId: 1 },
    );
    expect(b.hasDiscrepancy).toBe(false);
    expect(b.expectedOpening).toBeNull();
    expect((await shiftRow(b.shiftId)).openingBalance).toBe("100000.00");
    // كلتا الورديتين موجودتان (لم يُرفض فتح B).
    expect(await db().select().from(s.shifts)).toHaveLength(2);
  });

  it("كل وردية تُحاسَب على فرقها وحدها (المتوقَّع = افتتاحيّها، لا متبقّي غيرها)", async () => {
    // A: افتتاحيّ 1000، معدود 800 ⇒ عجز 200 (على A).
    const a = await openShift(
      { branchId: 1, openingBalance: "1000", shiftType: "RETAIL" },
      { userId: CASHIER1, branchId: 1 },
    );
    await closeShift({ shiftId: a.shiftId, countedCash: "800" }, { userId: CASHIER1, branchId: 1, role: "cashier" });
    const aRow = await shiftRow(a.shiftId);
    expect(aRow.expectedCash).toBe("1000.00");
    expect(aRow.variance).toBe("-200.00");

    // B: عهدة مختلفة تماماً 5000 (لا علاقة لها بمتبقّي A)، معدود 5000 ⇒ فرق 0 محسوبٌ على افتتاحيّها.
    const b = await openShift(
      { branchId: 1, openingBalance: "5000", shiftType: "RETAIL" },
      { userId: CASHIER2, branchId: 1 },
    );
    await closeShift({ shiftId: b.shiftId, countedCash: "5000" }, { userId: CASHIER2, branchId: 1, role: "cashier" });
    const bRow = await shiftRow(b.shiftId);
    expect(bRow.expectedCash).toBe("5000.00");
    expect(bRow.variance).toBe("0.00");
  });

  it("وردية مفتوحة لنفس الكاشير/الفرع/النوع تمنع فتح ثانية (حارس الفتح المزدوج — لا علاقة بالاستمرارية)", async () => {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RETAIL" }, { userId: CASHIER1, branchId: 1 });
    await expect(
      openShift({ branchId: 1, openingBalance: "0", shiftType: "RETAIL" }, { userId: CASHIER1, branchId: 1 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("عزل النوع: RETAIL وRECEPTION درجان مستقلّان — كلاهما يُفتَح بأيّ رصيد", async () => {
    const retail = await openShift(
      { branchId: 1, openingBalance: "300", shiftType: "RETAIL" },
      { userId: CASHIER1, branchId: 1 },
    );
    const reception = await openShift(
      { branchId: 1, openingBalance: "999", shiftType: "RECEPTION" },
      { userId: CASHIER1, branchId: 1 },
    );
    expect(retail.hasDiscrepancy).toBe(false);
    expect(reception.hasDiscrepancy).toBe(false);
    expect(await db().select().from(s.shifts)).toHaveLength(2);
  });
});

describe("ورديات مستقلّة — الراوتر (open + التدقيق)", () => {
  it("open (راوتر) بعهدةٍ مختلفة عن متبقّي السابقة ⇒ يُقبَل ويُسجَّل فتح الوردية", async () => {
    // A تُغلَق، ويُفرَّغ كامل نقدها للخزينة (لا متبقٍّ في الدرج).
    const a = await openShift(
      { branchId: 1, openingBalance: "500", shiftType: "RETAIL" },
      { userId: CASHIER1, branchId: 1 },
    );
    await closeShift(
      { shiftId: a.shiftId, countedCash: "500" }, // العهدة الوسيطة: يعود كامل المعدود (500) للخزينة تلقائياً
      { userId: CASHIER1, branchId: 1, role: "cashier" },
    );
    const caller = appRouter.createCaller(makeCtx({ id: CASHIER2, role: "cashier", branchId: 1, name: "كاشير٢" }));
    const res = await caller.shifts.open({ branchId: 1, openingBalance: "100000", shiftType: "RETAIL" });
    expect(res.hasDiscrepancy).toBe(false);

    const logs = await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "shift.open"));
    expect(logs).toHaveLength(1);
    // وردية A + وردية B = 2 (فتح B لم يُرفض).
    expect(await db().select().from(s.shifts)).toHaveLength(2);
  });

  it("open (راوتر): الكاشير يُقيَّد على فرعه المُسنَد (عزل الفرع)", async () => {
    const caller = appRouter.createCaller(makeCtx({ id: CASHIER1, role: "cashier", branchId: 1, name: "كاشير١" }));
    const res = await caller.shifts.open({ branchId: 2, openingBalance: "1000", shiftType: "RETAIL" });
    expect((await shiftRow(res.shiftId)).branchId).toBe(1);
  });
});
