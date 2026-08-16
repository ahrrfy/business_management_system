/**
 * الشاشات التي كانت نقديّةً قسراً: تحويل عرض السعر، تحصيل القسط، سحب المحفظة.
 *
 * فُتحت لغير النقد بعد تمرير **إثباتها** حتى القيد. هذا الملف يحرس الطرفين معاً:
 *   ١) الإثبات ناقصاً ⇒ رفضٌ بلا أيّ أثرٍ ماليّ (لا إيصال، لا قيد، لا تغيّر رصيد).
 *   ٢) الإثبات كاملاً ⇒ قبضٌ صحيح بمرجعه **بلا دلوٍ نقديّ** (§٥: غير النقد لا يَمسّ صندوقاً).
 * وبذلك لا يعود «فتح الطريقة» مرادفاً لإضعاف الأثر.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { convertQuotation, createQuotation, setQuotationStatus } from "../quotationService";
import { payLine } from "../installment/payment";
import { withdraw } from "../digitalCards/walletOpsService";

const ACTOR = { userId: 1, branchId: 1, role: "admin" } as const;

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "digitalWalletTransactions", "digitalWallets", "digitalProviders",
    "installmentLines", "installmentPlans",
    "quotationItems", "quotations",
    "idempotencyKeys", "accountingEntries", "receipts",
    "invoiceItems", "invoices",
    "branchStock", "productPrices", "productUnits", "productVariants", "products",
    "customers", "suppliers", "users", "branches",
  ]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

  await d.insert(s.branches).values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "admin", name: "المالك", role: "admin", loginMethod: "local", branchId: 1, isOwner: true });
  await d.insert(s.customers).values({ id: 1, name: "عميل", currentBalance: "0.00", creditLimit: null });
  await d.insert(s.products).values({ id: 1, name: "دفتر" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NB-1", costPrice: "300.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 50 });
}

async function noMoneyTrail() {
  expect(await db().select().from(s.receipts)).toHaveLength(0);
  expect((await db().select().from(s.accountingEntries)).filter((r) => r.entryType === "PAYMENT_IN")).toHaveLength(0);
}

beforeEach(reset);

describe("تحويل عرض السعر بدفعة غير نقدية", () => {
  async function acceptedQuotation() {
    const q = await createQuotation(
      { branchId: 1, customerId: 1, lines: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "1000.00" }] },
      ACTOR,
    );
    await setQuotationStatus(q.quotationId, "ACCEPTED", ACTOR);
    return q.quotationId;
  }

  it("بلا مرجع: يُرفض ولا يخلّف فاتورة ولا إيصالاً ولا يمسّ المخزون", async () => {
    const quotationId = await acceptedQuotation();
    await expect(convertQuotation(
      { quotationId, payment: { amount: "1000.00", method: "TRANSFER" } },
      ACTOR,
    )).rejects.toThrow(/مرجع/);
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    await noMoneyTrail();
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(50);
  });

  it("بمرجعه: يُنشئ الفاتورة ويحفظ المرجع بإيصالٍ بلا دلوٍ نقديّ", async () => {
    const quotationId = await acceptedQuotation();
    const res = await convertQuotation(
      { quotationId, payment: { amount: "1000.00", method: "TRANSFER", reference: "TRX-Q-9001" } },
      ACTOR,
    );
    expect(res.invoiceId).toBeGreaterThan(0);
    const [receipt] = await db().select().from(s.receipts);
    expect(receipt.paymentMethod).toBe("TRANSFER");
    expect(receipt.referenceNumber).toBe("TRX-Q-9001");
    expect(receipt.cashBucket).toBeNull();
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(49);
  });
});

describe("تحصيل القسط بطريقة غير نقدية", () => {
  async function seedLine() {
    const planRes = await db().insert(s.installmentPlans).values({
      customerId: 1, branchId: 1, totalAmount: "500.00", createdBy: 1,
    });
    const planId = Number((planRes as unknown as [{ insertId: number }])[0].insertId);
    const lineRes = await db().insert(s.installmentLines).values({
      planId, seq: 1, dueDate: "2026-09-01", amount: "500.00", kind: "CASH",
    });
    return Number((lineRes as unknown as [{ insertId: number }])[0].insertId);
  }

  it("تحويل بلا مرجع يُرفض والقسط يبقى PENDING", async () => {
    const lineId = await seedLine();
    await expect(payLine({ lineId, paymentMethod: "TRANSFER" }, ACTOR)).rejects.toThrow();
    const [line] = await db().select().from(s.installmentLines).where(eq(s.installmentLines.id, lineId));
    expect(line.status).toBe("PENDING");
    await noMoneyTrail();
  });

  it("بطاقة بلا آخر ٤ أرقام تُرفض حتى مع وجود مرجع", async () => {
    const lineId = await seedLine();
    await expect(payLine(
      { lineId, paymentMethod: "CARD", referenceNumber: "AUTH-77" },
      ACTOR,
    )).rejects.toThrow(/آخر ٤ من البطاقة/);
    await noMoneyTrail();
  });

  it("بطاقة بمرجعها وآخر ٤ أرقام: يُسدَّد بإيصالٍ بلا دلوٍ نقديّ", async () => {
    const lineId = await seedLine();
    const res = await payLine(
      { lineId, paymentMethod: "CARD", referenceNumber: "AUTH-77", cardLastFour: "4321" },
      ACTOR,
    );
    expect(res.status).toBe("PAID");
    const [receipt] = await db().select().from(s.receipts).where(eq(s.receipts.id, res.receiptId));
    expect(receipt.paymentMethod).toBe("CARD");
    expect(receipt.referenceNumber).toBe("AUTH-77");
    expect(receipt.cashBucket).toBeNull();
  });
});

describe("سحب رصيد المحفظة الرقمية بالتحويل", () => {
  async function seedWallet() {
    await db().insert(s.suppliers).values({ id: 1, name: "مزوّد" });
    await db().insert(s.digitalProviders).values({
      id: 1, supplierId: 1, providerType: "TELECOM", settlementMode: "PREPAID",
      recognitionMode: "PRINCIPAL_GROSS", referencePolicy: "OPTIONAL", settlementCycle: "ON_DEMAND", createdBy: 1,
    });
    await db().insert(s.digitalWallets).values({
      id: 1, providerId: 1, branchId: 1, code: "W1", name: "محفظة", currency: "IQD", currentBalance: "1000.00",
    });
  }

  it("تحويل بلا مرجع الحوالة يُرفض والرصيد لا يتغيّر", async () => {
    await seedWallet();
    await expect(withTx((tx) => withdraw(tx, {
      walletId: 1, amount: "100.00", paymentMethod: "TRANSFER", clientRequestId: "w-no-ref-0001",
    }, ACTOR))).rejects.toThrow(/مرجع الحوالة/);
    expect((await db().select().from(s.digitalWallets))[0].currentBalance).toBe("1000.00");
    await noMoneyTrail();
  });

  it("بمرجع الحوالة: يُسحَب ويُحفَظ المرجع البنكيّ لا المعرّف الداخليّ", async () => {
    await seedWallet();
    const res = await withTx((tx) => withdraw(tx, {
      walletId: 1, amount: "100.00", paymentMethod: "TRANSFER",
      referenceNumber: "BANK-TRX-5150", clientRequestId: "w-with-ref-0001",
    }, ACTOR));
    expect(res.balanceAfter).toBe("900.00");
    const [receipt] = await db().select().from(s.receipts);
    expect(receipt.referenceNumber).toBe("BANK-TRX-5150");
    expect(receipt.referenceNumber).not.toBe("w-with-ref-0001");
    expect(receipt.cashBucket).toBeNull();
  });
});
