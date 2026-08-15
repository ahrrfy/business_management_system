import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { voucherCategoryRouter } from "../../routers/voucherRouter";
import { POSTING_POLICY_HASH } from "../accounting/postingEngine";
import { approveVoucher, cancelVoucher, createVoucher } from "../voucherService";
import { truncateTables } from "./__testUtils__";

const maker = { userId: 2, branchId: 1, role: "manager" } as const;
const owner = { userId: 1, branchId: 1, role: "admin" } as const;
const secondOwner = { userId: 3, branchId: 1, role: "admin" } as const;
const CYCLE = "voucher-category-test-cycle";
const OPENING_HASH = "a".repeat(64);

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function categoryAdminCaller() {
  return voucherCategoryRouter.createCaller({
    req: { headers: {}, id: "voucher-category-test" },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      id: 1,
      role: "admin",
      branchId: 1,
      permissionsOverride: null,
      totpEnabledAt: new Date(),
    },
  } as unknown as TrpcContext);
}

async function setMode(mode: "OFF" | "SHADOW" | "ACTIVE") {
  if (mode === "OFF") return;
  await db().insert(s.doubleEntrySettings).values(
    mode === "SHADOW"
      ? { id: 1, mode, shadowCycleId: CYCLE }
      : {
          id: 1,
          mode,
          shadowCycleId: CYCLE,
          shadowOpeningHash: OPENING_HASH,
          policyApprovalReference: "VOUCHER-CATEGORY-POLICY",
          policyApprovalPolicyHash: POSTING_POLICY_HASH,
          policyApprovalCycleId: CYCLE,
          policyApprovalOpeningHash: OPENING_HASH,
          policyAccountantName: "محاسب اختبار الفئات",
          policyApprovedAt: new Date("2026-08-15T00:00:00.000Z"),
          policyApprovedBy: 1,
        },
  );
}

async function entriesFor(receiptId: number) {
  return db()
    .select()
    .from(s.accountingEntries)
    .where(eq(s.accountingEntries.receiptId, receiptId));
}

async function journalLinesForEntry(entryId: number) {
  const [head] = await db()
    .select()
    .from(s.journalEntries)
    .where(eq(s.journalEntries.entryId, entryId));
  expect(head).toMatchObject({ status: "POSTED" });
  return db()
    .select()
    .from(s.journalLines)
    .where(eq(s.journalLines.journalId, head!.id));
}

beforeEach(async () => {
  await truncateTables([
    "auditLogs",
    "journalLines",
    "journalEntries",
    "accountingEntries",
    "idempotencyKeys",
    "receipts",
    "doubleEntrySettings",
    "voucherCategories",
    "branches",
    "users",
  ]);
  await db().insert(s.branches).values({
    id: 1,
    name: "الرئيسي",
    code: "MAIN",
    type: "MAIN",
  });
  await db().insert(s.users).values([
    {
      id: 1,
      openId: "voucher-category-owner",
      name: "مالك معتمد",
      role: "admin",
      loginMethod: "local",
      branchId: 1,
      isOwner: true,
    },
    {
      id: 2,
      openId: "voucher-category-maker",
      name: "منشئ السند",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
      isOwner: true,
    },
    {
      id: 3,
      openId: "voucher-category-second-owner",
      name: "مالك اعتماد الإلغاء",
      role: "admin",
      loginMethod: "local",
      branchId: 1,
      isOwner: true,
    },
  ]);
  await db().insert(s.voucherCategories).values([
    {
      id: 10,
      name: "إيجار مصنف",
      direction: "OUT",
      postingRole: "RENT",
      isActive: true,
    },
    {
      id: 11,
      name: "إيراد متفرق مصنف",
      direction: "IN",
      postingRole: "OTHER_REVENUE",
      isActive: true,
    },
    {
      id: 12,
      name: "فئة تاريخية تحتاج اعتماداً",
      direction: "OUT",
      postingRole: null,
      isActive: true,
    },
  ]);
});

describe("voucher category exact double-entry", () => {
  it("يرفض OTHER بلا فئة أو بفئة غير معيّنة حتى في OFF ولا يدرج إيصالاً", async () => {
    await expect(
      createVoucher(
        {
          voucherType: "PAYMENT",
          branchId: 1,
          amount: "125000.00",
          paymentMethod: "TRANSFER",
          partyType: "OTHER",
          counterpartyName: "مالك العقار",
          description: "إيجار",
          referenceNumber: "OTHER-NO-CATEGORY",
          clientRequestId: "other-no-category",
        },
        maker,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      createVoucher(
        {
          voucherType: "PAYMENT",
          branchId: 1,
          amount: "125000.00",
          paymentMethod: "TRANSFER",
          partyType: "OTHER",
          counterpartyName: "مالك العقار",
          description: "إيجار",
          referenceNumber: "OTHER-UNMAPPED-CATEGORY",
          voucherCategoryId: 12,
          clientRequestId: "other-unmapped-category",
        },
        maker,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it.each(["SHADOW", "ACTIVE"] as const)(
    "%s: يبقي PENDING صفري الأثر ثم يرحّل الصرف والعكس بدليل exact واحد",
    async (mode) => {
      await setMode(mode);
      const input = {
        voucherType: "PAYMENT" as const,
        branchId: 1,
        amount: "125000.00",
        paymentMethod: "TRANSFER" as const,
        partyType: "OTHER" as const,
        counterpartyName: "مالك العقار",
        description: "إيجار مصنف",
        referenceNumber: `CATEGORY-OUT-${mode}`,
        voucherCategoryId: 10,
        clientRequestId: `category-out-${mode.toLowerCase()}`,
      };
      const request = await createVoucher(input, maker);
      const replay = await createVoucher(input, maker);
      expect(replay.receiptId).toBe(request.receiptId);
      await expect(
        createVoucher({ ...input, voucherCategoryId: 12 }, maker),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(request.approvalStatus).toBe("PENDING_APPROVAL");
      expect(await entriesFor(request.receiptId)).toHaveLength(0);
      expect(await db().select().from(s.journalEntries)).toHaveLength(0);

      await expect(
        categoryAdminCaller().update({ id: 10, postingRole: "OTHER_EXPENSE" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      await approveVoucher(request.receiptId, owner);
      const approvalReplay = await approveVoucher(request.receiptId, owner);
      expect(approvalReplay.replayed).toBe(true);
      const [materialized] = await entriesFor(request.receiptId);
      expect(materialized).toMatchObject({
        entryType: "PAYMENT_OUT",
        postingProfile: "PAYMENT_OUT_CATEGORY",
        amount: "125000.00",
      });
      expect(materialized!.postingIntentJson).toMatchObject({
        sourceComponents: {
          roleDebits: { RENT: "125000.00" },
          roleCredits: { CARD_BANK: "125000.00" },
        },
      });
      expect(await journalLinesForEntry(materialized!.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "RENT", debit: "125000.00", credit: "0.00" }),
          expect.objectContaining({ role: "CARD_BANK", debit: "0.00", credit: "125000.00" }),
        ]),
      );

      const cancellation = await cancelVoucher(request.receiptId, owner);
      expect(cancellation.status).toBe("PENDING_APPROVAL");
      expect(await entriesFor(request.receiptId)).toHaveLength(1);
      expect(await entriesFor(Number(cancellation.approvalReceiptId))).toHaveLength(0);
      await expect(
        approveVoucher(Number(cancellation.approvalReceiptId), owner),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await approveVoucher(Number(cancellation.approvalReceiptId), secondOwner);
      await expect(cancelVoucher(request.receiptId, owner)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      const [compensatingReceipt] = await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.referenceNumber, `CANCEL-VCH-${request.receiptId}`));
      expect(compensatingReceipt).toMatchObject({
        direction: "IN",
        voucherCategoryId: 10,
      });
      const [reversal] = await entriesFor(compensatingReceipt!.id);
      expect(reversal).toMatchObject({
        entryType: "PAYMENT_IN",
        postingProfile: "PAYMENT_IN_CATEGORY_REVERSAL",
        amount: "125000.00",
      });
      expect(reversal!.postingIntentJson).toMatchObject({
        sourceComponents: {
          roleDebits: { CARD_BANK: "125000.00" },
          roleCredits: { RENT: "125000.00" },
        },
      });
      expect(await entriesFor(request.receiptId)).toHaveLength(1);
      expect(await entriesFor(compensatingReceipt!.id)).toHaveLength(1);
    },
  );

  it("يرحّل القبض المصنف وعكسه بالاتجاهين الصحيحين", async () => {
    await setMode("SHADOW");
    const request = await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "80000.00",
        paymentMethod: "CASH",
        partyType: "OTHER",
        counterpartyName: "طرف إيراد",
        description: "إيراد متفرق",
        referenceNumber: "CATEGORY-IN-SHADOW",
        voucherCategoryId: 11,
        clientRequestId: "category-in-shadow",
      },
      maker,
    );
    expect(await entriesFor(request.receiptId)).toHaveLength(0);
    await approveVoucher(request.receiptId, owner);
    const [materialized] = await entriesFor(request.receiptId);
    expect(materialized).toMatchObject({
      postingProfile: "PAYMENT_IN_CATEGORY",
      amount: "80000.00",
    });

    const cancellation = await cancelVoucher(request.receiptId, owner);
    expect(cancellation.status).toBe("PENDING_APPROVAL");
    expect(await entriesFor(Number(cancellation.approvalReceiptId))).toHaveLength(0);
    await approveVoucher(Number(cancellation.approvalReceiptId), secondOwner);
    const [compensatingReceipt] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.referenceNumber, `CANCEL-VCH-${request.receiptId}`));
    expect(compensatingReceipt.voucherCategoryId).toBe(11);
    const [reversal] = await entriesFor(compensatingReceipt.id);
    expect(reversal).toMatchObject({
      entryType: "PAYMENT_OUT",
      postingProfile: "PAYMENT_OUT_CATEGORY_REVERSAL",
      amount: "80000.00",
    });
    expect(reversal!.postingIntentJson).toMatchObject({
      sourceComponents: {
        roleDebits: { OTHER_REVENUE: "80000.00" },
        roleCredits: { TREASURY_CASH: "80000.00" },
      },
    });
  });

  it("يعالج OTHER التاريخي NULL ذرياً ويمنع تصنيف الطلب النظامي المتخصص", async () => {
    await db().insert(s.receipts).values([
      {
        id: 90,
        branchId: 1,
        direction: "IN",
        amount: "15000.00",
        paymentMethod: "TRANSFER",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        partyType: "OTHER",
        voucherNumber: "RV-LEGACY-90",
        referenceNumber: "LEGACY-OTHER-90",
        counterpartyName: "طرف تاريخي",
        voucherCategoryId: null,
      },
      {
        id: 91,
        branchId: 1,
        direction: "OUT",
        amount: "12000.00",
        paymentMethod: "CASH",
        status: "PENDING",
        approvalStatus: "PENDING_APPROVAL",
        partyType: "OTHER",
        voucherNumber: "PV-SYSTEM-91",
        referenceNumber: "SHIP-PO-91-token-91",
        internalNote:
          '@SYSTEM_PAYMENT_REQUEST:{"kind":"PURCHASE_SHIPPING","purchaseOrderId":91,"requestToken":"token-91","expectedAmount":"12000.00","sourceShippingTotal":"12000.00"}',
        counterpartyName: "شركة نقل",
        voucherCategoryId: null,
      },
    ]);

    const before = await categoryAdminCaller().unclassifiedOther();
    expect(before).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 90, specialized: false }),
        expect.objectContaining({ id: 91, specialized: true }),
      ]),
    );
    await categoryAdminCaller().assignHistoricalCategory({
      receiptId: 90,
      voucherCategoryId: 11,
    });
    await expect(
      categoryAdminCaller().assignHistoricalCategory({
        receiptId: 90,
        voucherCategoryId: 11,
      }),
    ).resolves.toMatchObject({ ok: true, changed: false });
    await expect(
      categoryAdminCaller().assignHistoricalCategory({
        receiptId: 91,
        voucherCategoryId: 10,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const [classified] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, 90));
    expect(classified.voucherCategoryId).toBe(11);
    const audits = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.entityId, 90));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("voucherCategory.remediateHistorical");
  });

  it("يسمح بدمج فئة legacy ذات postingRole NULL في هدف متوافق مصنف", async () => {
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "OUT",
      amount: "1.00",
      paymentMethod: "TRANSFER",
      status: "REVERSED",
      approvalStatus: "APPROVED",
      partyType: "OTHER",
      voucherNumber: "PV-LEGACY-MERGE",
      voucherCategoryId: 12,
    });
    await categoryAdminCaller().merge({ fromId: 12, toId: 10 });
    const [receipt] = await db().select().from(s.receipts);
    const [source] = await db()
      .select()
      .from(s.voucherCategories)
      .where(eq(s.voucherCategories.id, 12));
    expect(receipt.voucherCategoryId).toBe(10);
    expect(source.isActive).toBe(false);
  });

  it("serializes legacy category merge against voucher approval without a deadlock", async () => {
    await setMode("SHADOW");
    const inserted = await db()
      .insert(s.receipts)
      .values({
        branchId: 1,
        direction: "OUT",
        amount: "25000.00",
        paymentMethod: "TRANSFER",
        status: "PENDING",
        approvalStatus: "PENDING_APPROVAL",
        partyType: "OTHER",
        voucherNumber: "PV-MERGE-RACE",
        referenceNumber: "MERGE-RACE-APPROVAL",
        counterpartyName: "Legacy category counterparty",
        description: "Legacy category approval race",
        voucherCategoryId: 12,
        createdBy: maker.userId,
      })
      .$returningId();
    const receiptId = Number(inserted[0].id);

    const outcomes = await Promise.allSettled([
      categoryAdminCaller().merge({ fromId: 12, toId: 10 }),
      approveVoucher(receiptId, secondOwner),
    ]);

    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(String(outcome.reason)).not.toMatch(/ER_LOCK_DEADLOCK|deadlock/i);
      }
    }
    expect(outcomes[0].status).toBe("fulfilled");

    // Both valid serial orders converge: merge-first approves immediately;
    // approval-first fails closed on the unmapped legacy category, then the
    // independent owner approves after merge has committed.
    await approveVoucher(receiptId, secondOwner);

    const [receipt] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, receiptId));
    const [source] = await db()
      .select()
      .from(s.voucherCategories)
      .where(eq(s.voucherCategories.id, 12));
    const entries = await entriesFor(receiptId);
    expect(receipt).toMatchObject({
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      voucherCategoryId: 10,
    });
    expect(source.isActive).toBe(false);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entryType: "PAYMENT_OUT",
      postingProfile: "PAYMENT_OUT_CATEGORY",
      amount: "25000.00",
    });
  });

  it("retries merge against OTHER creation and never leaves a receipt on the disabled source", async () => {
    await db()
      .update(s.voucherCategories)
      .set({ postingRole: "RENT" })
      .where(eq(s.voucherCategories.id, 12));

    const outcomes = await Promise.allSettled([
      categoryAdminCaller().merge({ fromId: 12, toId: 10 }),
      createVoucher(
        {
          voucherType: "PAYMENT",
          branchId: 1,
          amount: "100.00",
          paymentMethod: "TRANSFER",
          partyType: "OTHER",
          counterpartyName: "Category merge race counterparty",
          description: "Category merge against voucher creation",
          referenceNumber: "CATEGORY-MERGE-CREATE-RACE",
          voucherCategoryId: 12,
          clientRequestId: "category-merge-create-race",
        },
        maker,
      ),
    ]);

    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(String(outcome.reason)).not.toMatch(
          /ER_LOCK_DEADLOCK|deadlock/i,
        );
      }
    }
    expect(outcomes[0].status).toBe("fulfilled");

    const [source] = await db()
      .select()
      .from(s.voucherCategories)
      .where(eq(s.voucherCategories.id, 12));
    const stranded = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.voucherCategoryId, 12));
    const created = await db()
      .select()
      .from(s.receipts)
      .where(
        eq(s.receipts.referenceNumber, "CATEGORY-MERGE-CREATE-RACE"),
      );

    expect(source.isActive).toBe(false);
    expect(stranded).toHaveLength(0);
    if (outcomes[1].status === "fulfilled") {
      expect(created).toHaveLength(1);
      expect(created[0].voucherCategoryId).toBe(10);
    } else {
      expect(created).toHaveLength(0);
    }
  });
});
