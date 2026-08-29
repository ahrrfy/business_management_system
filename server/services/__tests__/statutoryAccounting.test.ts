import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
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
import { getStatutoryTrialBalance } from "../accounting/statutoryReports";
import { withTx } from "../tx";

const ACTOR_ID = 1;

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
  await db().insert(s.branches).values({
    id: 1,
    name: "الرئيسي",
    code: "MAIN",
    type: "MAIN",
  });
  await db().insert(s.accounts).values([
    {
      code: "1100",
      name: "ذمم العملاء",
      type: "ASSET",
      systemRole: "AR",
      sortOrder: 1,
    },
    {
      code: "4100",
      name: "مبيعات القرطاسية",
      type: "REVENUE",
      systemRole: "SALES_STATIONERY",
      sortOrder: 2,
    },
  ]);
}

async function approveCompleteProfile() {
  const internal = await db().select().from(s.accounts);
  let profileId = 0;
  await withTx(async (tx) => {
    profileId = (
      await createStatutoryProfile(
        tx,
        {
          profileKey: "IRAQI_STATUTORY",
          version: 1,
          name: "دليل الاختبار المصادق",
          authorityReference: "كتاب الاختبار 1/2026",
          effectiveFrom: "2026-08-01",
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
        code: "111",
        name: "ذمم العملاء النظامية",
        type: "ASSET",
        normalBalance: "DEBIT",
        parentCode: "1",
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
          internalAccountId: internalByRole.get("AR")!,
          statutoryAccountId: statutoryByCode.get("111")!,
        },
        {
          internalAccountId: internalByRole.get("SALES_STATIONERY")!,
          statutoryAccountId: statutoryByCode.get("411")!,
        },
      ],
      ACTOR_ID,
    );
    await approveStatutoryProfile(
      tx,
      {
        profileId,
        accountantName: "مراقب حسابات الاختبار",
        approvalReference: "محضر مصادقة 7/2026",
      },
      ACTOR_ID,
    );
  });
  return profileId;
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
    expect(readiness.mappedAccounts).toBe(2);

    const entryResult = await db().insert(s.accountingEntries).values({
      entryType: "SALE",
      branchId: 1,
      entryDate: new Date("2026-08-15T00:00:00.000Z"),
      amount: "125.00",
      revenue: "125.00",
      cost: "0.00",
      profit: "125.00",
      taxAmount: "0.00",
    });
    const entryId = extractInsertId(entryResult);
    await withTx(async (tx) => {
      await writeJournal(tx, entryId, new Date("2026-08-15T00:00:00.000Z"), 1, [
        { role: "AR", debit: "125.00", credit: "0.00" },
        { role: "SALES_STATIONERY", debit: "0.00", credit: "125.00" },
      ]);
    });

    const lines = await db().select().from(s.journalLines);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => Number(line.statutoryProfileId) === profileId)).toBe(true);
    expect(lines.every((line) => line.accountId != null && line.statutoryAccountId != null)).toBe(true);

    const report = await getStatutoryTrialBalance({
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(report.available).toBe(true);
    if (!report.available) throw new Error(report.reason);
    expect(report.rows).toHaveLength(2);
    expect(report.totals.debit).toBe("125.00");
    expect(report.totals.credit).toBe("125.00");
    expect(report.totals.difference).toBe("0.00");

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
});
