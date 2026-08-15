import { beforeEach, describe, expect, it } from "vitest";
import { appRouter } from "../../routers";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import * as s from "../../../drizzle/schema";
import { POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE } from "@shared/posPaymentPolicy";
import { truncateTables } from "../../services/__tests__/__testUtils__";

const EXTERNAL_METHODS = ["CARD", "CHECK", "TRANSFER", "WALLET", "TELECOM"] as const;

function context(role: "cashier" | "admin", id: number): TrpcContext {
  return {
    req: { headers: {} } as TrpcContext["req"],
    res: { cookie() {}, clearCookie() {} } as unknown as TrpcContext["res"],
    user: {
      id,
      role,
      branchId: 1,
      name: role,
      email: `${role}@test.local`,
      isActive: true,
    } as TrpcContext["user"],
  };
}

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function expectNoExternalMoneyTrail() {
  expect(await db().select().from(s.externalPaymentAttempts)).toHaveLength(0);
  expect(await db().select().from(s.invoices)).toHaveLength(0);
  expect(await db().select().from(s.receipts)).toHaveLength(0);
  expect((await db().select().from(s.accountingEntries)).filter((row) => row.entryType === "PAYMENT_IN")).toHaveLength(0);
}

beforeEach(async () => {
  await truncateTables(["externalPaymentAttempts", "accountingEntries", "receipts", "invoiceItems", "invoices"]);
});

describe("POS/PrintPOS API external payment policy", () => {
  it.each(EXTERNAL_METHODS)("rejects %s initiation from both public POS APIs before persistence", async (method) => {
    const cashier = appRouter.createCaller(context("cashier", 10));
    const owner = appRouter.createCaller(context("admin", 11));
    const input = {
      branchId: 1,
      method,
      amount: "100.00",
      reference: `REF-${method}`,
      requestId: `REQ-${method}`,
      deviceId: "API-POS-1",
    };

    await expect(cashier.sales.initiateExternalPayment(input)).rejects.toThrow(POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE);
    await expect(owner.printPos.initiateExternalPayment(input)).rejects.toThrow(POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE);
    await expectNoExternalMoneyTrail();
  });

  it("rejects confirmation for cashier and owner before attempt lookup", async () => {
    const cashier = appRouter.createCaller(context("cashier", 10));
    const owner = appRouter.createCaller(context("admin", 11));

    await expect(cashier.sales.confirmExternalPayment({ branchId: 1, attemptId: 999, deviceId: "API-POS-1" }))
      .rejects.toThrow(POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE);
    await expect(owner.printPos.confirmExternalPayment({ branchId: 1, attemptId: 999, deviceId: "API-POS-1" }))
      .rejects.toThrow(POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE);
    await expectNoExternalMoneyTrail();
  });

  it.each(EXTERNAL_METHODS)("rejects %s sale, print sale, and later-payment requests at the API boundary", async (method) => {
    const owner = appRouter.createCaller(context("admin", 11));
    const payment = { amount: "100.00", method, externalPaymentAttemptId: 1 };

    await expect(owner.sales.create({
      branchId: 1,
      sourceType: "POS",
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      payment,
      clientRequestId: `SALE-${method}`,
    })).rejects.toThrow(POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE);

    await expect(owner.printPos.createSale({
      branchId: 1,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "100.00" }],
      payment,
      clientRequestId: `PRINT-${method}`,
    })).rejects.toThrow(POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE);

    await expect(owner.sales.pay({
      invoiceId: 1,
      amount: "100.00",
      method,
      reference: `PAY-${method}`,
      clientRequestId: `PAY-REQ-${method}`,
    })).rejects.toThrow(POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE);

    await expectNoExternalMoneyTrail();
  });
});
