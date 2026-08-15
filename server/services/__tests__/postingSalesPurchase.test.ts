import { readFileSync } from "node:fs";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refundRouterMocks = vi.hoisted(() => ({
  approve: vi.fn(async () => ({
    receiptId: 77,
    status: "COMPLETED" as const,
    approvalStatus: "APPROVED" as const,
    replayed: false as const,
  })),
  listPending: vi.fn(async () => [
    {
      receiptId: 77,
      workOrderId: 9,
      orderNumber: "WO-9",
      amount: "2000.00",
      paymentMethod: "CARD" as const,
      customerId: 4,
      customerName: "عميل",
      createdBy: 5,
      creatorName: "منشئ",
      createdAt: new Date("2026-08-15T10:00:00Z"),
      status: "PENDING" as const,
      approvalStatus: "PENDING_APPROVAL" as const,
      confirmationReference: null,
      description: "طلب رد",
    },
  ]),
  status: vi.fn(async (workOrderId: number) => ({
    workOrderId,
    status: "PENDING" as const,
    amount: "2000.00",
  })),
}));

vi.mock("../workOrder/cancel", () => ({
  approveWorkOrderCancellationRefund: refundRouterMocks.approve,
  getWorkOrderCancellationRefundStatus: refundRouterMocks.status,
  listPendingWorkOrderCancellationRefunds: refundRouterMocks.listPending,
}));
import {
  createPostingIntent,
  creditLine,
  debitLine,
  signedPostingLines,
  validatePostingIntentPolicy,
  type AccountRole,
  type JournalLine,
} from "../accounting/postingEngine";
import { classifyGiftPosting } from "../sale/giftPosting";
import { paymentAssetRole } from "../sale/paymentPosting";
import { workOrderRouter } from "../../routers/workOrderRouter";

function balanceOf(lines: readonly JournalLine[], role: AccountRole): Decimal {
  return lines
    .filter((line) => line.role === role)
    .reduce(
      (sum, line) => sum.plus(line.debit).minus(line.credit),
      new Decimal(0),
    );
}

describe("P2 sales and purchase posting contracts", () => {
  it("separates merchandise, delivery, tax and owned inventory on a sale", () => {
    const intent = createPostingIntent("SALE_INVENTORY", "SALE", [
      debitLine("AR", "1160"),
      creditLine("SALES_STATIONERY", "1000"),
      creditLine("DELIVERY_REVENUE", "100"),
      creditLine("TAX_PAYABLE", "60"),
      debitLine("COGS", "700"),
      creditLine("INVENTORY", "700"),
    ]);

    expect(balanceOf(intent.lines, "AR").toFixed(2)).toBe("1160.00");
    expect(balanceOf(intent.lines, "DELIVERY_REVENUE").toFixed(2)).toBe(
      "-100.00",
    );
    expect(balanceOf(intent.lines, "TAX_PAYABLE").toFixed(2)).toBe("-60.00");
    expect(balanceOf(intent.lines, "INVENTORY").toFixed(2)).toBe("-700.00");
  });

  it("keeps a pure service sale out of inventory", () => {
    const intent = createPostingIntent(
      "SALE_SERVICE",
      "SALE",
      [debitLine("AR", "1000"), creditLine("SALES_PRINT", "1000")],
      { roleDebits: { AR: "1000" }, roleCredits: { SALES_PRINT: "1000" } },
    );

    expect(
      intent.lines.some(
        (line) => line.role === "INVENTORY" || line.role === "COGS",
      ),
    ).toBe(false);
  });

  it("rejects a journal whose COGS declaration is 5 when the document source proves 60", () => {
    const intent = createPostingIntent(
      "SALE_INVENTORY",
      "SALE",
      [
        debitLine("AR", "100"),
        creditLine("SALES_STATIONERY", "100"),
        debitLine("COGS", "5"),
        creditLine("INVENTORY", "5"),
      ],
      {
        roleDebits: { AR: "100", COGS: "5" },
        roleCredits: { SALES_STATIONERY: "100", INVENTORY: "5" },
      },
    );

    expect(() =>
      validatePostingIntentPolicy(intent, "SALE", {
        amount: "100",
        revenue: "100",
        cost: "60",
        roleDebits: { AR: "100", COGS: "60" },
        roleCredits: { SALES_STATIONERY: "100", INVENTORY: "60" },
      }),
    ).toThrow(/source role components do not match/);
  });

  it("expenses service recipe materials exactly when the service consumes inventory", () => {
    const intent = createPostingIntent(
      "SALE_SERVICE",
      "SALE",
      [
        debitLine("AR", "1000"),
        creditLine("SALES_PRINT", "1000"),
        debitLine("COGS", "125"),
        creditLine("INVENTORY", "125"),
      ],
      {
        roleDebits: { AR: "1000", COGS: "125" },
        roleCredits: { SALES_PRINT: "1000", INVENTORY: "125" },
      },
    );

    expect(balanceOf(intent.lines, "COGS").toFixed(2)).toBe("125.00");
    expect(balanceOf(intent.lines, "INVENTORY").toFixed(2)).toBe("-125.00");
  });

  it("splits a mixed sale and a mixed partial return across their real revenue sectors", () => {
    const sale = createPostingIntent(
      "SALE_MIXED",
      "SALE",
      [
        debitLine("AR", "300"),
        creditLine("SALES_STATIONERY", "100"),
        creditLine("SALES_PRINT", "200"),
        debitLine("COGS", "50"),
        creditLine("INVENTORY", "50"),
      ],
      {
        roleDebits: { AR: "300", COGS: "50" },
        roleCredits: {
          SALES_STATIONERY: "100",
          SALES_PRINT: "200",
          INVENTORY: "50",
        },
      },
    );
    const partialReturn = createPostingIntent(
      "RETURN_SALE_MIXED",
      "RETURN",
      [
        debitLine("SALES_STATIONERY", "40"),
        debitLine("SALES_PRINT", "60"),
        creditLine("AR", "100"),
        debitLine("INVENTORY", "20"),
        creditLine("COGS", "20"),
      ],
      {
        roleDebits: {
          SALES_STATIONERY: "40",
          SALES_PRINT: "60",
          INVENTORY: "20",
        },
        roleCredits: { AR: "100", COGS: "20" },
      },
    );

    expect(balanceOf(sale.lines, "SALES_STATIONERY").toFixed(2)).toBe(
      "-100.00",
    );
    expect(balanceOf(sale.lines, "SALES_PRINT").toFixed(2)).toBe("-200.00");
    expect(balanceOf(partialReturn.lines, "SALES_STATIONERY").toFixed(2)).toBe(
      "40.00",
    );
    expect(balanceOf(partialReturn.lines, "SALES_PRINT").toFixed(2)).toBe(
      "60.00",
    );
    expect(balanceOf(partialReturn.lines, "INVENTORY").toFixed(2)).toBe(
      "20.00",
    );
    expect(() =>
      validatePostingIntentPolicy(sale, "SALE", {
        amount: "300",
        revenue: "300",
        // المصدر الدفتري يثبت COGS المملوك فقط؛ تكلفة الخدمة/الأمانة لا تُنسب إلى INVENTORY.
        cost: "50",
        roleDebits: { AR: "300", COGS: "50" },
        roleCredits: {
          SALES_STATIONERY: "100",
          SALES_PRINT: "200",
          INVENTORY: "50",
        },
      }),
    ).not.toThrow();
    expect(() =>
      validatePostingIntentPolicy(partialReturn, "RETURN", {
        amount: "-100",
        revenue: "-100",
        cost: "-20",
        roleDebits: {
          SALES_STATIONERY: "40",
          SALES_PRINT: "60",
          INVENTORY: "20",
        },
        roleCredits: { AR: "100", COGS: "20" },
      }),
    ).not.toThrow();
  });

  it("recognizes consignor share as COGS against consignment payable", () => {
    const intent = createPostingIntent(
      "PURCHASE_CONSIGNMENT",
      "PURCHASE",
      [debitLine("COGS", "600"), creditLine("CONSIGNMENT_PAYABLE", "600")],
      {
        roleDebits: { COGS: "600" },
        roleCredits: { CONSIGNMENT_PAYABLE: "600" },
      },
    );

    expect(balanceOf(intent.lines, "COGS").toFixed(2)).toBe("600.00");
    expect(balanceOf(intent.lines, "CONSIGNMENT_PAYABLE").toFixed(2)).toBe(
      "-600.00",
    );
  });

  it("posts received merchandise and input tax against supplier AP", () => {
    const intent = createPostingIntent("PURCHASE_INVENTORY", "PURCHASE", [
      debitLine("INVENTORY", "1000"),
      debitLine("TAX_PAYABLE", "50"),
      creditLine("AP", "1050"),
    ]);

    expect(balanceOf(intent.lines, "INVENTORY").toFixed(2)).toBe("1000.00");
    expect(balanceOf(intent.lines, "TAX_PAYABLE").toFixed(2)).toBe("50.00");
    expect(balanceOf(intent.lines, "AP").toFixed(2)).toBe("-1050.00");
  });

  it("removes a purchase return at WAVG carrying value and exposes supplier-price variance", () => {
    const intent = createPostingIntent(
      "RETURN_PURCHASE_INVENTORY",
      "RETURN",
      [
        debitLine("AP", "50"),
        debitLine("PURCHASE_PRICE_VARIANCE", "25"),
        creditLine("INVENTORY", "75"),
      ],
      {
        roleDebits: { AP: "50", PURCHASE_PRICE_VARIANCE: "25" },
        roleCredits: { INVENTORY: "75" },
      },
    );

    expect(balanceOf(intent.lines, "INVENTORY").toFixed(2)).toBe("-75.00");
    expect(balanceOf(intent.lines, "PURCHASE_PRICE_VARIANCE").toFixed(2)).toBe(
      "25.00",
    );
    expect(balanceOf(intent.lines, "AP").toFixed(2)).toBe("50.00");
  });

  it("moves work-order materials inventory to WIP, then releases or cancels it", () => {
    const consume = createPostingIntent(
      "ADJUST_WIP_CONSUME",
      "ADJUST",
      [debitLine("WORK_IN_PROGRESS", "200"), creditLine("INVENTORY", "200")],
      {
        roleDebits: { WORK_IN_PROGRESS: "200" },
        roleCredits: { INVENTORY: "200" },
      },
    );
    const deliver = createPostingIntent(
      "SALE_SERVICE_FLEX",
      "SALE",
      [
        debitLine("AR", "500"),
        creditLine("SALES_FLEX", "500"),
        debitLine("COGS", "200"),
        creditLine("WORK_IN_PROGRESS", "200"),
      ],
      {
        roleDebits: { AR: "500", COGS: "200" },
        roleCredits: { SALES_FLEX: "500", WORK_IN_PROGRESS: "200" },
      },
    );
    const cancel = createPostingIntent(
      "ADJUST_WIP_CANCEL",
      "ADJUST",
      [debitLine("INVENTORY", "200"), creditLine("WORK_IN_PROGRESS", "200")],
      {
        roleDebits: { INVENTORY: "200" },
        roleCredits: { WORK_IN_PROGRESS: "200" },
      },
    );

    expect(
      balanceOf(
        [...consume.lines, ...deliver.lines],
        "WORK_IN_PROGRESS",
      ).toFixed(2),
    ).toBe("0.00");
    expect(
      balanceOf([...consume.lines, ...deliver.lines], "INVENTORY").toFixed(2),
    ).toBe("-200.00");
    expect(
      balanceOf(
        [...consume.lines, ...cancel.lines],
        "WORK_IN_PROGRESS",
      ).toFixed(2),
    ).toBe("0.00");
    expect(
      balanceOf([...consume.lines, ...cancel.lines], "INVENTORY").toFixed(2),
    ).toBe("0.00");
  });

  it("maps every receipt instrument to its actual asset account", () => {
    expect(paymentAssetRole("CASH", "DRAWER", "IN")).toBe("CASH");
    expect(paymentAssetRole("CASH", "TREASURY", "OUT")).toBe("TREASURY_CASH");
    expect(paymentAssetRole("CARD", null, "IN")).toBe("CARD_BANK");
    expect(paymentAssetRole("TRANSFER", null, "OUT")).toBe("CARD_BANK");
    expect(paymentAssetRole("CHECK", null, "IN")).toBe("CHECKS_RECEIVABLE");
    expect(paymentAssetRole("CHECK", null, "OUT")).toBe("CARD_BANK");
    expect(paymentAssetRole("WALLET", null, "IN")).toBe("PAYMENT_WALLET");
    expect(paymentAssetRole("WALLET", null, "OUT")).toBe("PAYMENT_WALLET");
    expect(paymentAssetRole("TELECOM", null, "IN")).toBe("TELECOM_BALANCE");
    expect(paymentAssetRole("TELECOM", null, "OUT")).toBe("TELECOM_BALANCE");
    expect(() => paymentAssetRole("CASH", null, "IN")).toThrow();
  });

  it("validates received and issued cheques against different independent asset sources", () => {
    const receivedSource = {
      roleDebits: { CHECKS_RECEIVABLE: "100" },
      roleCredits: { AR: "100" },
    };
    const received = createPostingIntent(
      "PAYMENT_IN_CUSTOMER",
      "PAYMENT_IN",
      [debitLine("CHECKS_RECEIVABLE", "100"), creditLine("AR", "100")],
      receivedSource,
    );
    const issuedSource = {
      roleDebits: { AR: "100" },
      roleCredits: { CARD_BANK: "100" },
    };
    const issued = createPostingIntent(
      "PAYMENT_OUT_CUSTOMER_REFUND",
      "PAYMENT_OUT",
      [debitLine("AR", "100"), creditLine("CARD_BANK", "100")],
      issuedSource,
    );

    expect(() =>
      validatePostingIntentPolicy(received, "PAYMENT_IN", {
        amount: "100",
        roleDebits: receivedSource.roleDebits,
        roleCredits: receivedSource.roleCredits,
      }),
    ).not.toThrow();
    expect(() =>
      validatePostingIntentPolicy(issued, "PAYMENT_OUT", {
        amount: "100",
        roleDebits: issuedSource.roleDebits,
        roleCredits: issuedSource.roleCredits,
      }),
    ).not.toThrow();
  });

  it("does not reverse COGS when a customer return is not restocked", () => {
    const intent = createPostingIntent("RETURN_SALE_INVENTORY", "RETURN", [
      debitLine("SALES_STATIONERY", "1000"),
      debitLine("TAX_PAYABLE", "50"),
      creditLine("AR", "1050"),
    ]);

    expect(
      intent.lines.some(
        (line) => line.role === "INVENTORY" || line.role === "COGS",
      ),
    ).toBe(false);
  });

  it("reverses consignment and rounding legs without negative journal lines", () => {
    const consignment = createPostingIntent(
      "PURCHASE_CONSIGNMENT",
      "PURCHASE",
      signedPostingLines("COGS", "CONSIGNMENT_PAYABLE", "-600"),
      {
        roleDebits: { CONSIGNMENT_PAYABLE: "600" },
        roleCredits: { COGS: "600" },
      },
    );
    const rounding = createPostingIntent(
      "ADJUST_ROUNDING",
      "ADJUST",
      signedPostingLines("AR", "ROUNDING_DIFF", "-50"),
    );

    expect(balanceOf(consignment.lines, "CONSIGNMENT_PAYABLE").toFixed(2)).toBe(
      "600.00",
    );
    expect(balanceOf(consignment.lines, "COGS").toFixed(2)).toBe("-600.00");
    expect(balanceOf(rounding.lines, "AR").toFixed(2)).toBe("-50.00");
    expect(
      [...consignment.lines, ...rounding.lines].every(
        (line) =>
          new Decimal(line.debit).gte(0) && new Decimal(line.credit).gte(0),
      ),
    ).toBe(true);
  });

  it("classifies gifts in their dedicated promotion expense role", () => {
    const gift = createPostingIntent("GIFT_OUT_PROMO", "GIFT_OUT", [
      debitLine("GIFTS_PROMO", "75"),
      creditLine("INVENTORY", "75"),
    ]);
    const consignmentGift = createPostingIntent(
      "PURCHASE_CONSIGNMENT",
      "PURCHASE",
      [debitLine("GIFTS_PROMO", "30"), creditLine("CONSIGNMENT_PAYABLE", "30")],
      {
        roleDebits: { GIFTS_PROMO: "30" },
        roleCredits: { CONSIGNMENT_PAYABLE: "30" },
      },
    );

    expect(balanceOf(gift.lines, "GIFTS_PROMO").toFixed(2)).toBe("75.00");
    expect(balanceOf(consignmentGift.lines, "GIFTS_PROMO").toFixed(2)).toBe(
      "30.00",
    );
  });

  it("uses memo and mixed gift profiles on create without duplicating consignor expense", () => {
    const pureConsignment = classifyGiftPosting("80", "0", 1);
    const mixed = classifyGiftPosting("100", "40", 1);

    expect(pureConsignment.intent.profile).toBe("GIFT_OUT_CONSIGNMENT_MEMO");
    expect(pureConsignment.intent.lines).toHaveLength(0);
    expect(pureConsignment.consignmentRemainder.toFixed(2)).toBe("80.00");
    expect(mixed.intent.profile).toBe("GIFT_OUT_MIXED_PROMO");
    expect(balanceOf(mixed.intent.lines, "GIFTS_PROMO").toFixed(2)).toBe(
      "40.00",
    );
    expect(balanceOf(mixed.intent.lines, "INVENTORY").toFixed(2)).toBe(
      "-40.00",
    );
    expect(mixed.consignmentRemainder.toFixed(2)).toBe("60.00");
  });

  it("uses signed memo and mixed profiles for both return and cancellation reversals", () => {
    const pureConsignmentReturn = classifyGiftPosting("80", "0", -1);
    const mixedReturn = classifyGiftPosting("100", "40", -1);
    const pureConsignmentCancel = classifyGiftPosting("50", "0", -1);
    const mixedCancel = classifyGiftPosting("75", "25", -1);

    expect(pureConsignmentReturn.intent.profile).toBe(
      "GIFT_OUT_CONSIGNMENT_MEMO",
    );
    expect(pureConsignmentCancel.intent.lines).toHaveLength(0);
    expect(mixedReturn.intent.profile).toBe("GIFT_OUT_MIXED_PROMO");
    expect(balanceOf(mixedReturn.intent.lines, "GIFTS_PROMO").toFixed(2)).toBe(
      "-40.00",
    );
    expect(balanceOf(mixedReturn.intent.lines, "INVENTORY").toFixed(2)).toBe(
      "40.00",
    );
    expect(balanceOf(mixedCancel.intent.lines, "GIFTS_PROMO").toFixed(2)).toBe(
      "-25.00",
    );
    expect(balanceOf(mixedCancel.intent.lines, "INVENTORY").toFixed(2)).toBe(
      "25.00",
    );
  });

  it("keeps correction overpay fail-closed without inventing an OUT receipt or PAYMENT_OUT", () => {
    const historicalPayment = createPostingIntent(
      "PAYMENT_IN_CUSTOMER",
      "PAYMENT_IN",
      [debitLine("CASH", "1000"), creditLine("AR", "1000")],
    );
    const correctedSale = createPostingIntent("SALE_INVENTORY", "SALE", [
      debitLine("AR", "700"),
      creditLine("SALES_STATIONERY", "700"),
    ]);
    const arBalance = balanceOf(
      [...historicalPayment.lines, ...correctedSale.lines],
      "AR",
    );

    expect(arBalance.toFixed(2)).toBe("-300.00");

    const source = readFileSync(
      new URL("../sale/correct.ts", import.meta.url),
      "utf8",
    );
    const marker = "لا توجد حركة نقدية هنا";
    expect(source).not.toContain(marker);
    const overpayStart = source.indexOf("if (overpay.gt(0))");
    const overpayEnd = source.indexOf("const overpayHandled:", overpayStart);
    expect(overpayStart).toBeGreaterThanOrEqual(0);
    expect(overpayEnd).toBeGreaterThan(overpayStart);
    const overpayBranch = source.slice(overpayStart, overpayEnd);
    const executableOverpayBranch = overpayBranch.replace(/\/\/.*$/gm, "");
    expect(executableOverpayBranch).toContain("throw new TRPCError");
    expect(executableOverpayBranch).not.toMatch(
      /insert\(receipts\)|postEntry\(|PAYMENT_OUT|adjustCustomerBalance\(/,
    );
  });
});

function refundApprovalCaller(
  user: {
    id: number;
    role: "admin" | "manager" | "cashier";
    isOwner: boolean;
  },
  branchId = 1,
) {
  return workOrderRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      ...user,
      branchId,
      permissionsOverride: null,
      totpEnabledAt: new Date(),
    },
  } as never);
}

describe("workOrders.approveCancellationRefund authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects non-owners before calling the refund materializer", async () => {
    await expect(
      refundApprovalCaller({
        id: 5,
        role: "manager",
        isOwner: false,
      }).approveCancellationRefund({
        receiptId: 77,
        confirmationReference: "CARD-REFUND-77",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(refundRouterMocks.approve).not.toHaveBeenCalled();
  });

  it("routes owner approval to the materializer and audits the receipt", async () => {
    await expect(
      refundApprovalCaller({
        id: 3,
        role: "admin",
        isOwner: true,
      }).approveCancellationRefund({
        receiptId: 77,
        confirmationReference: "CARD-REFUND-77",
      }),
    ).resolves.toMatchObject({ receiptId: 77, status: "COMPLETED" });

    expect(refundRouterMocks.approve).toHaveBeenCalledWith(
      77,
      { userId: 3, branchId: 1, role: "admin", isOwner: true },
      "CARD-REFUND-77",
      expect.objectContaining({
        user: expect.objectContaining({ id: 3, isOwner: true }),
      }),
    );
  });

  it("keeps the pending refund queue owner-only and returns its explicit contract", async () => {
    await expect(
      refundApprovalCaller({
        id: 5,
        role: "manager",
        isOwner: false,
      }).pendingCancellationRefunds(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const rows = await refundApprovalCaller({
      id: 3,
      role: "admin",
      isOwner: true,
    }).pendingCancellationRefunds();
    expect(rows).toEqual([
      expect.objectContaining({
        receiptId: 77,
        workOrderId: 9,
        orderNumber: "WO-9",
        amount: "2000.00",
        paymentMethod: "CARD",
        status: "PENDING",
        approvalStatus: "PENDING_APPROVAL",
        confirmationReference: null,
      }),
    ]);
  });

  it("scopes durable refund status by branch and employee ownership", async () => {
    await expect(
      refundApprovalCaller({
        id: 8,
        role: "cashier",
        isOwner: false,
      }).cancellationRefundStatus({ workOrderId: 9 }),
    ).resolves.toEqual({
      workOrderId: 9,
      status: "PENDING",
      amount: "2000.00",
    });
    expect(refundRouterMocks.status).toHaveBeenLastCalledWith(9, {
      branchId: 1,
      ownerId: 8,
    });

    await refundApprovalCaller({
      id: 3,
      role: "admin",
      isOwner: true,
    }).cancellationRefundStatus({ workOrderId: 9 });
    expect(refundRouterMocks.status).toHaveBeenLastCalledWith(9, {
      branchId: null,
      ownerId: null,
    });
  });

  it("encodes the direct source and reserves confirmation before materialization", () => {
    const source = readFileSync(
      new URL("../workOrder/cancel.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      "WORK_ORDER_CUSTOMER_REFUND:DIRECT:${workOrderId}:${Number(depRcpt.id)}",
    );
    expect(source).toContain("legacySources.length !== 1");
    const approvalStart = source.indexOf("const confirmationOperation");
    const approvalSource = source.slice(approvalStart);
    const reserveAt = approvalSource.indexOf("await recordIdempotencyKey(");
    const materializeAt = approvalSource.indexOf(
      "await tx.update(receipts).set({",
    );
    expect(approvalStart).toBeGreaterThan(0);
    expect(reserveAt).toBeGreaterThan(0);
    expect(materializeAt).toBeGreaterThan(reserveAt);
  });
});
