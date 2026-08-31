import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  canActivate,
  CURRENT_ENTRY_TYPES,
  REQUIRED_MAPPED_ENTRY_TYPE_COUNT,
} from "../accounting/activationGate";
import {
  approveDoubleEntryPolicy,
  activateDoubleEntry,
  clearDoubleEntryPolicyApproval,
  prepareDoubleEntryShadowOpening,
  startDoubleEntryShadow,
  stopDoubleEntry,
} from "../accounting/doubleEntrySettings";
import {
  getDoubleEntryMode,
  writeJournal,
  writeJournalGap,
  writeShadowOpeningJournal,
} from "../accounting/journalStore";
import {
  MAPPED_ENTRY_TYPES,
  POSTING_POLICY_HASH,
  ACTIVATION_REQUIRED_ACCOUNT_ROLES,
  createPostingIntent,
  createPostingIntentEvidence,
  creditLine,
  debitLine,
  postingLinesFor,
} from "../accounting/postingEngine";
import { reconcileDoubleEntry } from "../reconcileService";
import { computeShadowOpeningHash } from "../accounting/shadowOpening";
import {
  approveStatutoryProfile,
  createStatutoryProfile,
  replaceStatutoryAccounts,
  replaceStatutoryMappings,
} from "../accounting/statutoryAccounting";
import { postOpeningEntry, upsertOpeningEntry } from "../openingBalance";
import { withTx } from "../tx";
import { truncateTables } from "./__testUtils__";
import {
  employeeAdvanceReference,
  employeeAdvanceSourceHash,
} from "../voucher/create";

const ADMIN_ID = 1;
const BRANCH_MAIN = 1;
const BRANCH_SALES = 2;
const NOW = new Date("2026-08-31T00:00:00.000Z");
const THIRTY_DAYS_AGO = new Date("2026-08-01T00:00:00.000Z");
const CYCLE_ID = "double-entry-activation-cycle";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

function auditContext(ip = "127.0.0.1") {
  return {
    user: { id: ADMIN_ID, role: "admin", branchId: BRANCH_MAIN },
    req: { headers: {}, ip },
  } as never;
}

async function reset() {
  await truncateTables([
    "auditLogs",
    "journalLines",
    "journalEntries",
    "statutoryAccountMappings",
    "statutoryAccounts",
    "statutoryAccountingProfiles",
    "accrualCorrectionRequests",
    "accrualObligationEvents",
    "accrualObligations",
    "fixedAssets",
    "accountingEntries",
    "idempotencyKeys",
    "doubleEntrySettings",
    "employeeAdvances",
    "employees",
    "receipts",
    "voucherCategories",
    "accounts",
    "customers",
    "branches",
    "users",
  ]);
  await db().insert(s.users).values({
    id: ADMIN_ID,
    openId: "double-entry-admin",
    name: "المدير العام",
    role: "admin",
    loginMethod: "local",
  });
  await db()
    .insert(s.branches)
    .values([
      { id: BRANCH_MAIN, name: "الرئيسي", code: "MAIN", type: "MAIN" },
      { id: BRANCH_SALES, name: "المبيعات", code: "SALES", type: "SALES" },
    ]);
  await db().insert(s.accounts).values(
    ACTIVATION_REQUIRED_ACCOUNT_ROLES.map((role, index) => ({
      code: `TEST-CRITICAL-${index + 1}`,
      name: role,
      type:
        role === "SOCIAL_SECURITY_EXPENSE" || role === "EOS_EXPENSE"
          ? ("EXPENSE" as const)
          : role.startsWith("EXCHANGE_RECEIVABLE")
            ? ("ASSET" as const)
            : ("LIABILITY" as const),
      systemRole: role,
      isActive: true,
    })),
  );
}

async function seedApprovedStatutoryProfile() {
  const observedRoles = await db()
    .selectDistinct({ role: s.journalLines.role })
    .from(s.journalLines);
  const current = await db().select().from(s.accounts);
  const existingRoles = new Set(
    current.map((row) => row.systemRole).filter((role): role is string => Boolean(role)),
  );
  const missingRoles = observedRoles
    .map((row) => row.role)
    .filter((role) => !existingRoles.has(role));
  if (missingRoles.length) {
    await db().insert(s.accounts).values(
      missingRoles.map((role, index) => ({
        code: `TEST-STAT-${index + 1}`,
        name: role,
        type:
          role === "AR"
            ? ("ASSET" as const)
            : role === "CAPITAL"
              ? ("EQUITY" as const)
              : ("LIABILITY" as const),
        systemRole: role,
        isActive: true,
      })),
    );
  }
  const internal = await db()
    .select()
    .from(s.accounts)
    .where(eq(s.accounts.isActive, true));
  await withTx(async (tx) => {
    const { id: profileId } = await createStatutoryProfile(
      tx,
      {
        profileKey: "ACTIVATION_TEST",
        version: 1,
        name: "دليل تفعيل الاختبار",
        authorityReference: "مرجع اختبار بوابة ACTIVE",
        effectiveFrom: "2026-08-01",
      },
      ADMIN_ID,
    );
    await replaceStatutoryAccounts(
      tx,
      profileId,
      internal.map((account, index) => ({
        code: `S-${index + 1}`,
        name: `نظامي — ${account.name}`,
        type: account.type,
        normalBalance:
          account.type === "ASSET" || account.type === "EXPENSE"
            ? ("DEBIT" as const)
            : ("CREDIT" as const),
      })),
    );
    const statutory = await tx
      .select()
      .from(s.statutoryAccounts)
      .where(eq(s.statutoryAccounts.profileId, profileId));
    await replaceStatutoryMappings(
      tx,
      profileId,
      internal.map((account, index) => ({
        internalAccountId: Number(account.id),
        statutoryAccountId: Number(statutory[index].id),
      })),
      ADMIN_ID,
    );
    await approveStatutoryProfile(
      tx,
      {
        profileId,
        accountantName: "مراقب حسابات الاختبار",
        approvalReference: "اعتماد اختبار ACTIVE",
      },
      ADMIN_ID,
    );
  });
}

async function insertSale(input: {
  branchId?: number;
  entryDate?: string;
  createdAt?: Date;
  amount?: string;
}) {
  const amount = input.amount ?? "100.00";
  const sourceComponents = {
    roleDebits: { AR: amount },
    roleCredits: { SALES_STATIONERY: amount },
  } as const;
  const intent = createPostingIntent(
    "SALE_INVENTORY",
    "SALE",
    [debitLine("AR", amount), creditLine("SALES_STATIONERY", amount)],
    sourceComponents,
  );
  const evidence = createPostingIntentEvidence(intent, {
    amount,
    revenue: amount,
    cost: "0.00",
    profit: amount,
    taxAmount: "0.00",
    ...sourceComponents,
  });
  const rows = await db()
    .insert(s.accountingEntries)
    .values({
      entryType: "SALE",
      branchId: input.branchId ?? BRANCH_MAIN,
      entryDate: new Date(`${input.entryDate ?? "2026-08-15"}T00:00:00.000Z`),
      amount,
      revenue: amount,
      cost: "0.00",
      profit: amount,
      postingCycleId: CYCLE_ID,
      ...evidence,
      createdAt: input.createdAt ?? new Date("2026-08-15T12:00:00.000Z"),
    })
    .$returningId();
  return Number(rows[0].id);
}

async function writeSaleJournal(
  entryId: number,
  input?: { branchId?: number; entryDate?: string; amount?: string; createdAt?: Date },
) {
  const entryDate = new Date(`${input?.entryDate ?? "2026-08-15"}T00:00:00.000Z`);
  await withTx(async (tx) =>
    writeJournal(
      tx,
      entryId,
      entryDate,
      input?.branchId ?? BRANCH_MAIN,
      postingLinesFor({
        entryType: "SALE",
        amount: input?.amount ?? "100.00",
        revenue: input?.amount ?? "100.00",
      }),
      { cycleId: CYCLE_ID, postingProfile: "SALE_INVENTORY" },
    ),
  );
  /**
   * `writeJournal` لا يقبل `createdAt` صراحةً (يستعمل `defaultNow()` من المخطّط). لكنّ نافذة
   * التسوية `reconcileDoubleEntryShadowWindow` تصفّي `journalEntries.createdAt ∈ [startedAt, NOW]`،
   * وNOW في اختباراتنا ثابت (2026-08-31)، فلو تُرك `createdAt` على `NOW()` الحقيقيّ صار خارج
   * النافذة عند تشغيل الاختبارات بعد 2026-08-31 ⇒ تُستبعد ولا تُحسب انحرافاً/فجوة.
   * الحل الآمن: بعد الكتابة نُحدِّث `createdAt` إلى تاريخ ضمن النافذة (entryDate افتراضياً).
   */
  const createdAt = input?.createdAt ?? entryDate;
  await db()
    .update(s.journalEntries)
    .set({ createdAt })
    .where(eq(s.journalEntries.entryId, entryId));
}

/**
 * ضبط `createdAt` لرأس يوميّة UNMAPPED (فجوة) بعد `writeJournalGap` كي يقع داخل نافذة
 * التسوية `[startedAt, NOW]`. مطلوب لنفس السبب أعلاه.
 */
async function setGapCreatedAt(entryId: number, createdAt: Date) {
  await db()
    .update(s.journalEntries)
    .set({ createdAt })
    .where(eq(s.journalEntries.entryId, entryId));
}

async function seedShadow(startedAt = THIRTY_DAYS_AGO) {
  await db().insert(s.customers).values({
    name: "عميل رصيد القطع",
    currentBalance: "100.00",
  });
  const asOf = startedAt.toISOString().slice(0, 10);
  const openingLines = [
    { role: "AR" as const, debit: "100.00", credit: "0.00" },
    { role: "CAPITAL" as const, debit: "0.00", credit: "100.00" },
  ];
  const openingHash = computeShadowOpeningHash({
    cycleId: CYCLE_ID,
    asOf,
    lines: openingLines.map((line) => ({ ...line, branchId: null })),
  });
  await db().insert(s.doubleEntrySettings).values({
    id: 1,
    mode: "SHADOW",
    shadowStartedAt: startedAt,
    shadowCycleId: CYCLE_ID,
    shadowOpeningHash: openingHash,
    policyApprovalReference: "POLICY-APPROVAL-TEST",
    policyApprovalPolicyHash: POSTING_POLICY_HASH,
    policyApprovalCycleId: CYCLE_ID,
    policyApprovalOpeningHash: openingHash,
    policyAccountantName: "محاسب الاختبار",
    policyApprovedAt: THIRTY_DAYS_AGO,
    policyApprovedBy: ADMIN_ID,
    updatedBy: ADMIN_ID,
  });
  await withTx(async (tx) =>
    writeShadowOpeningJournal(tx, {
      cycleId: CYCLE_ID,
      sourceKey: `SHADOW_OPENING:${CYCLE_ID}:${asOf}:GLOBAL`,
      entryDate: new Date(`${asOf}T00:00:00.000Z`),
      branchId: null,
      lines: openingLines,
    }),
  );
}

async function prepareCurrentOpening(now = NOW) {
  const initial = await prepareDoubleEntryShadowOpening({
    actorId: ADMIN_ID,
    now,
    db: db(),
  });
  return prepareDoubleEntryShadowOpening({
    actorId: ADMIN_ID,
    now,
    db: db(),
    allocations: initial.preview.unallocatedOpeningBalance.scopes.map(
      (scope) => ({
        role: "CAPITAL" as const,
        branchId: scope.branchId,
        debit: scope.debit,
        credit: scope.credit,
      }),
    ),
  });
}

async function prepareStart(now = NOW) {
  await db().insert(s.customers).values({
    name: "عميل معاينة الافتتاح",
    currentBalance: "125.00",
  });
  return prepareCurrentOpening(now);
}

beforeEach(reset);

describe("reconcileDoubleEntry — نطاق الشهر والفرع", () => {
  it("يعزل الشهر والفرع ويعيد انحرافاً صفرياً للقيد المطابق", async () => {
    await seedShadow();
    const inScope = await insertSale({
      branchId: BRANCH_MAIN,
      entryDate: "2026-08-15",
    });
    await writeSaleJournal(inScope);

    const otherBranch = await insertSale({
      branchId: BRANCH_SALES,
      entryDate: "2026-08-15",
      amount: "900.00",
    });
    await writeSaleJournal(otherBranch, {
      branchId: BRANCH_SALES,
      amount: "900.00",
    });
    const otherMonth = await insertSale({
      branchId: BRANCH_MAIN,
      entryDate: "2026-07-31",
      amount: "700.00",
    });
    await writeSaleJournal(otherMonth, {
      entryDate: "2026-07-31",
      amount: "700.00",
    });

    const result = await reconcileDoubleEntry({
      month: "2026-08",
      branchId: BRANCH_MAIN,
    });

    expect(result.sourceEntryCount).toBe(1);
    expect(result.journalEntryCount).toBe(1);
    expect(result.gapCount).toBe(0);
    expect(result.missingCount).toBe(0);
    expect(result.drift).toBe("0.00");
    expect(result.ok).toBe(true);
    expect(result.roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "AR",
          expected: "100.00",
          actual: "100.00",
          drift: "0.00",
        }),
        expect.objectContaining({
          role: "SALES_STATIONERY",
          expected: "-100.00",
          actual: "-100.00",
          drift: "0.00",
        }),
      ]),
    );
  });

  it("يكشف السطر المعدّل والحدث المفقود والفجوة بلا إخفاء", async () => {
    await seedShadow();
    const tampered = await insertSale({ amount: "100.00" });
    await writeSaleJournal(tampered);
    await db()
      .update(s.journalLines)
      .set({ credit: "90.00" })
      .where(
        and(
          eq(s.journalLines.role, "SALES_STATIONERY"),
          eq(s.journalLines.credit, "100.00"),
        ),
      );

    await insertSale({ amount: "25.00" }); // لا رأس يومية ⇒ حدث مفقود.
    const gapEntry = await insertSale({ amount: "10.00" });
    await withTx(async (tx) =>
      writeJournalGap(
        tx,
        gapEntry,
        new Date("2026-08-15T00:00:00.000Z"),
        BRANCH_MAIN,
        "فجوة اختبار",
        { cycleId: CYCLE_ID },
      ),
    );

    const result = await reconcileDoubleEntry({
      month: "2026-08",
      branchId: BRANCH_MAIN,
    });

    expect(result.sourceEntryCount).toBe(3);
    expect(result.journalEntryCount).toBe(2);
    expect(result.gapCount).toBe(1);
    expect(result.missingCount).toBe(1);
    expect(result.journalImbalance).toBe("10.00");
    expect(result.drift).toBe("80.00");
    expect(result.ok).toBe(false);
  });

  it("يكشف يوميتين مختلتين متعاكستين ولا يسمح لهما بالإلغاء الإجمالي", async () => {
    await seedShadow();
    const first = await insertSale({ amount: "90.00" });
    const second = await insertSale({ amount: "110.00" });
    await writeSaleJournal(first, { amount: "100.00" });
    await writeSaleJournal(second, { amount: "100.00" });

    const result = await reconcileDoubleEntry({
      month: "2026-08",
      branchId: BRANCH_MAIN,
    });
    expect(result.drift).toBe("0.00");
    expect(result.journalImbalance).toBe("0.00");
    expect(result.imbalancedJournalCount).toBe(0);
    expect(result.sourceMismatchCount).toBe(2);
    expect(result.ok).toBe(false);
  });

  it("يكشف wash lines المتوازنة ولو لم تغيّر صافي أي دور", async () => {
    await seedShadow();
    const entryId = await insertSale({ amount: "100.00" });
    await writeSaleJournal(entryId);
    const [head] = await db()
      .select({ id: s.journalEntries.id })
      .from(s.journalEntries)
      .where(eq(s.journalEntries.entryId, entryId));
    await db().insert(s.journalLines).values([
      { journalId: head.id, role: "CASH", debit: "10.00", credit: "0.00" },
      { journalId: head.id, role: "CASH", debit: "0.00", credit: "10.00" },
    ]);

    const result = await reconcileDoubleEntry({
      month: "2026-08",
      branchId: BRANCH_MAIN,
    });
    expect(result.drift).toBe("0.00");
    expect(result.journalImbalance).toBe("0.00");
    expect(result.sourceMismatchCount).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("يعد رأس POSTED بلا أسطر خللاً ولو كان فرق المبالغ صفراً", async () => {
    await seedShadow();
    const entryId = await insertSale({ amount: "50.00" });
    await db().insert(s.journalEntries).values({
      entryId,
      sourceType: "ACCOUNTING_ENTRY",
      cycleId: CYCLE_ID,
      entryDate: new Date("2026-08-15T00:00:00.000Z"),
      branchId: BRANCH_MAIN,
      status: "POSTED",
    });

    const result = await reconcileDoubleEntry({
      month: "2026-08",
      branchId: BRANCH_MAIN,
    });
    expect(result.journalImbalance).toBe("0.00");
    expect(result.imbalancedJournalCount).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("يفصل SHADOW_OPENING عن pairing ويعد رأس MEMO التشغيلي مقابلاً لمصدره", async () => {
    await seedShadow();
    await db().insert(s.journalEntries).values({
      entryId: null,
      sourceType: "SHADOW_OPENING",
      sourceKey: `${CYCLE_ID}:opening:global`,
      postingProfile: "SHADOW_OPENING_V1",
      cycleId: CYCLE_ID,
      entryDate: new Date("2026-08-01T00:00:00.000Z"),
      branchId: null,
      status: "POSTED",
    });
    const memoIntent = createPostingIntent(
      "DELIVERY_DISPATCH_COD",
      "DELIVERY_DISPATCH",
      [],
    );
    const memoEvidence = createPostingIntentEvidence(memoIntent, {
      amount: "75.00",
      revenue: "0.00",
      cost: "0.00",
      profit: "0.00",
      taxAmount: "0.00",
    });
    const memoEntry = await db()
      .insert(s.accountingEntries)
      .values({
        entryType: "DELIVERY_DISPATCH",
        branchId: BRANCH_MAIN,
        entryDate: new Date("2026-08-15T00:00:00.000Z"),
        amount: "75.00",
        postingCycleId: CYCLE_ID,
        ...memoEvidence,
        createdAt: new Date("2026-08-15T12:00:00.000Z"),
      })
      .$returningId();
    await db().insert(s.journalEntries).values({
      entryId: Number(memoEntry[0].id),
      sourceType: "ACCOUNTING_ENTRY",
      postingProfile: "DELIVERY_DISPATCH_COD",
      cycleId: CYCLE_ID,
      entryDate: new Date("2026-08-15T00:00:00.000Z"),
      branchId: BRANCH_MAIN,
      status: "MEMO",
    });

    const result = await reconcileDoubleEntry({
      month: "2026-08",
      branchId: BRANCH_MAIN,
    });
    expect(result.sourceEntryCount).toBe(1);
    expect(result.journalEntryCount).toBe(1);
    expect(result.memoCount).toBe(1);
    expect(result.missingCount).toBe(0);
    expect(result.extraCount).toBe(0);
    expect(result.roles).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("يعزل مصادر دورة سابقة ولو تطابق createdAt حتى الثانية مع الدورة الحالية", async () => {
    await seedShadow();
    const oldEntry = await insertSale({
      amount: "80.00",
      createdAt: THIRTY_DAYS_AGO,
    });
    await writeSaleJournal(oldEntry, { amount: "80.00" });
    await db()
      .update(s.accountingEntries)
      .set({ postingCycleId: "previous-cycle" })
      .where(eq(s.accountingEntries.id, oldEntry));
    await db()
      .update(s.journalEntries)
      .set({ cycleId: "previous-cycle" })
      .where(eq(s.journalEntries.entryId, oldEntry));

    const result = await reconcileDoubleEntry({
      month: "2026-08",
      branchId: BRANCH_MAIN,
    });
    expect(result.sourceEntryCount).toBe(0);
    expect(result.journalEntryCount).toBe(0);
    expect(result.ok).toBe(true);
  });

  it("يرفض شهراً غير صالح بدل توسيع النطاق صامتاً", async () => {
    await expect(
      reconcileDoubleEntry({ month: "2026-13", branchId: BRANCH_MAIN }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("canActivate — بوابة ACTIVE", () => {
  it("تقبل حدّ 30 يوماً بالضبط عند صفر فجوات وانحراف واكتمال كل الخرائط الحالية", async () => {
    await seedShadow();

    const gate = await canActivate({ now: NOW });

    expect(gate.ok).toBe(true);
    expect(gate.shadowDays).toBe(30);
    expect(gate.mappedTypes).toBe(REQUIRED_MAPPED_ENTRY_TYPE_COUNT);
    expect(gate.unmappedEntryTypes).toEqual([]);
    expect(gate.blockers).toEqual([]);
  });

  it("تحجب الفئة النشطة أو التاريخية المستعملة بلا حساب مقابل صالح", async () => {
    await seedShadow();
    await db().insert(s.voucherCategories).values({
      id: 77,
      name: "أخرى تاريخية",
      direction: "BOTH",
      postingRole: null,
      isActive: true,
    });

    let gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(1);
    expect(gate.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "VOUCHER_CATEGORY_MAPPING" }),
    ]));

    await db().update(s.voucherCategories).set({ isActive: false })
      .where(eq(s.voucherCategories.id, 77));
    gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(0);

    await db().insert(s.receipts).values({
      branchId: BRANCH_MAIN,
      direction: "OUT",
      amount: "10.00",
      paymentMethod: "CASH",
      status: "REVERSED",
      approvalStatus: "APPROVED",
      partyType: "OTHER",
      voucherCategoryId: 77,
    });
    gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(1);
    expect(gate.blockers.map((item) => item.key)).toContain("VOUCHER_CATEGORY_MAPPING");
  });

  it("تحجب سند OTHER التاريخي والطلب النظامي الناقص ولا تعفي بادئة فقط", async () => {
    await seedShadow();
    await db().insert(s.receipts).values({
      id: 781,
      branchId: BRANCH_MAIN,
      direction: "OUT",
      amount: "10.00",
      paymentMethod: "CASH",
      status: "REVERSED",
      approvalStatus: "APPROVED",
      partyType: "OTHER",
      voucherCategoryId: null,
      referenceNumber: "LEGACY-OTHER-UNCLASSIFIED",
    });

    let gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(1);
    expect(gate.blockers.map((item) => item.key)).toContain(
      "VOUCHER_CATEGORY_MAPPING",
    );

    await db()
      .update(s.receipts)
      .set({
        referenceNumber: "SHIP-PO-77-token-77",
        internalNote:
          '@SYSTEM_PAYMENT_REQUEST:{"kind":"PURCHASE_SHIPPING","purchaseOrderId":77,"requestToken":"token-77","expectedAmount":"10.00","sourceShippingTotal":"10.00"}',
      })
      .where(eq(s.receipts.id, 781));
    gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(1);

    await db()
      .update(s.receipts)
      .set({
        referenceNumber: "EMP-ADV-7-forged",
        internalNote: null,
      })
      .where(eq(s.receipts.id, 781));
    gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(1);

    await db()
      .update(s.receipts)
      .set({ referenceNumber: "ACCRUAL-REFUND-17", internalNote: null })
      .where(eq(s.receipts.id, 781));
    gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(1);
  });

  it("تعفي سلفة الموظف فقط بدورة حياة صحيحة أو عكس canonical يصفّر السلفة", async () => {
    await seedShadow();
    await db().insert(s.accounts).values({
      code: "ADV-SAL",
      name: "Employee advance category role",
      type: "EXPENSE",
      systemRole: "SALARIES",
      isActive: true,
    });
    await db().insert(s.voucherCategories).values({
      id: 992,
      name: "رواتب مصنفة لاختبار السلفة",
      direction: "OUT",
      postingRole: "SALARIES",
      isActive: true,
    });
    await db().insert(s.employees).values({
      id: 7,
      branchId: BRANCH_MAIN,
      firstName: "علي",
      lastName: "اختبار التفعيل",
      payType: "monthly",
      salary: "1000000.00",
      allowances: "0.00",
      isActive: true,
    });
    const source = {
      employeeId: 7,
      branchId: BRANCH_MAIN,
      expectedAmount: "100.00",
      monthlyDeduction: "25.00",
      note: null,
      sourceClientRequestId: "activation-advance-exact",
    };
    const request = {
      kind: "EMPLOYEE_ADVANCE" as const,
      ...source,
      sourceHash: employeeAdvanceSourceHash(source),
    };
    const referenceNumber = employeeAdvanceReference(request);
    expect(referenceNumber).not.toBeNull();
    await db().insert(s.receipts).values({
      id: 782,
      branchId: BRANCH_MAIN,
      direction: "OUT",
      amount: "100.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      partyType: "OTHER",
      voucherCategoryId: 992,
      referenceNumber,
      internalNote: `@SYSTEM_PAYMENT_REQUEST:${JSON.stringify(request)}`,
      createdBy: ADMIN_ID,
    });
    await db().insert(s.employeeAdvances).values({
      employeeId: 7,
      branchId: BRANCH_MAIN,
      amount: "100.00",
      remaining: "100.00",
      monthlyDeduction: "25.00",
      status: "ACTIVE",
      receiptId: 782,
      createdBy: ADMIN_ID,
    });
    const insertedEntry = await db().insert(s.accountingEntries).values({
      entryType: "PAYMENT_OUT",
      branchId: BRANCH_MAIN,
      receiptId: 782,
      amount: "100.00",
      entryDate: new Date("2026-08-10T00:00:00.000Z"),
      postingProfile: "PAYMENT_OUT_RENT_CATEGORY",
      createdBy: ADMIN_ID,
    });
    const entryId = Number(insertedEntry[0].insertId);

    let gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(1);

    await db().insert(s.idempotencyKeys).values({
      operation: "voucher.create",
      clientRequestId: `ADVANCE:${request.sourceClientRequestId}`,
      refId: 782,
    });
    gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(1);

    await db()
      .update(s.accountingEntries)
      .set({
        postingProfile: "PAYMENT_OUT_EMPLOYEE_ADVANCE",
        amount: "99.00",
      })
      .where(eq(s.accountingEntries.id, entryId));
    gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(1);

    await db()
      .update(s.accountingEntries)
      .set({ amount: "100.00", branchId: BRANCH_SALES })
      .where(eq(s.accountingEntries.id, entryId));
    gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(1);

    await db()
      .update(s.accountingEntries)
      .set({ branchId: BRANCH_MAIN })
      .where(eq(s.accountingEntries.id, entryId));
    gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(0);

    await db()
      .update(s.employees)
      .set({ isActive: false })
      .where(eq(s.employees.id, 7));
    gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(0);

    await db()
      .update(s.employeeAdvances)
      .set({ status: "SETTLED", remaining: "0.00" })
      .where(eq(s.employeeAdvances.receiptId, 782));
    gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(0);

    await db()
      .update(s.employeeAdvances)
      .set({ status: "CANCELLED", remaining: "0.00" })
      .where(eq(s.employeeAdvances.receiptId, 782));
    gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(1);

    await db()
      .update(s.receipts)
      .set({ status: "REVERSED" })
      .where(eq(s.receipts.id, 782));
    gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(1);

    await db()
      .update(s.employeeAdvances)
      .set({ status: "ACTIVE", remaining: "100.00" })
      .where(eq(s.employeeAdvances.receiptId, 782));
    gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(1);

    await db()
      .update(s.employeeAdvances)
      .set({ status: "CANCELLED", remaining: "0.00" })
      .where(eq(s.employeeAdvances.receiptId, 782));
    const cancellationRequest = {
      kind: "VOUCHER_CANCELLATION" as const,
      originalReceiptId: 782,
      originalCreatorId: ADMIN_ID,
      originalDirection: "OUT" as const,
      originalPaymentMethod: "CASH" as const,
      originalReferenceNumber: referenceNumber,
      originalCheckNumber: null,
      originalCardLastFour: null,
      originalCategoryId: 992,
      attempt: 1,
      priorCancellationReceiptId: null,
      reissueReason: null,
    };
    await db().insert(s.receipts).values({
      id: 784,
      branchId: BRANCH_MAIN,
      direction: "IN",
      amount: "100.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      partyType: "OTHER",
      voucherCategoryId: 992,
      referenceNumber: "CANCEL-VCH-782",
      internalNote: `@SYSTEM_PAYMENT_REQUEST:${JSON.stringify(cancellationRequest)}`,
      createdBy: ADMIN_ID,
    });
    await db().insert(s.idempotencyKeys).values({
      operation: "voucher.create",
      clientRequestId: "voucher-cancellation-782-A1",
      refId: 784,
    });
    const cancellationEntryResult = await db()
      .insert(s.accountingEntries)
      .values({
        entryType: "PAYMENT_IN",
        branchId: BRANCH_MAIN,
        receiptId: 784,
        amount: "100.00",
        entryDate: new Date("2026-08-11T00:00:00.000Z"),
        postingProfile: "PAYMENT_IN_CATEGORY_REVERSAL",
        createdBy: ADMIN_ID,
      });
    gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(1);

    await db()
      .update(s.accountingEntries)
      .set({ postingProfile: "PAYMENT_IN_OTHER" })
      .where(
        eq(
          s.accountingEntries.id,
          Number(cancellationEntryResult[0].insertId),
        ),
      );
    gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(0);
  });

  it("تحجب طلب سلفة canonical مصنفاً إذا لم يكن مرتبطاً بمفتاح إنشاء idempotent", async () => {
    await seedShadow();
    await db().insert(s.accounts).values({
      code: "ADV-SAL",
      name: "Employee advance category role",
      type: "EXPENSE",
      systemRole: "SALARIES",
      isActive: true,
    });
    await db().insert(s.voucherCategories).values({
      id: 993,
      name: "رواتب مصنفة بطلب مزور",
      direction: "OUT",
      postingRole: "SALARIES",
      isActive: true,
    });
    await db().insert(s.employees).values({
      id: 8,
      branchId: BRANCH_MAIN,
      firstName: "موظف",
      lastName: "مصدر مزور",
      payType: "monthly",
      salary: "1000000.00",
      allowances: "0.00",
      isActive: true,
    });
    const source = {
      employeeId: 8,
      branchId: BRANCH_MAIN,
      expectedAmount: "100.00",
      monthlyDeduction: null,
      note: null,
      sourceClientRequestId: "activation-forged-pending",
    };
    const request = {
      kind: "EMPLOYEE_ADVANCE" as const,
      ...source,
      sourceHash: employeeAdvanceSourceHash(source),
    };
    await db().insert(s.receipts).values({
      id: 783,
      branchId: BRANCH_MAIN,
      direction: "OUT",
      amount: "100.00",
      paymentMethod: "CASH",
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      voucherNumber: "PV-TEST-FORGED-783",
      partyType: "OTHER",
      voucherCategoryId: 993,
      counterpartyName: "موظف مصدر مزور",
      referenceNumber: employeeAdvanceReference(request),
      internalNote: `@SYSTEM_PAYMENT_REQUEST:${JSON.stringify(request)}`,
      createdBy: ADMIN_ID,
    });

    const gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(1);
    expect(gate.blockers.map((item) => item.key)).toContain(
      "VOUCHER_CATEGORY_MAPPING",
    );

    await db().insert(s.idempotencyKeys).values({
      operation: "voucher.create",
      clientRequestId: `ADVANCE:${request.sourceClientRequestId}`,
      refId: 783,
    });
    await db()
      .update(s.employees)
      .set({ isActive: false })
      .where(eq(s.employees.id, 8));
    const inactiveGate = await canActivate({ now: NOW });
    expect(inactiveGate.voucherCategoryMappingIssueCount).toBe(1);
  });

  it("تعفي استرداد تصحيح الاستحقاق فقط مع المصدر المطابق وصفر أثر pending وقيد completed exact", async () => {
    await seedShadow();
    await db().insert(s.users).values({
      id: 2,
      openId: "double-entry-refund-owner",
      name: "المالك المراجع",
      role: "admin",
      loginMethod: "local",
      isOwner: true,
    });
    await db().insert(s.accounts).values({
      code: "TEST-OTHER-EXPENSE",
      name: "مصروفات أخرى",
      type: "EXPENSE",
      systemRole: "OTHER_EXPENSE",
      isActive: true,
    });
    await db().insert(s.voucherCategories).values({
      id: 990,
      name: "تسوية أصلية مصنفة",
      direction: "OUT",
      postingRole: "OTHER_EXPENSE",
      isActive: true,
    });
    await db().insert(s.receipts).values({
      id: 880,
      branchId: BRANCH_MAIN,
      direction: "OUT",
      amount: "10.00",
      paymentMethod: "TRANSFER",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      partyType: "OTHER",
      voucherCategoryId: 990,
      counterpartyName: "شركة النقل العراقية",
    });
    const originalEntry = await db().insert(s.accountingEntries).values({
      entryType: "PAYMENT_OUT",
      branchId: BRANCH_MAIN,
      receiptId: 880,
      amount: "10.00",
      entryDate: new Date("2026-08-10T00:00:00.000Z"),
      createdBy: ADMIN_ID,
    });
    const originalEntryId = Number(originalEntry[0].insertId);
    await db().insert(s.fixedAssets).values({
      id: 501,
      code: "AST-ACT-501",
      name: "أصل اختبار الاسترداد",
      category: "devices",
      branchId: BRANCH_MAIN,
      purchaseDate: "2026-08-10",
      purchaseValue: "10.00",
      usefulLifeYears: 5,
    });
    await db().insert(s.accrualObligations).values({
      id: 41,
      kind: "ASSET_ACQUISITION_CASH",
      branchId: BRANCH_MAIN,
      assetId: 501,
      sourceKey: "ASSET_ACCRUAL:501",
      recognizedAmount: "10.00",
      status: "REFUND_PENDING",
      beneficiaryType: "OTHER",
      beneficiaryName: "شركة النقل العراقية",
      evidenceReference: "SHIP-EVIDENCE-1",
      plannedPaymentMethod: "TRANSFER",
      clientRequestId: "activation-refund-obligation",
      sourceHash: "a".repeat(64),
      recognizedBy: ADMIN_ID,
      recognizedAt: new Date("2026-08-10T00:00:00.000Z"),
    });
    await db().insert(s.accrualObligationEvents).values({
      obligationId: 41,
      eventType: "PAYMENT_SETTLED",
      amount: "10.00",
      receiptId: 880,
      accountingEntryId: originalEntryId,
      evidenceReference: "SHIP-EVIDENCE-1",
      actorId: ADMIN_ID,
      reviewerId: 2,
      dedupeKey: "ACTIVATION:PAYMENT_SETTLED:41",
    });
    await db().insert(s.accrualCorrectionRequests).values({
      id: 17,
      obligationId: 41,
      status: "PENDING",
      previousObligationStatus: "PAID",
      reason: "إلغاء مصروف مثبت مرتين",
      externalEvidenceReference: "CORRECTION-EVIDENCE-17",
      attachmentUrl: "https://evidence.local/refund-17",
      refundPaymentMethod: "TRANSFER",
      refundReferenceNumber: "BANK-REFUND-991",
      clientRequestId: "activation-refund-correction",
      payloadHash: "b".repeat(64),
      requestedBy: ADMIN_ID,
    });
    const refundRequest = {
      kind: "ACCRUAL_CORRECTION_REFUND",
      correctionRequestId: 17,
      obligationId: 41,
      obligationSourceHash: "a".repeat(64),
      expectedAmount: "10.00",
      originalSettlementReceiptId: 880,
      providerEvidenceReference: "BANK-REFUND-991",
    } as const;
    await db().insert(s.receipts).values({
      id: 881,
      branchId: BRANCH_MAIN,
      direction: "IN",
      amount: "10.00",
      paymentMethod: "TRANSFER",
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      partyType: "OTHER",
      voucherCategoryId: null,
      counterpartyName: "شركة النقل العراقية",
      referenceNumber: "ACCRUAL-REFUND-17",
      attachmentUrl: "https://evidence.local/refund-17",
      internalNote: `@SYSTEM_PAYMENT_REQUEST:${JSON.stringify(refundRequest)}`,
    });
    await db()
      .update(s.accrualCorrectionRequests)
      .set({ refundRequestReceiptId: 881 })
      .where(eq(s.accrualCorrectionRequests.id, 17));

    let gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(0);

    await db().insert(s.accountingEntries).values({
      entryType: "PAYMENT_OUT",
      branchId: BRANCH_MAIN,
      receiptId: 881,
      amount: "-10.00",
      entryDate: new Date("2026-08-31T00:00:00.000Z"),
      postingProfile: "PAYMENT_OUT_FIXED_ASSET_ACCRUAL_SETTLEMENT",
      createdBy: 2,
    });
    gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(1);

    await db()
      .update(s.receipts)
      .set({
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        approvedBy: 2,
        approvedAt: NOW,
      })
      .where(eq(s.receipts.id, 881));
    await db()
      .update(s.accrualCorrectionRequests)
      .set({ status: "APPROVED", reviewedBy: 2, reviewedAt: NOW })
      .where(eq(s.accrualCorrectionRequests.id, 17));
    await db()
      .update(s.accrualObligations)
      .set({ status: "RECOGNITION_REVERSED" })
      .where(eq(s.accrualObligations.id, 41));
    gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(0);

    await db()
      .update(s.accountingEntries)
      .set({ amount: "10.00" })
      .where(eq(s.accountingEntries.receiptId, 881));
    gate = await canActivate({ now: NOW });
    expect(gate.voucherCategoryMappingIssueCount).toBe(1);
  });

  it("تحجب المسار الحرج الخامل إذا غاب حساب role حتى بلا حركة رواتب أو استحقاق", async () => {
    await seedShadow();
    await db()
      .update(s.accounts)
      .set({ isActive: false })
      .where(eq(s.accounts.systemRole, "PAYROLL_TAX_PAYABLE"));

    const gate = await canActivate({ now: NOW });
    expect(gate.ok).toBe(false);
    expect(gate.blockers).toContainEqual(
      expect.objectContaining({
        key: "CRITICAL_MANIFEST",
        actual: expect.stringContaining("ROLE:PAYROLL_TAX_PAYABLE"),
      }),
    );
  });

  it("تحجب قبل 30 يوماً ولو بثانية واحدة", async () => {
    await seedShadow(new Date(NOW.getTime() - 30 * 86_400_000 + 1_000));

    const gate = await canActivate({ now: NOW });

    expect(gate.ok).toBe(false);
    expect(gate.blockers.map((b) => b.key)).toContain("SHADOW_DURATION");
  });

  it("تشتق تغطية الأنواع الـ32 من سجل profiles الثابت غير القابل للتلاعب", async () => {
    await seedShadow();
    const gate = await canActivate({ now: NOW });
    expect(REQUIRED_MAPPED_ENTRY_TYPE_COUNT).toBe(CURRENT_ENTRY_TYPES.length);
    expect(REQUIRED_MAPPED_ENTRY_TYPE_COUNT).toBe(32);
    expect(MAPPED_ENTRY_TYPES.size).toBe(32);
    expect(gate.mappedTypes).toBe(32);
    expect(gate.requiredMappedTypes).toBe(32);
    expect(gate.unmappedEntryTypes).toEqual([]);
  });

  it("تحجب فجوة أو حدثاً مفقوداً أو انحرافاً في أي فرع خلال نافذة الظل", async () => {
    await seedShadow();

    const drifted = await insertSale({
      branchId: BRANCH_SALES,
      createdAt: new Date("2026-08-10T00:00:00.000Z"),
    });
    await writeSaleJournal(drifted, { branchId: BRANCH_SALES });
    await db()
      .update(s.journalLines)
      .set({ credit: "99.00" })
      .where(eq(s.journalLines.role, "SALES_STATIONERY"));

    const gapEntry = await insertSale({
      createdAt: new Date("2026-08-11T00:00:00.000Z"),
    });
    await withTx(async (tx) =>
      writeJournalGap(
        tx,
        gapEntry,
        new Date("2026-08-11T00:00:00.000Z"),
        BRANCH_MAIN,
        "فجوة",
        { cycleId: CYCLE_ID },
      ),
    );
    // نشدّ createdAt للفجوة داخل نافذة التسوية (وإلّا استُبعدت من reconcileDoubleEntryShadowWindow).
    await setGapCreatedAt(gapEntry, new Date("2026-08-11T00:00:00.000Z"));
    await insertSale({ createdAt: new Date("2026-08-12T00:00:00.000Z") });

    const gate = await canActivate({ now: NOW });
    const keys = gate.blockers.map((b) => b.key);
    expect(gate.operationalReconciliation?.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "AR",
          operationalNetDebit: expect.any(String),
          journalNetDebit: expect.any(String),
          difference: expect.any(String),
        }),
      ]),
    );
    // Slice DFP2 (٣١/٨/٢٦، تصحيح Codex #908): توسعة arrayContaining لتشمل OPERATIONAL_RECONCILIATION
    // (blocker جديد من #860 statutory accounting — يُطلق عند أي مطابقة تشغيليّة غير متطابقة).
    // arrayContaining يقبل superset ⇒ إن ظهرت blockers إضافية فلا فشل ما دام الأربعة موجودين.
    expect(keys).toEqual(
      expect.arrayContaining([
        "UNMAPPED_GAPS",
        "MISSING_JOURNALS",
        "RECONCILIATION_DRIFT",
        "OPERATIONAL_RECONCILIATION",
      ]),
    );
  });

  it("تحجب يوميةً مرتبطة بالمصدر لكنها منسوبة إلى فرع مختلف", async () => {
    await seedShadow();
    const entryId = await insertSale({
      branchId: BRANCH_MAIN,
      createdAt: new Date("2026-08-15T12:00:00.000Z"),
    });
    await writeSaleJournal(entryId, { branchId: BRANCH_SALES });

    const gate = await canActivate({ now: NOW });

    expect(gate.scopeMismatchCount).toBe(1);
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "JOURNAL_SCOPE_MISMATCH" }),
      ]),
    );
  });

  it("تحجب إن لم يكن الوضع SHADOW أو فُقد تاريخ بدايته", async () => {
    await db()
      .insert(s.doubleEntrySettings)
      .values({ id: 1, mode: "OFF", shadowStartedAt: null });
    let gate = await canActivate({ now: NOW });
    expect(gate.blockers.map((b) => b.key)).toEqual(
      expect.arrayContaining(["MODE", "SHADOW_START"]),
    );

    await db()
      .update(s.doubleEntrySettings)
      .set({ mode: "SHADOW", shadowStartedAt: null })
      .where(eq(s.doubleEntrySettings.id, 1));
    gate = await canActivate({ now: NOW });
    expect(gate.blockers.map((b) => b.key)).toContain("SHADOW_START");
  });

  it("يحجب ACTIVE عند غياب بصمة الافتتاح أو مرجع المصادقة البشرية", async () => {
    await seedShadow();
    await db()
      .update(s.doubleEntrySettings)
      .set({
        shadowOpeningHash: null,
        policyApprovalReference: null,
        policyAccountantName: null,
        policyApprovedAt: null,
        policyApprovedBy: null,
      })
      .where(eq(s.doubleEntrySettings.id, 1));

    const gate = await canActivate({ now: NOW });
    expect(gate.blockers.map((blocker) => blocker.key)).toEqual(
      expect.arrayContaining(["OPENING_SNAPSHOT", "POLICY_APPROVAL"]),
    );
  });

  it("يحجب مصادقةً قديمة مرتبطة بدورة ظل أخرى", async () => {
    await seedShadow();
    await db()
      .update(s.doubleEntrySettings)
      .set({ policyApprovalCycleId: "stale-shadow-cycle" })
      .where(eq(s.doubleEntrySettings.id, 1));

    const gate = await canActivate({ now: NOW });

    expect(gate.policyApproval).toBeNull();
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "POLICY_APPROVAL" }),
      ]),
    );
  });

  it("يحجب مصادقةً عُدّلت بصمة سياسة ترحيلها", async () => {
    await seedShadow();
    await db()
      .update(s.doubleEntrySettings)
      .set({ policyApprovalPolicyHash: "f".repeat(64) })
      .where(eq(s.doubleEntrySettings.id, 1));

    const gate = await canActivate({ now: NOW });

    expect(gate.policyApproval).toBeNull();
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "POLICY_APPROVAL" }),
      ]),
    );
  });
});

describe("تغيير وضع الدفتر — انتقالات ذرّية مُدقّقة", () => {
  it("OFF → SHADOW فقط: يثبت البداية والفاعل وسجل التدقيق داخل المعاملة", async () => {
    await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "OFF" });
    const prepared = await prepareStart();

    await withTx(async (tx) =>
      startDoubleEntryShadow(tx, {
        actorId: ADMIN_ID,
        now: NOW,
        preparationToken: prepared.preparationToken,
        expectedOpeningHash: prepared.preview.openingHash,
        allocations: prepared.preview.manualAllocations,
        auditContext: auditContext(),
      }),
    );

    const settings = (await db().select().from(s.doubleEntrySettings))[0];
    expect(settings.mode).toBe("SHADOW");
    expect(settings.shadowStartedAt?.toISOString()).toBe(NOW.toISOString());
    expect(Number(settings.updatedBy)).toBe(ADMIN_ID);
    expect(settings.shadowCycleId).toBe(prepared.preview.cycleId);
    expect(settings.shadowOpeningHash).toBe(prepared.preview.openingHash);
    expect(
      (await db().select().from(s.journalEntries))[0],
    ).toMatchObject({
      sourceType: "SHADOW_OPENING",
      postingProfile: "SHADOW_OPENING_V1",
      status: "POSTED",
      cycleId: prepared.preview.cycleId,
    });
    const logs = await db().select().from(s.auditLogs);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("doubleEntry.shadow.start");
  });

  it("يكتب شهادة MEMO افتتاحية وحيدة للشركة الجديدة ذات الأرصدة الصفرية", async () => {
    await db().insert(s.doubleEntrySettings).values({
      id: 1,
      mode: "OFF",
      policyApprovalReference: "POLICY-FROM-OLD-CYCLE",
      policyAccountantName: "محاسب دورة سابقة",
      policyApprovedAt: THIRTY_DAYS_AGO,
      policyApprovedBy: ADMIN_ID,
    });
    const prepared = await prepareDoubleEntryShadowOpening({
      actorId: ADMIN_ID,
      now: NOW,
      db: db(),
    });
    expect(prepared.preview).toMatchObject({
      canApprove: true,
      blockers: [],
      lines: [],
    });
    expect(prepared.preview.journalGroups).toHaveLength(1);

    await withTx(async (tx) =>
      startDoubleEntryShadow(tx, {
        actorId: ADMIN_ID,
        now: NOW,
        preparationToken: prepared.preparationToken,
        expectedOpeningHash: prepared.preview.openingHash,
        allocations: prepared.preview.manualAllocations,
        auditContext: auditContext(),
      }),
    );

    const heads = await db().select().from(s.journalEntries);
    expect(heads).toHaveLength(1);
    expect(heads[0]).toMatchObject({
      entryId: null,
      sourceType: "SHADOW_OPENING",
      postingProfile: "SHADOW_OPENING_V1",
      status: "MEMO",
      branchId: null,
      cycleId: prepared.preview.cycleId,
    });
    expect(await db().select().from(s.journalLines)).toHaveLength(0);
    const [settings] = await db().select().from(s.doubleEntrySettings);
    expect(settings.policyApprovalReference).toBeNull();
    expect(settings.policyAccountantName).toBeNull();
    expect(settings.policyApprovedAt).toBeNull();
    expect(settings.policyApprovedBy).toBeNull();
    expect(settings.policyApprovalCycleId).toBeNull();
    expect(settings.policyApprovalOpeningHash).toBeNull();
    expect(settings.policyApprovalPolicyHash).toBeNull();
    const gate = await canActivate({ now: NOW });
    expect(gate.openingVerification).toMatchObject({
      exists: true,
      balanced: true,
      hashMatches: true,
      entryCount: 1,
      lineCount: 0,
    });
    expect(gate.blockers.map((item) => item.key)).not.toEqual(
      expect.arrayContaining(["OPENING_SNAPSHOT", "OPENING_HASH"]),
    );
  });

  it("يمنع تكرار بدء الظل ويمنع OFF → ACTIVE", async () => {
    await seedShadow();
    await expect(
      withTx(async (tx) =>
        startDoubleEntryShadow(tx, {
          actorId: ADMIN_ID,
          now: NOW,
          preparationToken: "not-used-because-mode-is-shadow",
          expectedOpeningHash: "a".repeat(64),
          allocations: [],
          auditContext: auditContext(),
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await db()
      .update(s.doubleEntrySettings)
      .set({ mode: "OFF", shadowStartedAt: null })
      .where(eq(s.doubleEntrySettings.id, 1));
    await expect(
      withTx(async (tx) =>
        activateDoubleEntry(tx, {
          actorId: ADMIN_ID,
          now: NOW,
          auditContext: auditContext(),
        }),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await db().select().from(s.doubleEntrySettings))[0].mode).toBe(
      "OFF",
    );
  });

  it("لا يكتب لقطة صامتة ويرفض البدء إذا تغيرت الأرصدة بعد المعاينة", async () => {
    await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "OFF" });
    const prepared = await prepareStart();
    expect(await db().select().from(s.journalEntries)).toHaveLength(0);
    expect((await db().select().from(s.doubleEntrySettings))[0].mode).toBe("OFF");

    await db()
      .update(s.customers)
      .set({ currentBalance: "126.00" })
      .where(eq(s.customers.name, "عميل معاينة الافتتاح"));

    await expect(
      withTx(async (tx) =>
        startDoubleEntryShadow(tx, {
          actorId: ADMIN_ID,
          now: NOW,
          preparationToken: prepared.preparationToken,
          expectedOpeningHash: prepared.preview.openingHash,
          allocations: prepared.preview.manualAllocations,
          auditContext: auditContext(),
        }),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await db().select().from(s.doubleEntrySettings))[0].mode).toBe("OFF");
    expect(await db().select().from(s.journalEntries)).toHaveLength(0);
    expect(await db().select().from(s.auditLogs)).toHaveLength(0);
  });

  it("يرفض تغيير تخصيص الافتتاح بعد توقيع المعاينة ولا يكتب شيئاً", async () => {
    await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "OFF" });
    const prepared = await prepareStart();
    expect(prepared.preview.manualAllocations.length).toBeGreaterThan(0);

    await expect(
      withTx(async (tx) =>
        startDoubleEntryShadow(tx, {
          actorId: ADMIN_ID,
          now: NOW,
          preparationToken: prepared.preparationToken,
          expectedOpeningHash: prepared.preview.openingHash,
          allocations: [],
          auditContext: auditContext(),
        }),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect((await db().select().from(s.doubleEntrySettings))[0].mode).toBe("OFF");
    expect(await db().select().from(s.journalEntries)).toHaveLength(0);
    expect(await db().select().from(s.auditLogs)).toHaveLength(0);
  });

  it("يثبّت مصدر OPENING بعد القطع، ويسمح بتعديله في OFF ثم تلتقطه دورة جديدة بلا مسّ القديمة", async () => {
    await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "OFF" });
    const [customer] = await db()
      .insert(s.customers)
      .values({ name: "عميل افتتاح تاريخي", currentBalance: "500.00" })
      .$returningId();
    const customerId = Number(customer.id);
    await withTx(async (tx) => {
      await postOpeningEntry(tx, "CUSTOMER", customerId, "500.00");
    });

    const firstPreparation = await prepareCurrentOpening();
    await withTx(async (tx) =>
      startDoubleEntryShadow(tx, {
        actorId: ADMIN_ID,
        now: NOW,
        preparationToken: firstPreparation.preparationToken,
        expectedOpeningHash: firstPreparation.preview.openingHash,
        allocations: firstPreparation.preview.manualAllocations,
        auditContext: auditContext(),
      }),
    );
    const firstCycleId = firstPreparation.preview.cycleId;
    const [firstSettings] = await db().select().from(s.doubleEntrySettings);
    const firstOpeningHash = firstSettings.shadowOpeningHash;
    const oldHeadsBefore = await db()
      .select()
      .from(s.journalEntries)
      .where(eq(s.journalEntries.cycleId, firstCycleId));
    const oldLinesBefore = await db()
      .select()
      .from(s.journalLines)
      .innerJoin(s.journalEntries, eq(s.journalLines.journalId, s.journalEntries.id))
      .where(eq(s.journalEntries.cycleId, firstCycleId));

    for (const target of ["800.00", "0.00"]) {
      await expect(
        withTx(async (tx) =>
          upsertOpeningEntry(tx, "CUSTOMER", customerId, target),
        ),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    }
    const [sourceAfterRejectedChanges] = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "OPENING"));
    expect(sourceAfterRejectedChanges.amount).toBe("500.00");
    expect((await db().select().from(s.doubleEntrySettings))[0].shadowOpeningHash).toBe(
      firstOpeningHash,
    );
    expect(
      await db()
        .select()
        .from(s.journalEntries)
        .where(eq(s.journalEntries.cycleId, firstCycleId)),
    ).toEqual(oldHeadsBefore);

    await withTx(async (tx) =>
      stopDoubleEntry(tx, {
        actorId: ADMIN_ID,
        reason: "إيقاف الدورة لتصحيح مصدر الافتتاح قبل دورة جديدة",
        auditContext: auditContext(),
      }),
    );
    const correction = await withTx(async (tx) =>
      upsertOpeningEntry(tx, "CUSTOMER", customerId, "800.00"),
    );
    expect(correction.delta).toBe("300.00");
    await db()
      .update(s.customers)
      .set({ currentBalance: "800.00" })
      .where(eq(s.customers.id, customerId));

    const secondPreparation = await prepareCurrentOpening();
    await withTx(async (tx) =>
      startDoubleEntryShadow(tx, {
        actorId: ADMIN_ID,
        now: NOW,
        preparationToken: secondPreparation.preparationToken,
        expectedOpeningHash: secondPreparation.preview.openingHash,
        allocations: secondPreparation.preview.manualAllocations,
        auditContext: auditContext(),
      }),
    );

    expect(secondPreparation.preview.cycleId).not.toBe(firstCycleId);
    expect(
      await db()
        .select()
        .from(s.journalEntries)
        .where(eq(s.journalEntries.cycleId, firstCycleId)),
    ).toEqual(oldHeadsBefore);
    expect(
      await db()
        .select()
        .from(s.journalLines)
        .innerJoin(s.journalEntries, eq(s.journalLines.journalId, s.journalEntries.id))
        .where(eq(s.journalEntries.cycleId, firstCycleId)),
    ).toEqual(oldLinesBefore);
    const [newArLine] = await db()
      .select({ debit: s.journalLines.debit })
      .from(s.journalLines)
      .innerJoin(s.journalEntries, eq(s.journalLines.journalId, s.journalEntries.id))
      .where(
        and(
          eq(s.journalEntries.cycleId, secondPreparation.preview.cycleId),
          eq(s.journalLines.role, "AR"),
        ),
      );
    expect(newArLine.debit).toBe("800.00");
  });

  it("SHADOW → ACTIVE لا يتم إلا بعد اجتياز البوابة ويُدقَّق", async () => {
    await seedShadow();
    await seedApprovedStatutoryProfile();

    const result = await withTx(async (tx) =>
      activateDoubleEntry(tx, {
        actorId: ADMIN_ID,
        now: NOW,
        auditContext: auditContext(),
      }),
    );

    expect(result.gate.ok).toBe(true);
    expect((await db().select().from(s.doubleEntrySettings))[0].mode).toBe(
      "ACTIVE",
    );
    expect((await db().select().from(s.auditLogs))[0].action).toBe(
      "doubleEntry.activate",
    );
    const health = await canActivate({ now: NOW });
    expect(health.mode).toBe("ACTIVE");
    expect(health.blockers.map((item) => item.key)).not.toContain("MODE");
    expect(health.ok).toBe(true);
  });

  it("مانعٌ واحد يُرجع محاولة SHADOW → ACTIVE بلا تغييرٍ ولا تدقيق", async () => {
    await seedShadow(new Date(NOW.getTime() - 29 * 86_400_000));

    await expect(
      withTx(async (tx) =>
        activateDoubleEntry(tx, {
          actorId: ADMIN_ID,
          now: NOW,
          auditContext: auditContext(),
        }),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect((await db().select().from(s.doubleEntrySettings))[0].mode).toBe(
      "SHADOW",
    );
    expect(await db().select().from(s.auditLogs)).toHaveLength(0);
  });

  it("فشل سجل التدقيق يُرجع تغيير الوضع كله", async () => {
    await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "OFF" });
    const prepared = await prepareStart();
    const tooLongIp = "x".repeat(200);

    await expect(
      withTx(async (tx) =>
        startDoubleEntryShadow(tx, {
          actorId: ADMIN_ID,
          now: NOW,
          preparationToken: prepared.preparationToken,
          expectedOpeningHash: prepared.preview.openingHash,
          allocations: prepared.preview.manualAllocations,
          auditContext: auditContext(tooLongIp),
        }),
      ),
    ).rejects.toBeTruthy();

    expect((await db().select().from(s.doubleEntrySettings))[0].mode).toBe(
      "OFF",
    );
    expect(await db().select().from(s.auditLogs)).toHaveLength(0);
    expect(await db().select().from(s.journalEntries)).toHaveLength(0);
  });

  it("يسجل مرجع مصادقة المحاسب ويمسحه بسبب مدقق قبل ACTIVE", async () => {
    await seedShadow();
    await withTx(async (tx) =>
      approveDoubleEntryPolicy(tx, {
        actorId: ADMIN_ID,
        reference: "POLICY-REF-2026-08",
        accountantName: "علي المحاسب",
        now: NOW,
        auditContext: auditContext(),
      }),
    );
    let [settings] = await db().select().from(s.doubleEntrySettings);
    expect(settings.policyApprovalReference).toBe("POLICY-REF-2026-08");
    expect(settings.policyAccountantName).toBe("علي المحاسب");
    expect(settings.policyApprovedAt?.toISOString()).toBe(NOW.toISOString());
    expect(settings.policyApprovalCycleId).toBe(CYCLE_ID);
    expect(settings.policyApprovalOpeningHash).toBe(settings.shadowOpeningHash);
    expect(settings.policyApprovalPolicyHash).toBe(POSTING_POLICY_HASH);

    await withTx(async (tx) =>
      clearDoubleEntryPolicyApproval(tx, {
        actorId: ADMIN_ID,
        reason: "استبدال مرجع المصادقة بنسخة محدثة",
        auditContext: auditContext(),
      }),
    );
    [settings] = await db().select().from(s.doubleEntrySettings);
    expect(settings.policyApprovalReference).toBeNull();
    expect(settings.policyAccountantName).toBeNull();
    expect(settings.policyApprovedAt).toBeNull();
    expect(settings.policyApprovedBy).toBeNull();
    expect(settings.policyApprovalCycleId).toBeNull();
    expect(settings.policyApprovalOpeningHash).toBeNull();
    expect(settings.policyApprovalPolicyHash).toBeNull();
    expect((await db().select().from(s.auditLogs)).map((row) => row.action)).toEqual([
      "doubleEntry.policy.approve",
      "doubleEntry.policy.clear",
    ]);
  });

  it("يمنع تغيير مصادقة السياسة داخل ACTIVE", async () => {
    await db().insert(s.doubleEntrySettings).values({
      id: 1,
      mode: "ACTIVE",
      shadowCycleId: CYCLE_ID,
    });
    await expect(
      withTx(async (tx) =>
        approveDoubleEntryPolicy(tx, {
          actorId: ADMIN_ID,
          reference: "POLICY-REF-2026-08",
          accountantName: "علي المحاسب",
          auditContext: auditContext(),
        }),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it.each(["SHADOW", "ACTIVE"] as const)(
    "%s → OFF: يتطلب سبباً، يدقّق الانتقال، ويحفظ اليوميات التاريخية",
    async (mode) => {
      await db().insert(s.doubleEntrySettings).values({
        id: 1,
        mode,
        shadowStartedAt: THIRTY_DAYS_AGO,
        shadowCycleId: CYCLE_ID,
        shadowOpeningHash: "a".repeat(64),
        policyApprovalReference: "OLD-POLICY-APPROVAL",
        policyApprovalCycleId: CYCLE_ID,
        policyApprovalOpeningHash: "a".repeat(64),
        policyApprovalPolicyHash: POSTING_POLICY_HASH,
        policyAccountantName: "محاسب قديم",
        policyApprovedAt: THIRTY_DAYS_AGO,
        policyApprovedBy: ADMIN_ID,
        updatedBy: ADMIN_ID,
      });
      const entryId = await insertSale({});
      await writeSaleJournal(entryId);

      const result = await withTx(async (tx) =>
        stopDoubleEntry(tx, {
          actorId: ADMIN_ID,
          reason: "إيقاف تشغيلي للتحقق من إعدادات الحسابات",
          auditContext: auditContext(),
        }),
      );

      expect(result.mode).toBe("OFF");
      const settings = (await db().select().from(s.doubleEntrySettings))[0];
      expect(settings.mode).toBe("OFF");
      expect(settings.shadowStartedAt).toBeNull();
      expect(settings.shadowCycleId).toBeNull();
      expect(settings.shadowOpeningHash).toBeNull();
      expect(settings.policyApprovalReference).toBeNull();
      expect(settings.policyApprovalCycleId).toBeNull();
      expect(settings.policyApprovalOpeningHash).toBeNull();
      expect(settings.policyApprovalPolicyHash).toBeNull();
      expect(Number(settings.updatedBy)).toBe(ADMIN_ID);
      expect(await db().select().from(s.journalEntries)).toHaveLength(1);
      expect(await db().select().from(s.journalLines)).not.toHaveLength(0);
      const [audit] = await db().select().from(s.auditLogs);
      expect(audit.action).toBe("doubleEntry.stop");
      expect(JSON.stringify(audit.newValue)).toContain("إيقاف تشغيلي");
    },
  );

  it("يرفض OFF بلا سبب فعلي ويبقي الوضع واليوميات كما هي", async () => {
    await seedShadow();
    await expect(
      withTx(async (tx) =>
        stopDoubleEntry(tx, {
          actorId: ADMIN_ID,
          reason: "   ",
          auditContext: auditContext(),
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect((await db().select().from(s.doubleEntrySettings))[0].mode).toBe(
      "SHADOW",
    );
    expect(await db().select().from(s.auditLogs)).toHaveLength(0);
  });

  it("تنتظر ACTIVE معاملة مالية جارية ثم ترى فجوتها قبل القرار", async () => {
    await seedShadow();

    let releaseWriter!: () => void;
    const writerCanCommit = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let writerHasLock!: () => void;
    const writerLocked = new Promise<void>((resolve) => {
      writerHasLock = resolve;
    });

    const writer = withTx(async (tx) => {
      expect(await getDoubleEntryMode(tx)).toBe("SHADOW");
      const inserted = await tx
        .insert(s.accountingEntries)
        .values({
          entryType: "SALE",
          branchId: BRANCH_MAIN,
          entryDate: new Date("2026-08-30T00:00:00.000Z"),
          amount: "12.00",
          revenue: "12.00",
          cost: "0.00",
          profit: "12.00",
          postingCycleId: CYCLE_ID,
          createdAt: new Date("2026-08-30T12:00:00.000Z"),
        })
        .$returningId();
      await writeJournalGap(
        tx,
        Number(inserted[0].id),
        new Date("2026-08-30T00:00:00.000Z"),
        BRANCH_MAIN,
        "فجوة متزامنة",
        { cycleId: CYCLE_ID },
      );
      // نفس علة `setGapCreatedAt` أعلاه، لكنّ التثبيت هنا **داخل المعاملة** (`tx` لا `db()`):
      // القفل محجوزٌ هنا عمداً لاختبار التنازع، فنداءٌ من اتّصالٍ آخر يتعلّق عليه ويُجمّد الاختبار.
      // وبلا التثبيت يسقط رأسُ الفجوة خارج النافذة فيُحجَب التفعيل بـ`MISSING_JOURNALS`
      // (مصدرٌ بلا يومية) بدل الفجوة نفسها ⇒ الاختبار يمرّ لسببٍ غير الذي يدّعيه اسمُه.
      await tx
        .update(s.journalEntries)
        .set({ createdAt: new Date("2026-08-30T00:00:00.000Z") })
        .where(eq(s.journalEntries.entryId, Number(inserted[0].id)));
      writerHasLock();
      await writerCanCommit;
    });
    await writerLocked;

    let activationSettled = false;
    const activation = withTx(async (tx) =>
      activateDoubleEntry(tx, {
        actorId: ADMIN_ID,
        now: NOW,
        auditContext: auditContext(),
      }),
    ).finally(() => {
      activationSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(activationSettled).toBe(false);

    releaseWriter();
    await writer;
    await expect(activation).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect((await db().select().from(s.doubleEntrySettings))[0].mode).toBe(
      "SHADOW",
    );
  });
});
