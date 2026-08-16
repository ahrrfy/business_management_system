import { beforeEach, describe, expect, it } from "vitest";
import { appRouter } from "../../routers";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import * as s from "../../../drizzle/schema";
import { INBOUND_TELECOM_DISABLED_MESSAGE } from "@shared/inboundPaymentPolicy";
import { truncateTables } from "../../services/__tests__/__testUtils__";

/**
 * العقد الحاكم: الدفع غير النقدي **لا يُقفل**، بل يُشترط له أثرٌ خادميّ مؤكَّد
 * (`externalPaymentAttempts` بحالة CONFIRMED) يُستهلَك مرّةً واحدة مع الفاتورة.
 * ما يبقى مرفوضاً بنيوياً: رصيد زين (TELECOM) — مساره شاشة البطاقات الرقمية.
 */
const ATTEMPT_METHODS = ["CARD", "CHECK", "TRANSFER", "WALLET"] as const;

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
  expect(await db().select().from(s.invoices)).toHaveLength(0);
  expect(await db().select().from(s.receipts)).toHaveLength(0);
  expect((await db().select().from(s.accountingEntries)).filter((row) => row.entryType === "PAYMENT_IN")).toHaveLength(0);
}

beforeEach(async () => {
  await truncateTables(["externalPaymentAttempts", "accountingEntries", "receipts", "invoiceItems", "invoices"]);
});

describe("عقد الدفع الخارجي على حدود الـAPI", () => {
  it("رصيد زين مرفوض في كل منافذ القبض قبل أي كتابة", async () => {
    const cashier = appRouter.createCaller(context("cashier", 10));
    const owner = appRouter.createCaller(context("admin", 11));
    const input = {
      branchId: 1,
      method: "TELECOM" as never,
      amount: "100.00",
      reference: "REF-TELECOM",
      requestId: "REQ-TELECOM",
      deviceId: "API-POS-1",
    };

    await expect(cashier.sales.initiateExternalPayment(input)).rejects.toThrow();
    await expect(owner.printPos.initiateExternalPayment(input)).rejects.toThrow();
    expect(await db().select().from(s.externalPaymentAttempts)).toHaveLength(0);
    await expectNoExternalMoneyTrail();
    expect(INBOUND_TELECOM_DISABLED_MESSAGE).toMatch(/رصيد زين/);
  });

  it.each(ATTEMPT_METHODS)("بيع %s بلا محاولة مؤكَّدة يُرفض على حدود المخطَّط", async (method) => {
    const owner = appRouter.createCaller(context("admin", 11));
    const payment = { amount: "100.00", method };

    await expect(owner.sales.create({
      branchId: 1,
      sourceType: "POS",
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      payment,
      clientRequestId: `SALE-${method}`,
    } as never)).rejects.toThrow(/أكّد الدفع الخارجي قبل إتمام البيع/);

    await expect(owner.printPos.createSale({
      branchId: 1,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "100.00" }],
      payment,
      clientRequestId: `PRINT-${method}`,
    } as never)).rejects.toThrow(/أكّد الدفع الخارجي قبل إتمام البيع/);

    await expectNoExternalMoneyTrail();
  });

  it.each(ATTEMPT_METHODS)("محاولة %s ملفّقة (غير موجودة) لا تُنتج فاتورةً ولا قبضاً", async (method) => {
    const owner = appRouter.createCaller(context("admin", 11));

    await expect(owner.sales.create({
      branchId: 1,
      sourceType: "POS",
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      payment: { amount: "100.00", method, externalPaymentAttemptId: 999_999 },
      clientRequestId: `FORGED-${method}`,
    } as never)).rejects.toThrow();

    await expectNoExternalMoneyTrail();
  });

  it("تحصيل دفعة لاحقة غير نقدية بلا مرجع يُرفض، ورصيد زين مرفوض دائماً", async () => {
    const owner = appRouter.createCaller(context("admin", 11));

    await expect(owner.sales.pay({
      invoiceId: 1,
      amount: "100.00",
      method: "CARD",
      clientRequestId: "PAY-NO-REF",
    })).rejects.toThrow(/مرجع عملية البطاقة\/التحويل مطلوب/);

    await expect(owner.sales.pay({
      invoiceId: 1,
      amount: "100.00",
      method: "TELECOM" as never,
      reference: "X1",
      clientRequestId: "PAY-TELECOM",
    })).rejects.toThrow();

    await expectNoExternalMoneyTrail();
  });
});
