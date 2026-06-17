import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { cancelExpense, createExpense } from "../expenseService";
import { closeShift, openShift } from "../shiftService";

const actor = { userId: 1, branchId: 1 };

const TABLES = [
  "accountingEntries",
  "receipts",
  "expenses",
  "inventoryMovements",
  "invoiceItems",
  "invoices",
  "shifts",
  "customers",
  "suppliers",
  "branches",
  "users",
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
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values({
    id: 1,
    openId: "local_test",
    name: "admin",
    role: "admin",
    loginMethod: "local",
  });
}

async function entries(type: string) {
  return db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, type as any));
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("المصروفات اليومية", () => {
  it("createExpense: يولّد expense + receipt OUT + قيد PAYMENT_OUT", async () => {
    // shift-gate: المصاريف النقدية تستلزم وردية مفتوحة (تُملأ تلقائياً إن لم تُمرَّر).
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "0" }, actor);
    const r = await createExpense(
      {
        branchId: 1,
        category: "RENT",
        amount: "150000",
        paymentMethod: "CASH",
        description: "إيجار شهر يونيو",
      },
      actor
    );
    expect(r.expenseId).toBeGreaterThan(0);
    expect(r.receiptId).toBeGreaterThan(0);

    const exp = (await db().select().from(s.expenses).where(eq(s.expenses.id, r.expenseId)))[0];
    expect(exp.status).toBe("ACTIVE");
    expect(exp.amount).toBe("150000.00");
    expect(exp.category).toBe("RENT");
    expect(exp.paymentMethod).toBe("CASH");
    expect(Number(exp.receiptId)).toBe(r.receiptId);
    // الوردية تُملأ تلقائياً (لم نُمرّرها صراحةً).
    expect(Number(exp.shiftId)).toBe(shiftId);

    const rc = (await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId)))[0];
    expect(rc.direction).toBe("OUT");
    expect(rc.amount).toBe("150000.00");
    expect(rc.status).toBe("COMPLETED");
    expect(Number(rc.shiftId)).toBe(shiftId);

    const out = await entries("PAYMENT_OUT");
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe("150000.00");
    expect(Number(out[0].receiptId)).toBe(r.receiptId);
  });

  it("createExpense على وردية مفتوحة: يربط الـshiftId ويخفّض النقد المتوقّع", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "200000" }, actor);
    await createExpense(
      { branchId: 1, shiftId, category: "TRANSPORT", amount: "30000", paymentMethod: "CASH", description: "أجور توصيل" },
      actor
    );
    // إغلاق الوردية: المتوقع = افتتاحي(200k) − صرف(30k) = 170k
    const closed = await closeShift({ shiftId, countedCash: "170000" }, actor);
    expect(closed.expectedCash).toBe("170000.00");
    expect(closed.variance).toBe("0.00");
  });

  it("مبلغ <= 0 يُرفض", async () => {
    await expect(
      createExpense({ branchId: 1, category: "OTHER", amount: "0", paymentMethod: "CASH", description: "x" }, actor)
    ).rejects.toThrow();
    await expect(
      createExpense({ branchId: 1, category: "OTHER", amount: "-50", paymentMethod: "CASH", description: "x" }, actor)
    ).rejects.toThrow();
  });

  it("فئة OTHER بلا وصف تُرفض", async () => {
    await expect(
      createExpense({ branchId: 1, category: "OTHER", amount: "100", paymentMethod: "CASH" }, actor)
    ).rejects.toThrow();
  });

  it("وردية مغلقة تُرفض", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "0" }, actor);
    await closeShift({ shiftId, countedCash: "0" }, actor);
    await expect(
      createExpense({ branchId: 1, shiftId, category: "SUPPLIES", amount: "10", paymentMethod: "CASH" }, actor)
    ).rejects.toThrow();
  });

  it("وردية فرع آخر تُرفض", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "0" }, actor);
    await expect(
      createExpense(
        { branchId: 2, shiftId, category: "UTILITIES", amount: "10", paymentMethod: "CASH" },
        actor
      )
    ).rejects.toThrow();
  });

  it("cancelExpense: يُحوّل expense إلى CANCELLED + يعكس النقد + قيد ADJUST سالب", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "0" }, actor);
    const r = await createExpense(
      { branchId: 1, shiftId, category: "MARKETING", amount: "80000", paymentMethod: "CASH" },
      actor
    );

    await cancelExpense(r.expenseId, actor);

    const exp = (await db().select().from(s.expenses).where(eq(s.expenses.id, r.expenseId)))[0];
    expect(exp.status).toBe("CANCELLED");

    const origRc = (await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId)))[0];
    expect(origRc.status).toBe("REVERSED");

    // قبض تعويضي IN يُلغي الأثر الصافي على الصندوق
    const inn = await db().select().from(s.receipts).where(eq(s.receipts.direction, "IN"));
    expect(inn).toHaveLength(1);
    expect(inn[0].amount).toBe("80000.00");
    expect(inn[0].paymentMethod).toBe("CASH");
    expect(Number(inn[0].shiftId)).toBe(shiftId);

    // قيد ADJUST سالب
    const adj = await entries("ADJUST");
    expect(adj).toHaveLength(1);
    expect(adj[0].amount).toBe("-80000.00");

    // إغلاق الوردية: المتوقع = 0 (الصرف ألغي بالتعويض)
    const closed = await closeShift({ shiftId, countedCash: "0" }, actor);
    expect(closed.expectedCash).toBe("0.00");
    expect(closed.variance).toBe("0.00");
  });

  it("cancelExpense بعد إغلاق الوردية يُرفض", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "0" }, actor);
    const r = await createExpense(
      { branchId: 1, shiftId, category: "RENT", amount: "100", paymentMethod: "CASH", description: "x" },
      actor
    );
    await closeShift({ shiftId, countedCash: "-100" }, actor);
    await expect(cancelExpense(r.expenseId, actor)).rejects.toThrow();
  });

  it("cancelExpense على مصروف ملغى يُرفض", async () => {
    await openShift({ branchId: 1, openingBalance: "0" }, actor); // shift-gate
    const r = await createExpense(
      { branchId: 1, category: "OTHER", amount: "50", paymentMethod: "CASH", description: "تجربة" },
      actor
    );
    await cancelExpense(r.expenseId, actor);
    await expect(cancelExpense(r.expenseId, actor)).rejects.toThrow();
  });

  it("مصروف غير نقدي (تحويل) لا يؤثر على نقد الصندوق", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100000" }, actor);
    await createExpense(
      { branchId: 1, shiftId, category: "UTILITIES", amount: "25000", paymentMethod: "TRANSFER", description: "كهرباء" },
      actor
    );
    const closed = await closeShift({ shiftId, countedCash: "100000" }, actor);
    expect(closed.expectedCash).toBe("100000.00"); // لم يتأثر النقد
    expect(closed.variance).toBe("0.00");
  });
});

/**
 * shift-gate-cash slice: المصاريف النقدية تَمسّ صندوق الوردية ⇒ لا تُحفَظ بـshiftId=null
 * وإلّا تختفي من Z-report (computeExpectedCash يفلتر بـeq(receipts.shiftId, shiftId)).
 * المصاريف غير النقدية (TRANSFER/CARD/WALLET/CHECK) لا تَمسّ الصندوق فتبقى مسموحة.
 */
describe("إنفاذ الوردية النقدية (shift-gate) للمصاريف", () => {
  it("مصروف نقدي بلا وردية مفتوحة ⇒ يُرفض بـPRECONDITION_FAILED", async () => {
    await expect(
      createExpense(
        { branchId: 1, category: "TRANSPORT", amount: "20000", paymentMethod: "CASH", description: "أجور نقل" },
        actor
      )
    ).rejects.toThrow(/افتح وردية/);

    // لا expense ولا receipt كُتب (rollback ذرّي).
    const exps = await db().select().from(s.expenses);
    expect(exps).toHaveLength(0);
    const recs = await db().select().from(s.receipts);
    expect(recs).toHaveLength(0);
  });

  it("مصروف نقدي مع وردية مفتوحة ⇒ يُملأ shiftId تلقائياً ويُخصم من Z-report", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "500000" }, actor);
    const r = await createExpense(
      { branchId: 1, category: "SUPPLIES", amount: "75000", paymentMethod: "CASH", description: "حبر" },
      actor
    );
    const exp = (await db().select().from(s.expenses).where(eq(s.expenses.id, r.expenseId)))[0];
    expect(Number(exp.shiftId)).toBe(shiftId);
    const rc = (await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId!)))[0];
    expect(Number(rc.shiftId)).toBe(shiftId);

    const closed = await closeShift({ shiftId, countedCash: "425000" }, actor);
    expect(closed.expectedCash).toBe("425000.00"); // 500k − 75k
    expect(closed.variance).toBe("0.00");
  });

  it("مصروف غير نقدي (CHECK) بلا وردية ⇒ يَنجح بـshiftId=null", async () => {
    const r = await createExpense(
      { branchId: 1, category: "RENT", amount: "1200000", paymentMethod: "CHECK", description: "إيجار سنوي بصكّ" },
      actor
    );
    const exp = (await db().select().from(s.expenses).where(eq(s.expenses.id, r.expenseId)))[0];
    expect(exp.shiftId).toBeNull();
    expect(exp.paymentMethod).toBe("CHECK");
    // الدفتر سُجِّل
    const out = await entries("PAYMENT_OUT");
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe("1200000.00");
  });

  it("مصاريف نقدية متعدّدة كلها تَنعكس في Z-report (لا أحدها يَختفي)", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "1000000" }, actor);
    await createExpense({ branchId: 1, category: "TRANSPORT", amount: "50000", paymentMethod: "CASH", description: "نقل" }, actor);
    await createExpense({ branchId: 1, category: "UTILITIES", amount: "30000", paymentMethod: "CASH", description: "كهرباء" }, actor);
    await createExpense({ branchId: 1, category: "MARKETING", amount: "20000", paymentMethod: "CASH", description: "إعلان" }, actor);
    // مصروف بنكي وسطها — لا يَخصم من النقد.
    await createExpense({ branchId: 1, category: "RENT", amount: "999999", paymentMethod: "TRANSFER", description: "إيجار" }, actor);

    const closed = await closeShift({ shiftId, countedCash: "900000" }, actor);
    expect(closed.expectedCash).toBe("900000.00"); // 1,000,000 − (50k+30k+20k)
    expect(closed.variance).toBe("0.00");
  });
});
