import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { truncateTables } from "../../services/__tests__/__testUtils__";
import { INBOUND_PAYMENT_DISABLED_MESSAGE } from "@shared/inboundPaymentPolicy";

const API_NON_CASH = ["CARD", "CHECK", "TRANSFER", "WALLET", "TELECOM"] as const;
const ROUTER_CREATABLE_NON_CASH = new Set<string>(["CARD", "TRANSFER", "WALLET"]);
const API_ROLES = ["admin", "manager", "accountant"] as const;
const PARTIES = ["CUSTOMER", "SUPPLIER", "OTHER"] as const;

const TABLES = [
  "digitalWalletTransactions",
  "digitalWallets",
  "digitalProviders",
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "installmentLines",
  "installmentPlans",
  "voucherCategories",
  "shifts",
  "auditLogs",
  "customers",
  "suppliers",
  "users",
  "branches",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function context(role: (typeof API_ROLES)[number], id: number): TrpcContext {
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
      isOwner: role === "admin",
    } as TrpcContext["user"],
  };
}

async function expectNoInboundArtifacts() {
  expect(await db().select().from(s.receipts)).toHaveLength(0);
  expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  expect(await db().select().from(s.idempotencyKeys)).toHaveLength(0);
  expect(await db().select().from(s.installmentLines)).toHaveLength(0);
  expect(await db().select().from(s.digitalWalletTransactions)).toHaveLength(0);
}

async function seedCashFixtures() {
  await db().insert(s.branches).values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values([
    { id: 1, openId: "admin", name: "المالك", role: "admin", loginMethod: "local", branchId: 1, isOwner: true },
    { id: 2, openId: "manager", name: "مدير", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "accountant", name: "محاسب", role: "accountant", loginMethod: "local", branchId: 1 },
  ]);
  await db().insert(s.customers).values({ id: 1, name: "عميل", currentBalance: "500.00" });
  await db().insert(s.suppliers).values({ id: 1, name: "مزوّد المحفظة" });
  await db().insert(s.digitalProviders).values({
    id: 1,
    supplierId: 1,
    providerType: "TELECOM",
    settlementMode: "PREPAID",
    recognitionMode: "PRINCIPAL_GROSS",
    referencePolicy: "OPTIONAL",
    settlementCycle: "ON_DEMAND",
    createdBy: 1,
  });
  await db().insert(s.digitalWallets).values({
    id: 1,
    providerId: 1,
    branchId: 1,
    code: "W1",
    name: "محفظة اختبار",
    currency: "IQD",
    currentBalance: "100.00",
  });
}

beforeEach(async () => {
  await truncateTables(TABLES);
});

describe.sequential("non-POS inbound payment API fail-closed", () => {
  it.each(API_ROLES)("rejects every voucher receipt party/method for %s with zero money trail", async (role) => {
    await seedCashFixtures();
    const caller = appRouter.createCaller(context(role, role === "admin" ? 1 : role === "manager" ? 2 : 3));
    for (const partyType of PARTIES) {
      for (const paymentMethod of API_NON_CASH) {
        const rejection = expect(caller.vouchers.create({
          voucherType: "RECEIPT",
          branchId: 1,
          amount: "100.00",
          paymentMethod: paymentMethod as never,
          partyType,
          partyId: partyType === "OTHER" ? null : 1,
          counterpartyName: partyType === "OTHER" ? "طرف اختباري" : null,
          description: "قبض غير نقدي غير موثّق",
          clientRequestId: `api-${role}-${partyType}-${paymentMethod}`,
        })).rejects;
        if (ROUTER_CREATABLE_NON_CASH.has(paymentMethod)) {
          await rejection.toThrow(INBOUND_PAYMENT_DISABLED_MESSAGE);
        } else {
          // CHECK/TELECOM مغلقان أيضاً عند عقد API قبل بلوغ الخدمة.
          await rejection.toThrow();
        }
      }
    }
    await expectNoInboundArtifacts();
    expect((await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0].currentBalance).toBe("500.00");
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe("0.00");
  });

  it.each(API_ROLES)("rejects installment non-cash collection for %s before line mutation", async (role) => {
    await seedCashFixtures();
    const planRes = await db().insert(s.installmentPlans).values({
      customerId: 1,
      branchId: 1,
      totalAmount: "40.00",
      createdBy: 1,
    });
    const planId = Number((planRes as unknown as [{ insertId: number }])[0].insertId);
    const lineRes = await db().insert(s.installmentLines).values({
      planId,
      seq: 1,
      dueDate: "2026-08-15",
      amount: "40.00",
      kind: "CASH",
    });
    const lineId = Number((lineRes as unknown as [{ insertId: number }])[0].insertId);
    const caller = appRouter.createCaller(context(role, role === "admin" ? 1 : role === "manager" ? 2 : 3));
    for (const paymentMethod of API_NON_CASH) {
      const rejection = expect(caller.installments.pay({ lineId, paymentMethod: paymentMethod as never })).rejects;
      if (ROUTER_CREATABLE_NON_CASH.has(paymentMethod)) {
        await rejection.toThrow(INBOUND_PAYMENT_DISABLED_MESSAGE);
      } else {
        await rejection.toThrow();
      }
    }
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(await db().select().from(s.idempotencyKeys)).toHaveLength(0);
    expect(await db().select().from(s.digitalWalletTransactions)).toHaveLength(0);
    const [line] = await db().select().from(s.installmentLines).where(eq(s.installmentLines.id, lineId));
    expect(line.status).toBe("PENDING");
    expect(line.receiptId).toBeNull();
    expect((await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0].currentBalance).toBe("500.00");
  });

  it.each(["admin", "manager"] as const)("rejects wallet TRANSFER withdrawal for %s before wallet lookup", async (role) => {
    await seedCashFixtures();
    const caller = appRouter.createCaller(context(role, role === "admin" ? 1 : 2));
    await expect(caller.digitalCards.wallets.withdraw({
      walletId: 1,
      amount: "100.00",
      paymentMethod: "TRANSFER",
      clientRequestId: `wallet-api-${role}`,
    })).rejects.toThrow(INBOUND_PAYMENT_DISABLED_MESSAGE);
    await expectNoInboundArtifacts();
    expect((await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, 1)))[0].currentBalance).toBe("100.00");
  });

  it("keeps CASH voucher receipt, installment collection, and wallet withdrawal operational", async () => {
    await seedCashFixtures();
    const caller = appRouter.createCaller(context("admin", 1));

    const voucher = await caller.vouchers.create({
      voucherType: "RECEIPT",
      branchId: 1,
      amount: "50.00",
      paymentMethod: "CASH",
      partyType: "CUSTOMER",
      partyId: 1,
      description: "قبض نقدي صحيح",
      clientRequestId: "cash-voucher-api",
    });
    expect(voucher.approvalStatus).toBe("APPROVED");

    const planRes = await db().insert(s.installmentPlans).values({
      customerId: 1,
      branchId: 1,
      totalAmount: "40.00",
      createdBy: 1,
    });
    const planId = Number((planRes as unknown as [{ insertId: number }])[0].insertId);
    const lineRes = await db().insert(s.installmentLines).values({
      planId,
      seq: 1,
      dueDate: "2026-08-15",
      amount: "40.00",
      kind: "CASH",
    });
    const lineId = Number((lineRes as unknown as [{ insertId: number }])[0].insertId);
    const paid = await caller.installments.pay({ lineId });
    expect(paid.status).toBe("PAID");
    const [installmentAudit] = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.action, "installment.line.pay"));
    expect(installmentAudit.newValue).toMatchObject({ paymentMethod: "CASH" });

    const withdrawn = await caller.digitalCards.wallets.withdraw({
      walletId: 1,
      amount: "25.00",
      paymentMethod: "CASH",
      clientRequestId: "cash-wallet-withdraw-api",
    });
    expect(withdrawn.balanceAfter).toBe("75.00");

    expect(await db().select().from(s.receipts)).toHaveLength(3);
    expect((await db().select().from(s.accountingEntries)).filter((row) => row.entryType === "PAYMENT_IN")).toHaveLength(2);
    expect((await db().select().from(s.accountingEntries)).filter((row) => row.entryType === "DIGITAL_WALLET_WITHDRAWAL")).toHaveLength(1);
    const [customer] = await db().select().from(s.customers).where(eq(s.customers.id, 1));
    expect(customer.currentBalance).toBe("410.00");
    const [line] = await db().select().from(s.installmentLines).where(eq(s.installmentLines.id, lineId));
    expect(line.status).toBe("PAID");
  });
});
