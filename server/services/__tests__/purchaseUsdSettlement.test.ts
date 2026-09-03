import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { settlePurchaseUsdDirect } from "../purchase/usdSettlement";
import {
  approveVoucher,
  rejectVoucher,
  resubmitRejectedExpensePayment,
} from "../voucher/approval";
import { cancelVoucher } from "../voucher/cancel";
import {
  encodeSystemPaymentRequest,
  parseSystemPaymentRequest,
} from "../voucher/create";
import { purchaseUsdSettlementReference } from "../purchase/usdSettlementRequest";
import { truncateTables } from "./__testUtils__";

const maker = {
  userId: 1,
  branchId: 1,
  role: "admin" as const,
  isOwner: true,
};
const checker = {
  userId: 2,
  branchId: 1,
  role: "admin" as const,
  isOwner: true,
};
const thirdOwner = {
  userId: 3,
  branchId: 1,
  role: "admin" as const,
  isOwner: true,
};

const TABLES = [
  "auditLogs",
  "idempotencyKeys",
  "journalLines",
  "journalEntries",
  "accountingEntries",
  "receipts",
  "purchaseOrderItems",
  "purchaseOrders",
  "suppliers",
  "shifts",
  "branches",
  "users",
];

function db() {
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set for tests");
  return database;
}

async function seed() {
  const database = db();
  await database.insert(s.branches).values({
    id: 1,
    name: "الرئيسي",
    code: "MAIN",
    type: "MAIN",
  });
  await database.insert(s.users).values([
    {
      id: 1,
      openId: "usd-maker",
      name: "المنشئ",
      role: "admin",
      loginMethod: "local",
      branchId: 1,
      isOwner: true,
      isActive: true,
    },
    {
      id: 2,
      openId: "usd-checker",
      name: "المعتمد",
      role: "admin",
      loginMethod: "local",
      branchId: 1,
      isOwner: true,
      isActive: true,
    },
    {
      id: 3,
      openId: "usd-third",
      name: "مالك ثالث",
      role: "admin",
      loginMethod: "local",
      branchId: 1,
      isOwner: true,
      isActive: true,
    },
  ]);
  await database.insert(s.suppliers).values({
    id: 1,
    name: "مورد USD",
    currentBalance: "290000.00",
    currentBalanceUsd: "200.00",
    isActive: true,
  });
  await database.insert(s.purchaseOrders).values({
    id: 1,
    poNumber: "PO-USD-1",
    supplierId: 1,
    branchId: 1,
    subtotal: "290000.00",
    total: "290000.00",
    paidAmount: "0.00",
    status: "RECEIVED",
    agreedCurrency: "USD",
    usdTotal: "200.00",
    agreedRate: "1450.0000",
    paidUsd: "0.00",
    returnedUsd: "0.00",
    createdBy: 1,
  });
  await database.insert(s.accountingEntries).values({
    entryType: "PURCHASE",
    branchId: 1,
    purchaseOrderId: 1,
    supplierId: 1,
    amount: "290000.00",
    entryDate: new Date(),
    dedupeKey: "TEST:USD:PURCHASE:1",
  });
}

async function requestUsd(clientRequestId: string, settledUsd = "100.00") {
  return settlePurchaseUsdDirect(
    {
      purchaseOrderId: 1,
      settledUsd,
      chargedIqd: "147000.00",
      feeIqd: "1000.00",
      method: "CARD",
      referenceNumber: `CARD-AUTH-${clientRequestId}`,
      cardLastFour: "4242",
      clientRequestId,
    },
    maker,
  );
}

async function purchaseState() {
  const database = db();
  const [po] = await database
    .select()
    .from(s.purchaseOrders)
    .where(eq(s.purchaseOrders.id, 1));
  const [supplier] = await database
    .select()
    .from(s.suppliers)
    .where(eq(s.suppliers.id, 1));
  return { po, supplier };
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

describe("governed direct USD purchase settlement", () => {
  it("rejects a cross-branch service caller before reserving or posting", async () => {
    await expect(
      settlePurchaseUsdDirect(
        {
          purchaseOrderId: 1,
          settledUsd: "100.00",
          chargedIqd: "147000.00",
          feeIqd: "1000.00",
          method: "CARD",
          referenceNumber: "CARD-AUTH-CROSS-BRANCH",
          cardLastFour: "4242",
          clientRequestId: "usd-cross-branch",
        },
        { userId: 3, branchId: 2, role: "manager" },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.idempotencyKeys)).toHaveLength(0);
    expect(await purchaseState()).toMatchObject({
      po: { paidAmount: "0.00", paidUsd: "0.00" },
      supplier: {
        currentBalance: "290000.00",
        currentBalanceUsd: "200.00",
      },
    });
  });

  it("stays financially inert until a different owner approves, then posts once", async () => {
    const request = await requestUsd("usd-happy");
    expect(request).toMatchObject({
      approvalStatus: "PENDING_APPROVAL",
      carryingIqd: "145000.00",
      cashOutIqd: "148000.00",
      fxDiff: "-2000.00",
      idempotent: false,
    });
    const [pending] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, request.receiptId));
    expect(pending).toMatchObject({
      status: "PENDING",
      direction: "OUT",
      amount: "148000.00",
      paymentMethod: "CARD",
      cardLastFour: "4242",
      cashBucket: null,
    });
    expect(parseSystemPaymentRequest(pending.internalNote)).toMatchObject({
      kind: "PURCHASE_SUPPLIER_USD",
      settledUsd: "100.00",
      carryingIqd: "145000.00",
      paymentEvidenceReference: "CARD-AUTH-usd-happy",
    });
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.receiptId, request.receiptId)),
    ).toHaveLength(0);
    let state = await purchaseState();
    expect(state.po.paidAmount).toBe("0.00");
    expect(state.po.paidUsd).toBe("0.00");
    expect(state.supplier.currentBalance).toBe("290000.00");
    expect(state.supplier.currentBalanceUsd).toBe("200.00");

    await expect(
      approveVoucher(request.receiptId, maker),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await approveVoucher(request.receiptId, checker);
    state = await purchaseState();
    expect(state.po.paidAmount).toBe("145000.00");
    expect(state.po.paidUsd).toBe("100.00");
    expect(state.supplier.currentBalance).toBe("145000.00");
    expect(state.supplier.currentBalanceUsd).toBe("100.00");
    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.receiptId, request.receiptId));
    expect(entries.map((entry) => entry.entryType).sort()).toEqual([
      "EXCHANGE_FEE",
      "EXCHANGE_FX_DIFF",
      "PAYMENT_OUT",
    ]);

    const replay = await requestUsd("usd-happy");
    expect(replay).toMatchObject({
      receiptId: request.receiptId,
      idempotent: true,
    });
    const approvalReplay = await approveVoucher(request.receiptId, checker);
    expect(approvalReplay.replayed).toBe(true);
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.receiptId, request.receiptId)),
    ).toHaveLength(3);
  });

  it("rechecks shortages at approval and rolls back without a partial effect", async () => {
    const request = await requestUsd("usd-race");
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "72500.00", currentBalanceUsd: "50.00" })
      .where(eq(s.suppliers.id, 1));

    await expect(
      approveVoucher(request.receiptId, checker),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const [receipt] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, request.receiptId));
    expect(receipt).toMatchObject({
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      signatureHash: null,
    });
    const state = await purchaseState();
    expect(state.po.paidAmount).toBe("0.00");
    expect(state.po.paidUsd).toBe("0.00");
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.receiptId, request.receiptId)),
    ).toHaveLength(0);
  });

  it("preserves rejection/resubmission lineage and approves only the replacement", async () => {
    const first = await requestUsd("usd-reject");
    await rejectVoucher(first.receiptId, checker, "مرجع البطاقة يحتاج مراجعة");
    const replacement = await resubmitRejectedExpensePayment(
      first.receiptId,
      maker,
      {
        priorReceiptId: first.receiptId,
        reissueReason: "تمت مطابقة المرجع مع كشف البطاقة",
        note: "إعادة تقديم موثقة",
      },
    );
    expect(replacement).toMatchObject({
      rootReceiptId: first.receiptId,
      priorReceiptId: first.receiptId,
      attempt: 1,
      approvalStatus: "PENDING_APPROVAL",
      replayed: false,
    });
    const [rejected, pending] = await Promise.all([
      db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.id, first.receiptId))
        .then((rows) => rows[0]),
      db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.id, replacement.receiptId))
        .then((rows) => rows[0]),
    ]);
    expect(rejected).toMatchObject({
      status: "FAILED",
      approvalStatus: "REJECTED",
    });
    expect(pending.internalNote).toBe(rejected.internalNote);
    expect(pending.description).toContain(`بعد السند #${first.receiptId}`);
    await approveVoucher(replacement.receiptId, checker);
    const state = await purchaseState();
    expect(state.po.paidUsd).toBe("100.00");
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.receiptId, first.receiptId)),
    ).toHaveLength(0);
  });

  it("governs cancellation reissue and fully reverses AP, USD, asset, FX and fee", async () => {
    const original = await requestUsd("usd-cancel");
    await approveVoucher(original.receiptId, checker);

    const firstCancellation = await cancelVoucher(original.receiptId, maker);
    await rejectVoucher(
      Number(firstCancellation.approvalReceiptId),
      thirdOwner,
      "تأجيل الإلغاء حتى مطابقة كشف البطاقة",
    );
    const secondCancellation = await cancelVoucher(original.receiptId, maker);
    expect(secondCancellation.approvalReceiptId).not.toBe(
      firstCancellation.approvalReceiptId,
    );
    await approveVoucher(Number(secondCancellation.approvalReceiptId), checker);

    const state = await purchaseState();
    expect(state.po.paidAmount).toBe("0.00");
    expect(state.po.paidUsd).toBe("0.00");
    expect(state.supplier.currentBalance).toBe("290000.00");
    expect(state.supplier.currentBalanceUsd).toBe("200.00");
    const [originalReceipt] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, original.receiptId));
    expect(originalReceipt.status).toBe("REVERSED");
    const reversalEntries = await db()
      .select()
      .from(s.accountingEntries)
      .where(
        eq(
          s.accountingEntries.receiptId,
          Number(secondCancellation.approvalReceiptId),
        ),
      );
    expect(
      reversalEntries.map((entry) => [entry.entryType, entry.amount]).sort(),
    ).toEqual(
      [
        ["EXCHANGE_FEE", "-1000.00"],
        ["EXCHANGE_FX_DIFF", "2000.00"],
        ["PAYMENT_IN", "145000.00"],
      ].sort(),
    );
    await approveVoucher(Number(secondCancellation.approvalReceiptId), checker);
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .where(
          eq(
            s.accountingEntries.receiptId,
            Number(secondCancellation.approvalReceiptId),
          ),
        ),
    ).toHaveLength(3);
  });

  it("keeps a provable legacy no-voucher receipt read-only because cache attribution is not provable", async () => {
    const legacyReceiptResult = await db().insert(s.receipts).values({
      branchId: 1,
      direction: "OUT",
      amount: "148000.00",
      paymentMethod: "CARD",
      referenceNumber: "LEGACY-CARD-AUTH-900",
      partyType: "SUPPLIER",
      partyId: 1,
      description: "USD 100 settlement for PO-USD-1",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      createdBy: 1,
    });
    const legacyReceiptId = extractInsertId(legacyReceiptResult);
    await db()
      .insert(s.accountingEntries)
      .values([
        {
          entryType: "PAYMENT_OUT",
          branchId: 1,
          purchaseOrderId: 1,
          supplierId: 1,
          receiptId: legacyReceiptId,
          amount: "145000.00",
          entryDate: new Date(),
          dedupeKey: `POUSD-PAY:${legacyReceiptId}`,
        },
        {
          entryType: "EXCHANGE_FX_DIFF",
          branchId: 1,
          purchaseOrderId: 1,
          supplierId: 1,
          receiptId: legacyReceiptId,
          amount: "-2000.00",
          entryDate: new Date(),
          dedupeKey: `POUSD-FX:${legacyReceiptId}`,
        },
        {
          entryType: "EXCHANGE_FEE",
          branchId: 1,
          purchaseOrderId: 1,
          supplierId: 1,
          receiptId: legacyReceiptId,
          amount: "1000.00",
          cost: "1000.00",
          profit: "-1000.00",
          entryDate: new Date(),
          dedupeKey: `POUSD-FEE:${legacyReceiptId}`,
        },
      ]);
    await db()
      .update(s.purchaseOrders)
      .set({ paidAmount: "145000.00", paidUsd: "100.00" })
      .where(eq(s.purchaseOrders.id, 1));
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "145000.00", currentBalanceUsd: "100.00" })
      .where(eq(s.suppliers.id, 1));

    await expect(cancelVoucher(legacyReceiptId, maker)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const [unchanged] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, legacyReceiptId));
    expect(unchanged.voucherNumber).toBeNull();
    expect(unchanged.referenceNumber).toBe("LEGACY-CARD-AUTH-900");
    expect(unchanged.internalNote).toBeNull();
    expect(unchanged.cardLastFour).toBeNull();
    const state = await purchaseState();
    expect(state.po.paidAmount).toBe("145000.00");
    expect(state.po.paidUsd).toBe("100.00");
    expect(state.supplier.currentBalance).toBe("145000.00");
    expect(state.supplier.currentBalanceUsd).toBe("100.00");

    const requestToken = "0123456789abcdef";
    const repairedReference = purchaseUsdSettlementReference(
      "PO-USD-1",
      requestToken,
    );
    await db()
      .update(s.receipts)
      .set({
        voucherNumber: `PV-USD-LEGACY-${legacyReceiptId}`,
        referenceNumber: repairedReference,
        internalNote: encodeSystemPaymentRequest({
          kind: "PURCHASE_SUPPLIER_USD",
          purchaseOrderId: 1,
          requestToken,
          settledUsd: "100.00",
          carryingIqd: "145000.00",
          chargedIqd: "147000.00",
          feeIqd: "1000.00",
          expectedAmount: "148000.00",
          sourceTotal: "290000.00",
          sourceUsdTotal: "200.00",
          sourceAgreedRate: "1450.0000",
          paymentMethod: "CARD",
          paymentEvidenceReference: "LEGACY-CARD-AUTH-900",
          cardLastFour: null,
          legacyReceiptId,
        }),
      })
      .where(eq(s.receipts.id, legacyReceiptId));
    await expect(cancelVoucher(legacyReceiptId, maker)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await purchaseState()).toMatchObject({
      po: { paidAmount: "145000.00", paidUsd: "100.00" },
      supplier: {
        currentBalance: "145000.00",
        currentBalanceUsd: "100.00",
      },
    });
    expect(
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.referenceNumber, `CANCEL-VCH-${legacyReceiptId}`)),
    ).toHaveLength(0);
  });

  it("rejects unsupported methods and missing instrument evidence", async () => {
    await expect(
      settlePurchaseUsdDirect(
        {
          purchaseOrderId: 1,
          settledUsd: "10.00",
          chargedIqd: "14500.00",
          method: "CASH",
          referenceNumber: "cash",
          clientRequestId: "usd-cash",
        } as never,
        maker,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      settlePurchaseUsdDirect(
        {
          purchaseOrderId: 1,
          settledUsd: "10.00",
          chargedIqd: "14500.00",
          method: "CARD",
          referenceNumber: "CARD-AUTH-MISSING-LAST4",
          clientRequestId: "usd-card-no-last4",
        },
        maker,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
