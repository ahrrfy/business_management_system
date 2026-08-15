/**
 * شريحة P2/ش٣: ميزان مراجعة ودفتر أستاذ حقيقيان من journalEntries/journalLines.
 *
 * يثبت هذا الملف أن التقارير لا تعود إلى accountingEntries المالية المبسّطة، وأن كل مبلغٍ
 * يظهر في الافتتاح/الحركة/الختام مع عزل الفرع وبوابة التقارير الحمراء.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { CHART_ACCOUNTS } from "../accounting/chartSeed";
import { getGeneralLedger } from "../reports/generalLedger";
import { getTrialBalance } from "../reports/trialBalance";

const TEST_CYCLE_ID = "11111111-1111-4111-8111-111111111111";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "journalLines",
    "journalEntries",
    "accountingEntries",
    "doubleEntrySettings",
    "accounts",
    "invoices",
    "users",
    "branches",
  ]) {
    await d.execute(sql.raw(`DELETE FROM \`${table}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

type EntrySeed = {
  journalId: number;
  entryId: number;
  date: string;
  branchId: number | null;
  entryType?: (typeof s.accountingEntries.$inferInsert)["entryType"];
  invoiceId?: number;
  notes?: string;
  status?: "POSTED" | "UNMAPPED";
  cycleId?: string;
  lines?: Array<{ role: string; debit?: string; credit?: string }>;
};

async function seedJournal(input: EntrySeed) {
  await db()
    .insert(s.accountingEntries)
    .values({
      id: input.entryId,
      entryType: input.entryType ?? "ADJUST",
      branchId: input.branchId,
      invoiceId: input.invoiceId,
      revenue: "0.00",
      cost: "0.00",
      profit: "0.00",
      amount: "0.00",
      entryDate: new Date(`${input.date}T00:00:00Z`),
      notes: input.notes,
    });
  await db()
    .insert(s.journalEntries)
    .values({
      id: input.journalId,
      entryId: input.entryId,
      entryDate: new Date(`${input.date}T00:00:00Z`),
      branchId: input.branchId,
      cycleId: input.cycleId ?? TEST_CYCLE_ID,
      status: input.status ?? "POSTED",
      unmappedReason:
        input.status === "UNMAPPED" ? "نوع قيد غير مخطط للاختبار" : null,
    });
  if (input.status !== "UNMAPPED" && input.lines?.length) {
    await db()
      .insert(s.journalLines)
      .values(
        input.lines.map((line) => ({
          journalId: input.journalId,
          role: line.role,
          debit: line.debit ?? "0.00",
          credit: line.credit ?? "0.00",
        })),
      );
  }
}

async function seedBase() {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "double-entry-admin",
        name: "أدمن",
        role: "admin",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 2,
        openId: "double-entry-manager",
        name: "مدير الرئيسي",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 3,
        openId: "double-entry-cashier",
        name: "كاشير",
        role: "cashier",
        loginMethod: "local",
        branchId: 1,
      },
    ]);
  await db()
    .insert(s.accounts)
    .values(
      CHART_ACCOUNTS.map((a) => ({
        id: a.id,
        code: a.code,
        name: a.name,
        type: a.type,
        parentId: a.parentId,
        systemRole: a.systemRole,
        sortOrder: a.sortOrder,
      })),
    );
  await db()
    .insert(s.doubleEntrySettings)
    .values({
      id: 1,
      mode: "SHADOW",
      shadowStartedAt: new Date("2026-01-01T00:00:00Z"),
      shadowCycleId: TEST_CYCLE_ID,
    });
  await db().insert(s.invoices).values({
    id: 50,
    invoiceNumber: "INV-DOUBLE-50",
    sourceType: "POS",
    branchId: 1,
    subtotal: "50.00",
    total: "50.00",
  });

  // افتتاح قبل الفترة: AR مدين 100 / رصيد افتتاحي دائن 100.
  await seedJournal({
    journalId: 101,
    entryId: 1001,
    date: "2026-01-15",
    branchId: 1,
    entryType: "OPENING",
    lines: [
      { role: "AR", debit: "100.00" },
      { role: "OPENING_EQUITY", credit: "100.00" },
    ],
  });
  // بيع داخل الفترة: AR +50 / إيراد 50، مربوطٌ بفاتورة المصدر.
  await seedJournal({
    journalId: 102,
    entryId: 1002,
    date: "2026-02-05",
    branchId: 1,
    entryType: "SALE",
    invoiceId: 50,
    notes: "بيع آجل",
    lines: [
      { role: "AR", debit: "50.00" },
      { role: "SALES_STATIONERY", credit: "50.00" },
    ],
  });
  // تحصيل داخل الفترة: سطران AR دائن (لا نفترض تفرّد الدور داخل القيد).
  await seedJournal({
    journalId: 103,
    entryId: 1003,
    date: "2026-02-06",
    branchId: 1,
    entryType: "PAYMENT_IN",
    notes: "تحصيل على دفعتين",
    lines: [
      { role: "CASH", debit: "50.00" },
      { role: "AR", credit: "20.00" },
      { role: "AR", credit: "30.00" },
    ],
  });
  // فجوة مرئية في نفس نطاق التقرير، لا تدخل المجاميع.
  await seedJournal({
    journalId: 104,
    entryId: 1004,
    date: "2026-02-07",
    branchId: 1,
    entryType: "GIFT_OUT",
    status: "UNMAPPED",
  });
  // قيد فرع آخر يجب ألا يتسرّب لمدير الرئيسي.
  await seedJournal({
    journalId: 105,
    entryId: 1005,
    date: "2026-02-08",
    branchId: 2,
    entryType: "SALE",
    lines: [
      { role: "AR", debit: "70.00" },
      { role: "SALES_STATIONERY", credit: "70.00" },
    ],
  });
  // بعد نهاية الفترة — لا يدخل الحركة أو الختام.
  await seedJournal({
    journalId: 106,
    entryId: 1006,
    date: "2026-03-01",
    branchId: 1,
    entryType: "SALE",
    lines: [
      { role: "AR", debit: "999.00" },
      { role: "SALES_STATIONERY", credit: "999.00" },
    ],
  });
}

function makeCtx(user: any) {
  return {
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
    user,
  } as any;
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("ميزان المراجعة المزدوج", () => {
  it("يحسب الافتتاح والحركة والختام لكل حساب ويثبت توازن الأعمدة", async () => {
    const report = await getTrialBalance({
      from: "2026-02-01",
      to: "2026-02-28",
      branchId: 1,
    });

    expect(report.mode).toBe("SHADOW");
    expect(report.cycleId).toBe(TEST_CYCLE_ID);
    expect(report.shadowStartedAt).toBe("2026-01-01 00:00:00");
    expect(report.unmappedCount).toBe(1);
    expect(report.totals).toMatchObject({
      openingDebit: "100.00",
      openingCredit: "100.00",
      periodDebit: "100.00",
      periodCredit: "100.00",
      closingDebit: "150.00",
      closingCredit: "150.00",
      openingDifference: "0.00",
      periodDifference: "0.00",
      closingDifference: "0.00",
      isBalanced: true,
    });

    const ar = report.rows.find((row) => row.systemRole === "AR");
    expect(ar).toMatchObject({
      code: "1300",
      openingDebit: "100.00",
      openingCredit: "0.00",
      periodDebit: "50.00",
      periodCredit: "50.00",
      closingDebit: "100.00",
      closingCredit: "0.00",
    });
    const sales = report.rows.find(
      (row) => row.systemRole === "SALES_STATIONERY",
    );
    expect(sales).toMatchObject({
      periodDebit: "0.00",
      periodCredit: "50.00",
      closingDebit: "0.00",
      closingCredit: "50.00",
    });
    expect(report.rows.some((row) => row.code === "1000")).toBe(false);
  });

  it("لا يُسقط دوراً غير مربوط من المجاميع بل يعرضه كخلل صريح", async () => {
    await seedJournal({
      journalId: 107,
      entryId: 1007,
      date: "2026-02-10",
      branchId: 1,
      lines: [
        { role: "UNSEEDED_ASSET", debit: "12.00" },
        { role: "CASH", credit: "12.00" },
      ],
    });

    const report = await getTrialBalance({
      from: "2026-02-01",
      to: "2026-02-28",
      branchId: 1,
    });
    const unknown = report.rows.find(
      (row) => row.systemRole === "UNSEEDED_ASSET",
    );
    expect(unknown).toMatchObject({
      accountId: null,
      isUnmappedAccount: true,
      periodDebit: "12.00",
      periodCredit: "0.00",
    });
    expect(report.unmappedAccountRoles).toEqual(["UNSEEDED_ASSET"]);
    expect(report.totals.isBalanced).toBe(true);
  });

  it("يضمّ حدّي الفترة، ويستبعد القيد العام من تقرير الفرع، ولا يخفي حساباً غير نشط له تاريخ", async () => {
    await db()
      .update(s.accounts)
      .set({ isActive: false })
      .where(sql`${s.accounts.id} = 5`);
    await seedJournal({
      journalId: 108,
      entryId: 1008,
      date: "2026-02-05",
      branchId: null,
      lines: [
        { role: "AR", debit: "333.00" },
        { role: "OPENING_EQUITY", credit: "333.00" },
      ],
    });

    const oneDay = await getTrialBalance({
      from: "2026-02-05",
      to: "2026-02-05",
      branchId: 1,
    });
    const ar = oneDay.rows.find((row) => row.systemRole === "AR");
    expect(ar).toMatchObject({
      periodDebit: "50.00",
      periodCredit: "0.00",
      closingDebit: "150.00",
    });
    expect(oneDay.totals.periodDebit).toBe("50.00");
    expect(oneDay.totals.periodCredit).toBe("50.00");
  });

  it("يكشف الفرق الحقيقي إذا أُفسدت أسطر القاعدة ولا يوازن التقرير اشتقاقياً", async () => {
    await db().insert(s.journalLines).values({
      journalId: 102,
      role: "AR",
      debit: "0.01",
      credit: "0.00",
    });
    const report = await getTrialBalance({
      from: "2026-02-01",
      to: "2026-02-28",
      branchId: 1,
    });
    expect(report.totals.periodDifference).toBe("0.01");
    expect(report.totals.closingDifference).toBe("0.01");
    expect(report.totals.isBalanced).toBe(false);
  });

  it("يفصل فجوات ما قبل الفترة عن فجوات الحركة كي لا يبدو الافتتاح مكتملاً كذباً", async () => {
    await seedJournal({
      journalId: 110,
      entryId: 1010,
      date: "2026-01-20",
      branchId: 1,
      status: "UNMAPPED",
    });

    const report = await getTrialBalance({
      from: "2026-02-01",
      to: "2026-02-28",
      branchId: 1,
    });
    expect(report.openingUnmappedCount).toBe(1);
    expect(report.periodUnmappedCount).toBe(1);
    expect(report.unmappedCount).toBe(2);
  });

  it("يعزل يوميات دورة SHADOW موقوفة عن الدورة الحالية", async () => {
    await seedJournal({
      journalId: 112,
      entryId: 1012,
      date: "2026-02-10",
      branchId: 1,
      cycleId: "22222222-2222-4222-8222-222222222222",
      lines: [
        { role: "AR", debit: "500.00" },
        { role: "OPENING_EQUITY", credit: "500.00" },
      ],
    });

    const report = await getTrialBalance({
      from: "2026-02-01",
      to: "2026-02-28",
      branchId: 1,
    });
    expect(report.totals.periodDebit).toBe("100.00");
    expect(report.totals.periodCredit).toBe("100.00");
  });
});

describe("دفتر الأستاذ المزدوج", () => {
  it("يعرض حساباً واحداً زمنياً برصيد جارٍ صحيح ويربط كل حركة بمصدرها", async () => {
    const report = await getGeneralLedger({
      accountId: 5, // AR
      from: "2026-02-01",
      to: "2026-02-28",
      branchId: 1,
      limit: 50,
      offset: 0,
    });

    expect(report.mode).toBe("SHADOW");
    expect(report.cycleId).toBe(TEST_CYCLE_ID);
    expect(report.account).toMatchObject({
      id: 5,
      code: "1300",
      systemRole: "AR",
    });
    expect(report.openingBalance).toBe("100.00");
    expect(report.openingSide).toBe("DEBIT");
    expect(report.total).toBe(2);
    expect(report.rows).toHaveLength(2);
    expect(report.rows[0]).toMatchObject({
      entryId: 1002,
      entryDate: "2026-02-05",
      debit: "50.00",
      credit: "0.00",
      runningBalance: "150.00",
      runningSide: "DEBIT",
      invoiceId: 50,
      invoiceNumber: "INV-DOUBLE-50",
    });
    expect(report.rows[1]).toMatchObject({
      entryId: 1003,
      entryDate: "2026-02-06",
      debit: "0.00",
      credit: "50.00",
      runningBalance: "100.00",
      runningSide: "DEBIT",
    });
    expect(report.totals).toEqual({
      debit: "50.00",
      credit: "50.00",
      closingBalance: "100.00",
      closingSide: "DEBIT",
    });
    expect(report.unmappedCount).toBe(1);
  });

  it("يصنّف لقطة SHADOW_OPENING افتتاحاً دائماً ولا يضخّم حركة يوم القطع", async () => {
    await db()
      .insert(s.journalEntries)
      .values({
        id: 111,
        entryId: null,
        sourceType: "SHADOW_OPENING",
        sourceKey: `SHADOW_OPENING:${TEST_CYCLE_ID}:1`,
        cycleId: TEST_CYCLE_ID,
        entryDate: new Date("2026-02-01T00:00:00Z"),
        branchId: 1,
        status: "POSTED",
      });
    await db()
      .insert(s.journalLines)
      .values([
        { journalId: 111, role: "AR", debit: "25.00", credit: "0.00" },
        { journalId: 111, role: "CAPITAL", debit: "0.00", credit: "25.00" },
      ]);

    const report = await getGeneralLedger({
      accountId: 5,
      from: "2026-02-01",
      to: "2026-02-28",
      branchId: 1,
    });
    expect(report.openingBalance).toBe("125.00");
    expect(report.total).toBe(2);
    expect(report.rows.some((row) => row.sourceType === "SHADOW_OPENING")).toBe(
      false,
    );
    expect(report.totals).toMatchObject({
      debit: "50.00",
      credit: "50.00",
      closingBalance: "125.00",
    });

    const trial = await getTrialBalance({
      from: "2026-02-01",
      to: "2026-02-28",
      branchId: 1,
    });
    expect(trial.totals).toMatchObject({
      openingDebit: "125.00",
      openingCredit: "125.00",
      periodDebit: "100.00",
      periodCredit: "100.00",
    });
    expect(trial.rows.find((row) => row.systemRole === "AR")).toMatchObject({
      openingDebit: "125.00",
      periodDebit: "50.00",
      periodCredit: "50.00",
    });
  });

  it("يرفض تقرير الفرع عند وجود افتتاح عالمي ويتيح الحقيقة على مستوى الشركة", async () => {
    await db()
      .insert(s.journalEntries)
      .values({
        id: 113,
        entryId: null,
        sourceType: "SHADOW_OPENING",
        sourceKey: `SHADOW_OPENING:${TEST_CYCLE_ID}:GLOBAL`,
        cycleId: TEST_CYCLE_ID,
        entryDate: new Date("2026-01-01T00:00:00Z"),
        branchId: null,
        status: "POSTED",
      });
    await db()
      .insert(s.journalLines)
      .values([
        { journalId: 113, role: "AR", debit: "40.00", credit: "0.00" },
        { journalId: 113, role: "CAPITAL", debit: "0.00", credit: "40.00" },
      ]);

    await expect(
      getTrialBalance({
        from: "2026-02-01",
        to: "2026-02-28",
        branchId: 1,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      getGeneralLedger({
        accountId: 5,
        from: "2026-02-01",
        to: "2026-02-28",
        branchId: 1,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await db()
      .update(s.journalEntries)
      .set({ status: "UNMAPPED" })
      .where(eq(s.journalEntries.id, 113));
    await expect(
      getTrialBalance({
        from: "2026-02-01",
        to: "2026-02-28",
        branchId: 1,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      getGeneralLedger({
        accountId: 5,
        from: "2026-02-01",
        to: "2026-02-28",
        branchId: 1,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await db()
      .update(s.journalEntries)
      .set({ status: "POSTED" })
      .where(eq(s.journalEntries.id, 113));

    const company = await getGeneralLedger({
      accountId: 5,
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(company.openingBalance).toBe("140.00");
    expect(company.openingSide).toBe("DEBIT");
  });

  it("يحافظ على الرصيد الجاري الصحيح عند ترقيم الصفحات", async () => {
    const secondPage = await getGeneralLedger({
      accountId: 5,
      from: "2026-02-01",
      to: "2026-02-28",
      branchId: 1,
      limit: 1,
      offset: 1,
    });
    expect(secondPage.rows).toHaveLength(1);
    expect(secondPage.rows[0].entryId).toBe(1003);
    expect(secondPage.rows[0].runningBalance).toBe("100.00");
  });

  it("يحذّر من فجوات سابقة قد تجعل الرصيد الافتتاحي ناقصاً", async () => {
    await seedJournal({
      journalId: 110,
      entryId: 1010,
      date: "2026-01-20",
      branchId: 1,
      status: "UNMAPPED",
    });
    const report = await getGeneralLedger({
      accountId: 5,
      from: "2026-02-01",
      to: "2026-02-28",
      branchId: 1,
    });
    expect(report.openingUnmappedCount).toBe(1);
    expect(report.periodUnmappedCount).toBe(1);
    expect(report.unmappedCount).toBe(2);
  });

  it("يرفض حساب الرأس غير القابل للترحيل", async () => {
    await expect(
      getGeneralLedger({
        accountId: 1,
        from: "2026-02-01",
        to: "2026-02-28",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يعرض انتقال الرصيد من مدين إلى دائن، ويعيد صفحة فارغة بعد آخر حركة", async () => {
    await seedJournal({
      journalId: 109,
      entryId: 1009,
      date: "2026-02-09",
      branchId: 1,
      lines: [
        { role: "CASH", debit: "200.00" },
        { role: "AR", credit: "200.00" },
      ],
    });
    const report = await getGeneralLedger({
      accountId: 5,
      from: "2026-02-01",
      to: "2026-02-28",
      branchId: 1,
      limit: 50,
      offset: 0,
    });
    expect(report.rows.at(-1)).toMatchObject({
      entryId: 1009,
      runningBalance: "100.00",
      runningSide: "CREDIT",
    });
    expect(report.totals).toMatchObject({
      closingBalance: "100.00",
      closingSide: "CREDIT",
    });

    const beyond = await getGeneralLedger({
      accountId: 5,
      from: "2026-02-01",
      to: "2026-02-28",
      branchId: 1,
      limit: 50,
      offset: 999,
    });
    expect(beyond.rows).toEqual([]);
    expect(beyond.total).toBe(3);
    expect(beyond.totals.closingSide).toBe("CREDIT");
  });

  it("يصرّح بأوضاع OFF وACTIVE كما هي دون تغيير الأرقام", async () => {
    await db().delete(s.doubleEntrySettings);
    const off = await getGeneralLedger({
      accountId: 5,
      from: "2026-02-01",
      to: "2026-02-28",
      branchId: 1,
    });
    expect(off.mode).toBe("OFF");
    expect(off.total).toBe(0);

    await db().insert(s.doubleEntrySettings).values({
      id: 1,
      mode: "ACTIVE",
      shadowCycleId: TEST_CYCLE_ID,
    });
    const active = await getTrialBalance({
      from: "2026-02-01",
      to: "2026-02-28",
      branchId: 1,
    });
    expect(active.mode).toBe("ACTIVE");
    expect(active.totals.isBalanced).toBe(true);
  });

  it("يرفض نطاقاً قبل القطع ويصرّح بتاريخ الإتاحة دون خلط P&L تاريخي", async () => {
    await db()
      .update(s.doubleEntrySettings)
      .set({ shadowStartedAt: new Date("2026-07-14T21:00:00.000Z") })
      .where(sql`${s.doubleEntrySettings.id} = 1`);

    await expect(
      getTrialBalance({ from: "2026-07-14", to: "2026-07-31" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      getGeneralLedger({
        accountId: 5,
        from: "2026-07-14",
        to: "2026-07-31",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const report = await getTrialBalance({
      from: "2026-07-15",
      to: "2026-07-31",
    });
    expect(report.availableFrom).toBe("2026-07-15");
    expect(report.totals.periodDebit).toBe("0.00");
    expect(report.totals.openingDebit).toBe("0.00");
  });
});

describe("راوتر التقارير — الصلاحيات وعزل الفرع", () => {
  it("مدير الفرع يُقيَّد بفرعه، وطلب فرع آخر مرفوض صراحةً", async () => {
    const manager = (
      await db()
        .select()
        .from(s.users)
        .where(sql`${s.users.id} = 2`)
        .limit(1)
    )[0];
    const caller = appRouter.createCaller(makeCtx(manager));

    await expect(
      caller.reports.doubleEntryReportAvailability(),
    ).resolves.toEqual({
      mode: "SHADOW",
      cycleId: TEST_CYCLE_ID,
      availableFrom: "2026-01-01",
      shadowStartedAt: "2026-01-01 00:00:00",
    });

    const scoped = await caller.reports.trialBalance({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(scoped.totals.periodDebit).toBe("100.00");
    await expect(
      caller.reports.trialBalance({
        from: "2026-02-01",
        to: "2026-02-28",
        branchId: 2,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("الكاشير لا يقرأ التقرير، والنطاق المعكوس يُرفض قبل الخدمة", async () => {
    const cashier = (
      await db()
        .select()
        .from(s.users)
        .where(sql`${s.users.id} = 3`)
        .limit(1)
    )[0];
    const caller = appRouter.createCaller(makeCtx(cashier));
    await expect(
      caller.reports.doubleEntryReportAvailability(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.reports.trialBalance({
        from: "2026-02-01",
        to: "2026-02-28",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const admin = (
      await db()
        .select()
        .from(s.users)
        .where(sql`${s.users.id} = 1`)
        .limit(1)
    )[0];
    const adminCaller = appRouter.createCaller(makeCtx(admin));
    await expect(
      adminCaller.reports.generalLedger({
        accountId: 5,
        from: "2026-03-01",
        to: "2026-02-01",
        limit: 20,
        offset: 0,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      adminCaller.reports.trialBalance({
        from: "2026-02-31",
        to: "2026-03-01",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
