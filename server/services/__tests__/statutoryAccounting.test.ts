import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { appRouter } from "../../routers";
import { requireCompleteExport } from "../../routers/statutoryAccountingRouter";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  approveStatutoryProfile,
  createStatutoryProfile,
  getStatutoryActivationReadiness,
  replaceStatutoryAccounts,
  replaceStatutoryMappings,
} from "../accounting/statutoryAccounting";
import { canActivate } from "../accounting/activationGate";
import { writeJournal } from "../accounting/journalStore";
import type { JournalLine } from "../accounting/postingEngine";
import {
  getStatutoryAccountLedger,
  getStatutoryAccountLedgerExport,
  getStatutoryBalanceSheet,
  getStatutoryGeneralJournal,
  getStatutoryGeneralJournalExport,
  getStatutoryIncomeStatement,
  getStatutoryAccountantPack,
  getStatutoryTrialBalance,
  requireCompleteAccountantPackJournal,
} from "../accounting/statutoryReports";
import { withTx } from "../tx";

const ACTOR_ID = 1;
const CURRENT_CYCLE_ID = "statutory-test-cycle-current";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

async function seedFoundation() {
  await db().insert(s.users).values({
    id: ACTOR_ID,
    openId: "statutory-test-admin",
    name: "مدير الاختبار",
    role: "admin",
    loginMethod: "local",
  });
  await db().insert(s.doubleEntrySettings).values({
    id: 1,
    mode: "ACTIVE",
    shadowCycleId: CURRENT_CYCLE_ID,
  });
  await db().insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "الثاني", code: "SECOND", type: "SALES" },
  ]);
  await db().insert(s.users).values({
    id: 2,
    openId: "statutory-test-manager",
    name: "مدير الفرع",
    role: "manager",
    branchId: 1,
    loginMethod: "local",
  });
  await db().insert(s.accounts).values([
    {
      code: "1000",
      name: "الصندوق",
      type: "ASSET",
      systemRole: "CASH",
      sortOrder: 1,
    },
    {
      code: "1100",
      name: "ذمم العملاء",
      type: "ASSET",
      systemRole: "AR",
      sortOrder: 2,
    },
    {
      code: "2100",
      name: "ذمم الموردين",
      type: "LIABILITY",
      systemRole: "AP",
      sortOrder: 3,
    },
    {
      code: "3100",
      name: "رأس المال الافتتاحي",
      type: "EQUITY",
      systemRole: "OPENING_EQUITY",
      sortOrder: 4,
    },
    {
      code: "4100",
      name: "مبيعات القرطاسية",
      type: "REVENUE",
      systemRole: "SALES_STATIONERY",
      sortOrder: 5,
    },
    {
      code: "5100",
      name: "مصروفات تشغيلية",
      type: "EXPENSE",
      systemRole: "OPERATING_EXPENSE",
      sortOrder: 6,
    },
  ]);
}

async function approveCompleteProfile(version = 1, effectiveFrom = "2026-08-01") {
  const internal = await db().select().from(s.accounts);
  let profileId = 0;
  await withTx(async (tx) => {
    profileId = (
      await createStatutoryProfile(
        tx,
        {
          profileKey: "IRAQI_STATUTORY",
          version,
          name: `دليل الاختبار المصادق ${version}`,
          authorityReference: `كتاب الاختبار ${version}/2026`,
          effectiveFrom,
        },
        ACTOR_ID,
      )
    ).id;
    await replaceStatutoryAccounts(tx, profileId, [
      {
        code: "1",
        name: "الأصول",
        type: "ASSET",
        normalBalance: "DEBIT",
        isPosting: false,
      },
      {
        code: "110",
        name: "الصندوق النظامي",
        type: "ASSET",
        normalBalance: "DEBIT",
        parentCode: "1",
      },
      {
        code: "111",
        name: "ذمم العملاء النظامية",
        type: "ASSET",
        normalBalance: "DEBIT",
        parentCode: "1",
      },
      {
        code: "2",
        name: "الالتزامات",
        type: "LIABILITY",
        normalBalance: "CREDIT",
        isPosting: false,
      },
      {
        code: "211",
        name: "ذمم الموردين النظامية",
        type: "LIABILITY",
        normalBalance: "CREDIT",
        parentCode: "2",
      },
      {
        code: "3",
        name: "حقوق الملكية",
        type: "EQUITY",
        normalBalance: "CREDIT",
        isPosting: false,
      },
      {
        code: "311",
        name: "رأس المال النظامي",
        type: "EQUITY",
        normalBalance: "CREDIT",
        parentCode: "3",
      },
      {
        code: "4",
        name: "الإيرادات",
        type: "REVENUE",
        normalBalance: "CREDIT",
        isPosting: false,
      },
      {
        code: "411",
        name: "مبيعات نظامية",
        type: "REVENUE",
        normalBalance: "CREDIT",
        parentCode: "4",
      },
      {
        code: "5",
        name: "المصروفات",
        type: "EXPENSE",
        normalBalance: "DEBIT",
        isPosting: false,
      },
      {
        code: "511",
        name: "مصروفات تشغيلية نظامية",
        type: "EXPENSE",
        normalBalance: "DEBIT",
        parentCode: "5",
      },
    ]);
    const statutory = await tx
      .select()
      .from(s.statutoryAccounts)
      .where(eq(s.statutoryAccounts.profileId, profileId));
    const statutoryByCode = new Map(statutory.map((row) => [row.code, Number(row.id)]));
    const internalByRole = new Map(
      internal.map((row) => [row.systemRole, Number(row.id)]),
    );
    await replaceStatutoryMappings(
      tx,
      profileId,
      [
        {
          internalAccountId: internalByRole.get("CASH")!,
          statutoryAccountId: statutoryByCode.get("110")!,
        },
        {
          internalAccountId: internalByRole.get("AR")!,
          statutoryAccountId: statutoryByCode.get("111")!,
        },
        {
          internalAccountId: internalByRole.get("AP")!,
          statutoryAccountId: statutoryByCode.get("211")!,
        },
        {
          internalAccountId: internalByRole.get("OPENING_EQUITY")!,
          statutoryAccountId: statutoryByCode.get("311")!,
        },
        {
          internalAccountId: internalByRole.get("SALES_STATIONERY")!,
          statutoryAccountId: statutoryByCode.get("411")!,
        },
        {
          internalAccountId: internalByRole.get("OPERATING_EXPENSE")!,
          statutoryAccountId: statutoryByCode.get("511")!,
        },
      ],
      ACTOR_ID,
    );
    await approveStatutoryProfile(
      tx,
      {
        profileId,
        accountantName: "مراقب حسابات الاختبار",
        approvalReference: `محضر مصادقة ${version}/2026`,
      },
      ACTOR_ID,
    );
  });
  return profileId;
}

async function postJournal(
  date: string,
  branchId: number,
  lines: JournalLine[],
  cycleId = CURRENT_CYCLE_ID,
) {
  const entryResult = await db().insert(s.accountingEntries).values({
    entryType: "ADJUST",
    branchId,
    entryDate: new Date(`${date}T00:00:00.000Z`),
    amount: "0.00",
    revenue: "0.00",
    cost: "0.00",
    profit: "0.00",
    taxAmount: "0.00",
  });
  const entryId = extractInsertId(entryResult);
  await withTx((tx) =>
    writeJournal(tx, entryId, new Date(`${date}T00:00:00.000Z`), branchId, lines, { cycleId }),
  );
  return entryId;
}

function makeCtx(user: unknown) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any;
}

describe("statutory accounting compliance", () => {
  it("يحجب بوابة ACTIVE بوضوح قبل وجود إصدار نظامي معتمد", async () => {
    await seedFoundation();
    const readiness = await getStatutoryActivationReadiness();
    expect(readiness.ok).toBe(false);
    expect(readiness.activeProfile).toBeNull();

    const gate = await canActivate({
      now: new Date("2026-08-31T00:00:00.000Z"),
      requireStatutoryCompliance: true,
    });
    expect(gate.blockers.some((item) => item.key === "STATUTORY_COMPLIANCE")).toBe(true);
  });

  it("يثبت الحساب التشغيلي والنظامي على السطر ويجمع التقرير من اللقطة", async () => {
    await seedFoundation();
    const profileId = await approveCompleteProfile();
    const readiness = await getStatutoryActivationReadiness();
    expect(readiness.ok).toBe(true);
    expect(readiness.mappedAccounts).toBe(6);

    await postJournal("2026-07-20", 1, [
      { role: "CASH", debit: "200.00", credit: "0.00" },
      { role: "OPENING_EQUITY", debit: "0.00", credit: "200.00" },
    ]);
    await postJournal("2026-07-25", 1, [
      { role: "AR", debit: "25.00", credit: "0.00" },
      { role: "SALES_STATIONERY", debit: "0.00", credit: "25.00" },
    ]);
    await postJournal("2026-07-26", 1, [
      { role: "AR", debit: "700.00", credit: "0.00" },
      { role: "SALES_STATIONERY", debit: "0.00", credit: "700.00" },
    ], "statutory-test-cycle-retired");
    await postJournal("2026-08-15", 1, [
      { role: "AR", debit: "125.00", credit: "0.00" },
      { role: "SALES_STATIONERY", debit: "0.00", credit: "125.00" },
    ]);
    await postJournal("2026-08-20", 1, [
      { role: "OPERATING_EXPENSE", debit: "30.00", credit: "0.00" },
      { role: "AP", debit: "0.00", credit: "30.00" },
    ]);
    await postJournal("2026-08-25", 1, [
      { role: "SALES_STATIONERY", debit: "10.00", credit: "0.00" },
      { role: "AR", debit: "0.00", credit: "10.00" },
    ]);

    const lines = await db().select().from(s.journalLines);
    expect(lines).toHaveLength(12);
    expect(lines.every((line) => Number(line.statutoryProfileId) === profileId)).toBe(true);
    expect(lines.every((line) => line.accountId != null && line.statutoryAccountId != null)).toBe(true);

    const report = await getStatutoryTrialBalance({
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(report.available).toBe(true);
    if (!report.available) throw new Error(report.reason);
    expect(report.rows).toHaveLength(4);
    expect(report.totals.debit).toBe("165.00");
    expect(report.totals.credit).toBe("165.00");
    expect(report.totals.difference).toBe("0.00");

    const income = await getStatutoryIncomeStatement({
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(income.available).toBe(true);
    if (!income.available) throw new Error(income.reason);
    expect(income.totals).toEqual({
      revenue: "115.00",
      expenses: "30.00",
      netIncome: "85.00",
    });
    expect(income.revenues.map((row) => row.code)).toEqual(["411"]);

    const position = await getStatutoryBalanceSheet({ asOf: "2026-08-31" });
    expect(position.available).toBe(true);
    if (!position.available) throw new Error(position.reason);
    expect(position.totals.assets).toBe("340.00");
    expect(position.totals.liabilities).toBe("30.00");
    expect(position.totals.equity).toBe("200.00");
    expect(position.totals.unclosedResult).toBe("110.00");
    expect(position.totals.liabilitiesAndEquity).toBe("340.00");
    expect(position.totals.difference).toBe("0.00");

    const receivable = report.rows.find((row) => row.code === "111");
    expect(receivable).toBeDefined();
    const ledger = await getStatutoryAccountLedger({
      from: "2026-08-01",
      to: "2026-08-31",
      accountId: receivable!.accountId,
    });
    expect(ledger.available).toBe(true);
    if (!ledger.available) throw new Error(ledger.reason);
    expect(ledger.opening).toEqual({ debitBalance: "25.00", creditBalance: "0.00" });
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows[0]).toMatchObject({
      debit: "125.00",
      credit: "0.00",
      debitBalance: "150.00",
      creditBalance: "0.00",
    });
    expect(ledger.rows[1]).toMatchObject({
      debit: "0.00",
      credit: "10.00",
      debitBalance: "140.00",
      creditBalance: "0.00",
    });
    expect(ledger.pagination.hasMore).toBe(false);

    const exactPage = await getStatutoryAccountLedger({
      from: "2026-08-01",
      to: "2026-08-31",
      accountId: receivable!.accountId,
      limit: 1,
    });
    expect(exactPage.available).toBe(true);
    if (!exactPage.available) throw new Error(exactPage.reason);
    expect(exactPage.pagination.hasMore).toBe(true);
    const finalPage = await getStatutoryAccountLedger({
      from: "2026-08-01",
      to: "2026-08-31",
      accountId: receivable!.accountId,
      limit: 1,
      offset: 1,
    });
    expect(finalPage.available).toBe(true);
    if (!finalPage.available) throw new Error(finalPage.reason);
    expect(finalPage.pagination.hasMore).toBe(false);
    expect(finalPage.rows[0]).toMatchObject({
      debit: "0.00",
      credit: "10.00",
      debitBalance: "140.00",
      creditBalance: "0.00",
    });
    const ledgerExport = await getStatutoryAccountLedgerExport({
      from: "2026-08-01",
      to: "2026-08-31",
      accountId: receivable!.accountId,
    });
    expect(ledgerExport.available).toBe(true);
    if (!ledgerExport.available) throw new Error(ledgerExport.reason);
    expect(ledgerExport.rows).toHaveLength(2);
    expect(ledgerExport.pagination).toMatchObject({ limit: 10_000, offset: 0, hasMore: false });

    const payable = report.rows.find((row) => row.code === "211");
    const payableLedger = await getStatutoryAccountLedger({
      from: "2026-08-01",
      to: "2026-08-31",
      accountId: payable!.accountId,
    });
    expect(payableLedger.available).toBe(true);
    if (!payableLedger.available) throw new Error(payableLedger.reason);
    expect(payableLedger.rows[0]).toMatchObject({
      debit: "0.00",
      credit: "30.00",
      debitBalance: "0.00",
      creditBalance: "30.00",
    });
    const exactPayablePage = await getStatutoryAccountLedger({
      from: "2026-08-01",
      to: "2026-08-31",
      accountId: payable!.accountId,
      limit: 1,
    });
    expect(exactPayablePage.available).toBe(true);
    if (!exactPayablePage.available) throw new Error(exactPayablePage.reason);
    expect(exactPayablePage.pagination.hasMore).toBe(false);

    const missingLedger = await getStatutoryAccountLedger({
      from: "2026-08-01",
      to: "2026-08-31",
      accountId: 999_999,
    });
    expect(missingLedger.available).toBe(false);

    await expect(
      withTx((tx) =>
        replaceStatutoryAccounts(tx, profileId, [
          {
            code: "999",
            name: "تعديل ممنوع",
            type: "ASSET",
            normalBalance: "DEBIT",
          },
        ]),
      ),
    ).rejects.toThrow(/غير قابل للتعديل/);
  });

  it("يرجع استبدال الدليل والخريطة كاملين عند فشل قاعدة البيانات بعد الحذف", async () => {
    await seedFoundation();
    const profileId = await approveCompleteProfile();
    const beforeAccounts = await db()
      .select()
      .from(s.statutoryAccounts)
      .where(eq(s.statutoryAccounts.profileId, profileId));
    const beforeMappings = await db()
      .select()
      .from(s.statutoryAccountMappings)
      .where(eq(s.statutoryAccountMappings.profileId, profileId));

    await db().execute(sql.raw("DROP TRIGGER IF EXISTS test_statutory_account_insert_failure"));
    await db().execute(sql.raw(`
      CREATE TRIGGER test_statutory_account_insert_failure
      BEFORE INSERT ON statutoryAccounts
      FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced statutory import failure'
    `));
    try {
      await expect(
        withTx(async (tx) => {
          await tx
            .update(s.statutoryAccountingProfiles)
            .set({ status: "DRAFT", activeGuard: null, contentHash: null })
            .where(eq(s.statutoryAccountingProfiles.id, profileId));
          await replaceStatutoryAccounts(tx, profileId, [
            {
              code: "9",
              name: "دليل بديل",
              type: "ASSET",
              normalBalance: "DEBIT",
            },
          ]);
        }),
      ).rejects.toThrow();
    } finally {
      await db().execute(sql.raw("DROP TRIGGER IF EXISTS test_statutory_account_insert_failure"));
    }

    const afterAccounts = await db()
      .select()
      .from(s.statutoryAccounts)
      .where(eq(s.statutoryAccounts.profileId, profileId));
    const afterMappings = await db()
      .select()
      .from(s.statutoryAccountMappings)
      .where(eq(s.statutoryAccountMappings.profileId, profileId));
    expect(afterAccounts.map((row) => row.code).sort()).toEqual(
      beforeAccounts.map((row) => row.code).sort(),
    );
    expect(afterMappings).toHaveLength(beforeMappings.length);
  });

  it("يحافظ على الأرصدة عبر تبدّل الإصدار ويتيح التقرير المقيد بإصدار واحد", async () => {
    await seedFoundation();
    const firstProfileId = await approveCompleteProfile(1, "2026-08-01");
    await postJournal("2026-08-10", 1, [
      { role: "AR", debit: "100.00", credit: "0.00" },
      { role: "SALES_STATIONERY", debit: "0.00", credit: "100.00" },
    ]);

    const secondProfileId = await approveCompleteProfile(2, "2026-08-15");
    await postJournal("2026-08-20", 1, [
      { role: "AR", debit: "50.00", credit: "0.00" },
      { role: "SALES_STATIONERY", debit: "0.00", credit: "50.00" },
    ]);

    const combined = await getStatutoryTrialBalance({
      from: "2026-08-01",
      to: "2026-08-31",
      profileScope: "ALL_APPROVED",
    });
    expect(combined.available).toBe(true);
    if (!combined.available) throw new Error(combined.reason);
    expect(new Set(combined.rows.map((row) => row.profileId))).toEqual(
      new Set([firstProfileId, secondProfileId]),
    );
    expect(combined.totals).toMatchObject({ debit: "150.00", credit: "150.00", difference: "0.00" });
    expect(combined.scope).toMatchObject({
      profileScope: "ALL_APPROVED",
      activeProfileId: secondProfileId,
      includedProfileIds: expect.arrayContaining([firstProfileId, secondProfileId]),
    });

    const activeDefault = await getStatutoryTrialBalance({ from: "2026-08-01", to: "2026-08-31" });
    expect(activeDefault.available).toBe(true);
    if (!activeDefault.available) throw new Error(activeDefault.reason);
    expect(activeDefault.totals.debit).toBe("50.00");
    expect(activeDefault.scope.profileScope).toBe("ACTIVE");

    const secondOnly = await getStatutoryTrialBalance({
      from: "2026-08-01",
      to: "2026-08-31",
      profileId: secondProfileId,
    });
    expect(secondOnly.available).toBe(true);
    if (!secondOnly.available) throw new Error(secondOnly.reason);
    expect(secondOnly.rows.every((row) => row.profileVersion === 2)).toBe(true);
    expect(secondOnly.totals.debit).toBe("50.00");

    const firstJournalPage = await getStatutoryGeneralJournal({
      from: "2026-08-01",
      to: "2026-08-31",
      profileScope: "ALL_APPROVED",
      limit: 2,
    });
    expect(firstJournalPage.available).toBe(true);
    if (!firstJournalPage.available) throw new Error(firstJournalPage.reason);
    expect(firstJournalPage.pagination.hasMore).toBe(true);
    expect(firstJournalPage.rows.every((row) => row.profileVersion === 1)).toBe(true);
    expect(firstJournalPage.scope.includedProfileIds).toEqual(
      expect.arrayContaining([firstProfileId, secondProfileId]),
    );
    expect(firstJournalPage.scope.pageProfileIds).toEqual([firstProfileId]);

    const secondJournalPage = await getStatutoryGeneralJournal({
      from: "2026-08-01",
      to: "2026-08-31",
      profileScope: "ALL_APPROVED",
      limit: 2,
      offset: 2,
    });
    expect(secondJournalPage.available).toBe(true);
    if (!secondJournalPage.available) throw new Error(secondJournalPage.reason);
    expect(secondJournalPage.pagination.hasMore).toBe(false);
    expect(secondJournalPage.rows.every((row) => row.profileVersion === 2)).toBe(true);
    expect(secondJournalPage.scope.includedProfileIds).toEqual(
      expect.arrayContaining([firstProfileId, secondProfileId]),
    );
    expect(secondJournalPage.scope.pageProfileIds).toEqual([secondProfileId]);

    const journalExport = await getStatutoryGeneralJournalExport({
      from: "2026-08-01",
      to: "2026-08-31",
      profileScope: "ALL_APPROVED",
    });
    expect(journalExport.available).toBe(true);
    if (!journalExport.available) throw new Error(journalExport.reason);
    expect(journalExport.rows).toHaveLength(4);
    expect(journalExport.pagination.hasMore).toBe(false);

    const combinedIncome = await getStatutoryIncomeStatement({
      from: "2026-08-01",
      to: "2026-08-31",
      profileScope: "ALL_APPROVED",
    });
    expect(combinedIncome.available).toBe(true);
    if (!combinedIncome.available) throw new Error(combinedIncome.reason);
    expect(combinedIncome.totals.revenue).toBe("150.00");
    expect(new Set(combinedIncome.rows.map((row) => row.profileVersion))).toEqual(new Set([1, 2]));

    const firstIncome = await getStatutoryIncomeStatement({
      from: "2026-08-01",
      to: "2026-08-31",
      profileId: firstProfileId,
    });
    expect(firstIncome.available && firstIncome.totals.revenue).toBe("100.00");

    const combinedPosition = await getStatutoryBalanceSheet({
      asOf: "2026-08-31",
      profileScope: "ALL_APPROVED",
    });
    expect(combinedPosition.available).toBe(true);
    if (!combinedPosition.available) throw new Error(combinedPosition.reason);
    expect(combinedPosition.totals.assets).toBe("150.00");
    expect(new Set(combinedPosition.rows.map((row) => row.profileVersion))).toEqual(new Set([1, 2]));

    const firstPosition = await getStatutoryBalanceSheet({
      asOf: "2026-08-31",
      profileId: firstProfileId,
    });
    expect(firstPosition.available && firstPosition.totals.assets).toBe("100.00");

    const firstReceivable = combined.rows.find(
      (row) => row.profileId === firstProfileId && row.code === "111",
    );
    const retiredLedger = await getStatutoryAccountLedger({
      from: "2026-08-01",
      to: "2026-08-31",
      profileId: firstProfileId,
      accountId: firstReceivable!.accountId,
    });
    expect(retiredLedger.available).toBe(true);
    if (!retiredLedger.available) throw new Error(retiredLedger.reason);
    expect(retiredLedger.rows).toHaveLength(1);
    expect(retiredLedger.rows[0].debitBalance).toBe("100.00");

    const snapshotPack = await getStatutoryAccountantPack(
      { from: "2026-08-01", to: "2026-08-31" },
      {
        afterTrialBalance: async () => {
          await postJournal("2026-08-25", 1, [
            { role: "AR", debit: "777.00", credit: "0.00" },
            { role: "SALES_STATIONERY", debit: "0.00", credit: "777.00" },
          ]);
        },
      },
    );
    expect(snapshotPack.available).toBe(true);
    if (!snapshotPack.available) throw new Error(snapshotPack.reason);
    expect(snapshotPack.profileDetails.map((detail) => Number(detail.profile.id))).toEqual(
      expect.arrayContaining([firstProfileId, secondProfileId]),
    );
    expect(snapshotPack.trialBalance.totals.debit).toBe("150.00");
    expect(snapshotPack.incomeStatement.totals.revenue).toBe("150.00");
    expect(snapshotPack.balanceSheet.totals.assets).toBe("150.00");
    expect(snapshotPack.generalJournal.rows).toHaveLength(4);

    const afterSnapshot = await getStatutoryTrialBalance({
      from: "2026-08-01",
      to: "2026-08-31",
      profileScope: "ALL_APPROVED",
    });
    expect(afterSnapshot.available && afterSnapshot.totals.debit).toBe("927.00");

    await db()
      .update(s.statutoryAccounts)
      .set({ name: "عبث بإصدار متقاعد" })
      .where(eq(s.statutoryAccounts.profileId, firstProfileId));
    await expect(
      getStatutoryAccountantPack({ from: "2026-08-01", to: "2026-08-31" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("يعزل تقارير المدير حسب فرعه ويرفض الفترات غير الصالحة عند حد API", async () => {
    await seedFoundation();
    const profileId = await approveCompleteProfile();
    await postJournal("2026-07-20", 1, [
      { role: "AR", debit: "25.00", credit: "0.00" },
      { role: "SALES_STATIONERY", debit: "0.00", credit: "25.00" },
    ]);
    await postJournal("2026-07-21", 2, [
      { role: "AR", debit: "40.00", credit: "0.00" },
      { role: "SALES_STATIONERY", debit: "0.00", credit: "40.00" },
    ]);
    await postJournal("2026-08-12", 1, [
      { role: "AR", debit: "100.00", credit: "0.00" },
      { role: "SALES_STATIONERY", debit: "0.00", credit: "100.00" },
    ]);
    await postJournal("2026-08-13", 2, [
      { role: "AR", debit: "60.00", credit: "0.00" },
      { role: "SALES_STATIONERY", debit: "0.00", credit: "60.00" },
    ]);
    await postJournal("2026-08-14", 1, [
      { role: "AR", debit: "900.00", credit: "0.00" },
      { role: "SALES_STATIONERY", debit: "0.00", credit: "900.00" },
    ], "statutory-test-cycle-retired");

    const branchOne = await getStatutoryTrialBalance({
      from: "2026-08-01",
      to: "2026-08-31",
      branchId: 1,
    });
    const branchTwo = await getStatutoryTrialBalance({
      from: "2026-08-01",
      to: "2026-08-31",
      branchId: 2,
    });
    expect(branchOne.available && branchOne.totals.debit).toBe("100.00");
    expect(branchTwo.available && branchTwo.totals.debit).toBe("60.00");

    const manager = (await db().select().from(s.users).where(eq(s.users.id, 2)).limit(1))[0];
    const caller = appRouter.createCaller(makeCtx(manager));
    const scoped = await caller.statutoryAccounting.trialBalance({
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(scoped.available && scoped.totals.debit).toBe("100.00");
    if (!scoped.available) throw new Error(scoped.reason);
    const scopedIncome = await caller.statutoryAccounting.incomeStatement({
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(scopedIncome.available && scopedIncome.totals.revenue).toBe("100.00");
    const scopedPosition = await caller.statutoryAccounting.balanceSheet({ asOf: "2026-08-31" });
    expect(scopedPosition.available && scopedPosition.totals.assets).toBe("125.00");
    const scopedReceivable = scoped.rows.find((row) => row.code === "111")!;
    const scopedLedger = await caller.statutoryAccounting.accountLedger({
      from: "2026-08-01",
      to: "2026-08-31",
      accountId: scopedReceivable.accountId,
      limit: 100,
      offset: 0,
    });
    expect(scopedLedger.available).toBe(true);
    if (!scopedLedger.available) throw new Error(scopedLedger.reason);
    expect(scopedLedger.opening).toEqual({ debitBalance: "25.00", creditBalance: "0.00" });
    expect(scopedLedger.rows).toHaveLength(1);
    expect(scopedLedger.rows[0].debitBalance).toBe("125.00");
    const scopedLedgerExport = await caller.statutoryAccounting.accountLedgerExport({
      from: "2026-08-01",
      to: "2026-08-31",
      accountId: scopedReceivable.accountId,
    });
    expect(scopedLedgerExport.available).toBe(true);
    if (!scopedLedgerExport.available) throw new Error(scopedLedgerExport.reason);
    expect(scopedLedgerExport.opening).toEqual({ debitBalance: "25.00", creditBalance: "0.00" });
    expect(scopedLedgerExport.rows).toHaveLength(1);
    expect(scopedLedgerExport.export).toEqual({ complete: true, rowLimit: 10_000 });
    const scopedPagedJournal = await caller.statutoryAccounting.generalJournal({
      from: "2026-08-01",
      to: "2026-08-31",
      limit: 100,
      offset: 0,
    });
    expect(scopedPagedJournal.available).toBe(true);
    if (!scopedPagedJournal.available) throw new Error(scopedPagedJournal.reason);
    expect(scopedPagedJournal.rows).toHaveLength(2);
    expect(scopedPagedJournal.rows.every((row) => row.branchId === 1)).toBe(true);
    const accountantPack = await caller.statutoryAccounting.accountantPack({
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(accountantPack.available).toBe(true);
    if (!accountantPack.available) throw new Error(accountantPack.reason);
    expect(accountantPack.trialBalance.totals.debit).toBe("100.00");
    expect(accountantPack.generalJournal.rows).toHaveLength(2);
    expect(accountantPack.generalJournal.rows.every((row) => row.branchId === 1)).toBe(true);
    expect(accountantPack.profileDetails).toHaveLength(1);
    expect(accountantPack.profileDetails[0].approvedAccounts).toHaveLength(11);
    expect(
      accountantPack.profileDetails[0].approvedAccounts.find((account) => account.code === "110"),
    ).toMatchObject({
      name: "الصندوق النظامي",
      type: "ASSET",
      normalBalance: "DEBIT",
      parentCode: "1",
      isPosting: true,
    });
    expect(accountantPack.profileDetails[0].approvedMappings).toHaveLength(6);
    const verifiedDetail = accountantPack.profileDetails[0];
    const reconstructedAccounts = verifiedDetail.approvedAccounts.map(
      ({ code, name, type, normalBalance, parentId, isPosting, sortOrder }) => ({
        code,
        name,
        type,
        normalBalance,
        parentId,
        isPosting,
        sortOrder,
      }),
    );
    const reconstructedMappings = verifiedDetail.approvedMappings.map(
      ({ internalCode, role, statutoryCode }) => ({
        internalCode,
        role,
        statutoryCode,
      }),
    );
    expect(
      createHash("sha256")
        .update(JSON.stringify({
          accounts: reconstructedAccounts,
          mappings: reconstructedMappings,
        }))
        .digest("hex"),
    ).toBe(verifiedDetail.profile.contentHash);

    await db()
      .update(s.accounts)
      .set({ isActive: false })
      .where(eq(s.accounts.systemRole, "CASH"));
    const packAfterAccountDisabled = await caller.statutoryAccounting.accountantPack({
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(packAfterAccountDisabled.available).toBe(true);
    if (!packAfterAccountDisabled.available) throw new Error(packAfterAccountDisabled.reason);
    expect(packAfterAccountDisabled.profileDetails[0].mappings).toHaveLength(5);
    expect(packAfterAccountDisabled.profileDetails[0].approvedMappings).toHaveLength(6);
    expect(
      packAfterAccountDisabled.profileDetails[0].approvedMappings.some(
        (mapping) => mapping.internalCode === "1000",
      ),
    ).toBe(true);

    await expect(
      caller.statutoryAccounting.trialBalance({ from: "2026-02-30", to: "2026-08-31" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.statutoryAccounting.trialBalance({ from: "2026-09-01", to: "2026-08-31" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.statutoryAccounting.trialBalance({
        from: "2026-08-01",
        to: "2026-08-31",
        profileId,
        profileScope: "ALL_APPROVED",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.statutoryAccounting.balanceSheet({
        asOf: "2026-08-31",
        profileId,
        profileScope: "ALL_APPROVED",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.statutoryAccounting.generalJournal({
        from: "2026-08-01",
        to: "2026-08-31",
        profileId,
        profileScope: "ALL_APPROVED",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.statutoryAccounting.accountLedger({
        from: "2026-09-01",
        to: "2026-08-31",
        accountId: scopedReceivable.accountId,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.statutoryAccounting.generalJournal({
        from: "2026-09-01",
        to: "2026-08-31",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    for (const label of ["كشف الحساب", "اليومية النظامية"]) {
      let exportError: unknown;
      try {
        requireCompleteExport(
          { available: true as const, pagination: { hasMore: true }, rows: [] },
          label,
        );
      } catch (error) {
        exportError = error;
      }
      expect(exportError).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    }
    expect(() =>
      requireCompleteAccountantPackJournal({ pagination: { hasMore: true } }),
    ).toThrow(/10,000/);

    await db().update(s.doubleEntrySettings).set({ shadowCycleId: null }).where(eq(s.doubleEntrySettings.id, 1));
    const noCycle = await getStatutoryTrialBalance({ from: "2026-08-01", to: "2026-08-31" });
    expect(noCycle).toMatchObject({ available: false });
    if (!noCycle.available) expect(noCycle.reason).toMatch(/دورة دفتر مزدوج/);
    await db().update(s.doubleEntrySettings).set({ mode: "SHADOW", shadowCycleId: CURRENT_CYCLE_ID }).where(eq(s.doubleEntrySettings.id, 1));
    const preview = await getStatutoryTrialBalance({ from: "2026-08-01", to: "2026-08-31" });
    expect(preview.available && preview.mode).toBe("SHADOW");
    const previewPack = await caller.statutoryAccounting.accountantPack({
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(previewPack).toMatchObject({ available: false });
    await db().update(s.doubleEntrySettings).set({ mode: "ACTIVE" }).where(eq(s.doubleEntrySettings.id, 1));

    await db().update(s.accounts).set({ code: "1100-CHANGED" }).where(eq(s.accounts.systemRole, "AR"));
    await expect(
      caller.statutoryAccounting.accountantPack({ from: "2026-08-01", to: "2026-08-31" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("يعتمد بعد الفرع المثبت على السطر لا فرع رأس القيد", async () => {
    await seedFoundation();
    await approveCompleteProfile();
    const entryId = await postJournal("2026-08-18", 2, [
      { role: "AR", debit: "10.00", credit: "0.00" },
      { role: "SALES_STATIONERY", debit: "0.00", credit: "10.00" },
    ]);
    const journal = (
      await db().select().from(s.journalEntries).where(eq(s.journalEntries.entryId, entryId)).limit(1)
    )[0];
    await db()
      .update(s.journalLines)
      .set({ branchId: 1 })
      .where(eq(s.journalLines.journalId, Number(journal.id)));
    const revenueAccount = (
      await db().select().from(s.accounts).where(eq(s.accounts.systemRole, "SALES_STATIONERY")).limit(1)
    )[0];
    await db()
      .update(s.journalLines)
      .set({ branchId: 2 })
      .where(eq(s.journalLines.accountId, Number(revenueAccount.id)));

    const branchOne = await getStatutoryTrialBalance({
      from: "2026-08-01",
      to: "2026-08-31",
      branchId: 1,
    });
    const branchTwo = await getStatutoryTrialBalance({
      from: "2026-08-01",
      to: "2026-08-31",
      branchId: 2,
    });
    expect(branchOne.available && branchOne.totals).toMatchObject({ debit: "10.00", credit: "0.00" });
    expect(branchTwo.available && branchTwo.totals).toMatchObject({ debit: "0.00", credit: "10.00" });
  });
});
