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
import { convertQuotation, createQuotation, setQuotationStatus,
} from "../quotationService";
import {
  confirmExternalPaymentAttempt,
  initiateExternalPaymentAttempt,
} from "../posExternalPayment";
import { payLine } from "../installment/payment";
import { deposit, withdraw } from "../digitalCards/walletOpsService";

const ACTOR = { userId: 1, branchId: 1, role: "admin" } as const;
const CHECKER = { userId: 2, branchId: 1, role: "manager" } as const;

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
    "externalPaymentAttempts",
    "idempotencyKeys", "accountingEntries", "receipts",
    "invoiceItems", "invoices",
    "branchStock", "productPrices", "productUnits", "productVariants", "products",
    "customers", "suppliers", "users", "branches",
  ]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

  await d.insert(s.branches).values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "admin", name: "المالك", role: "admin", loginMethod: "local", branchId: 1, isOwner: true,
  });
  await d.insert(s.users).values({ id: 2, openId: "manager", name: "المدير", role: "manager", loginMethod: "local", branchId: 1 });
  await d.insert(s.customers).values({ id: 1, name: "عميل", currentBalance: "0.00", creditLimit: null });
  await d.insert(s.products).values({ id: 1, name: "دفتر" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NB-1", costPrice: "300.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true,
  });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 50 });
}

async function noMoneyTrail() {
  expect(await db().select().from(s.receipts)).toHaveLength(0);
  expect((await db().select().from(s.accountingEntries)).filter((r) => r.entryType === "PAYMENT_IN",
    ),
  ).toHaveLength(0);
}

async function confirmedCollectionAttempt(amount: string, reference: string) {
  const deviceId = "SALES-COLLECTION-TEST";
  const initiated = await initiateExternalPaymentAttempt(
    {
      branchId: 1,
      channel: "SALES_COLLECTION",
      method: "TRANSFER",
      amount,
      reference,
      requestId: `REQ-${reference}`,
      deviceId,
    },
    ACTOR,
  );
  await confirmExternalPaymentAttempt(
    {
      attemptId: initiated.attemptId,
      branchId: 1,
      channel: "SALES_COLLECTION",
      deviceId,
    },
    ACTOR,
  );
  return { attemptId: initiated.attemptId, deviceId };
}

beforeEach(reset);

describe("تحويل عرض السعر بدفعة غير نقدية", () => {
  async function acceptedQuotation() {
    const q = await createQuotation(
      { branchId: 1, customerId: 1, lines: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "1000.00",
          },
        ],
      },
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
    ),
    ).rejects.toThrow(/أكّد الدفع الخارجي/);
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    await noMoneyTrail();
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(50);
  });

  it("بمرجعه: يُنشئ الفاتورة ويحفظ المرجع بإيصالٍ بلا دلوٍ نقديّ", async () => {
    const quotationId = await acceptedQuotation();
    const attempt = await confirmedCollectionAttempt("1000.00", "TRX-Q-9001");
    const input = { quotationId, payment: { amount: "1000.00", method: "TRANSFER" as const, reference: "TRX-Q-9001",
        externalPaymentAttemptId: attempt.attemptId,
        externalPaymentDeviceId: attempt.deviceId,
      },
    };
    const res = await convertQuotation(input,
      ACTOR);
    expect(res.invoiceId).toBeGreaterThan(0);
    const [receipt] = await db().select().from(s.receipts);
    expect(receipt.paymentMethod).toBe("TRANSFER");
    expect(receipt.referenceNumber).toBe("TRX-Q-9001");
    expect(receipt.cashBucket).toBeNull();
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(49);

    // exact replay: نفس المحاولة تعيد الفاتورة نفسها، ومحاولة مختلفة بالمفتاح الضمني نفسه تُرفض.
    const replay = await convertQuotation(input, ACTOR);
    expect(replay.invoiceId).toBe(res.invoiceId);
    expect(replay.alreadyConverted).toBe(true);
    expect(await db().select().from(s.receipts)).toHaveLength(1);

    const different = await confirmedCollectionAttempt("1000.00", "TRX-Q-9002");
    await expect(
      convertQuotation(
        {
          quotationId,
          payment: {
            ...input.payment,
            reference: "TRX-Q-9002",
            externalPaymentAttemptId: different.attemptId,
            externalPaymentDeviceId: different.deviceId,
          },
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const differentRow = (
      await db()
        .select()
        .from(s.externalPaymentAttempts)
        .where(eq(s.externalPaymentAttempts.id, different.attemptId))
    )[0];
    expect(differentRow.consumedAt).toBeNull();
  });
});

describe("تحصيل القسط بطريقة غير نقدية", () => {
  async function seedLine() {
    await db().insert(s.invoices).values({
      id: 90,
      invoiceNumber: "INST-NONCASH-90",
      sourceType: "POS",
      branchId: 1,
      customerId: 1,
      subtotal: "500.00",
      total: "500.00",
      paidAmount: "0.00",
      returnedTotal: "0.00",
      status: "PENDING",
    });
    const planRes = await db().insert(s.installmentPlans).values({
      customerId: 1,
      invoiceId: 90,
      branchId: 1, totalAmount: "500.00", createdBy: 1,
    });
    const planId = Number((planRes as unknown as [{ insertId: number }])[0].insertId,
    );
    const lineRes = await db().insert(s.installmentLines).values({
      planId, seq: 1, dueDate: "2026-09-01", amount: "500.00", kind: "CASH",
    });
    return Number((lineRes as unknown as [{ insertId: number }])[0].insertId);
  }

  async function confirmedCardAttempt(reference: string) {
    const deviceId = "INSTALLMENT-CARD-TEST";
    const initiated = await initiateExternalPaymentAttempt({
      branchId: 1,
      channel: "SALES_COLLECTION",
      method: "CARD",
      amount: "500.00",
      reference,
      requestId: crypto.randomUUID(),
      deviceId,
      verificationPolicy: "INDEPENDENT_APPROVAL",
      businessBinding: { type: "INSTALLMENT_LINE", id: 1 },
    }, ACTOR);
    await confirmExternalPaymentAttempt({
      attemptId: initiated.attemptId,
      branchId: 1,
      channel: "SALES_COLLECTION",
      deviceId,
      verificationPolicy: "INDEPENDENT_APPROVAL",
      businessBinding: { type: "INSTALLMENT_LINE", id: 1 },
    }, CHECKER);
    return { attemptId: initiated.attemptId, deviceId };
  }

  it("تحويل بلا مرجع يُرفض والقسط يبقى PENDING", async () => {
    const lineId = await seedLine();
    await expect(payLine({ lineId, paymentMethod: "TRANSFER",
          clientRequestId: crypto.randomUUID(),
        }, ACTOR,
      ),
    ).rejects.toThrow(/أكّد الدفع الخارجي/);
    const [line] = await db().select().from(s.installmentLines).where(eq(s.installmentLines.id, lineId));
    expect(line.status).toBe("PENDING");
    await noMoneyTrail();
  });

  it("بطاقة بلا آخر ٤ أرقام تُرفض حتى مع وجود مرجع", async () => {
    const lineId = await seedLine();
    const attempt = await confirmedCardAttempt("AUTH-77");
    await expect(payLine(
      { lineId, paymentMethod: "CARD", referenceNumber: "AUTH-77",
          clientRequestId: crypto.randomUUID(),
          externalPaymentAttemptId: attempt.attemptId,
          deviceId: attempt.deviceId,
        },
      ACTOR,
    ),
    ).rejects.toThrow(/آخر ٤ من البطاقة/);
    await noMoneyTrail();
  });

  it("بطاقة مؤكدة تُستهلك ذرّياً وexact duplicate لا ينشئ إيصالاً ثانياً", async () => {
    const lineId = await seedLine();
    const attempt = await confirmedCardAttempt("AUTH-78");
    const payload = {
      lineId,
      paymentMethod: "CARD" as const,
      referenceNumber: "AUTH-78",
      cardLastFour: "4321",
      clientRequestId: crypto.randomUUID(),
      externalPaymentAttemptId: attempt.attemptId,
      deviceId: attempt.deviceId,
    };
    const [first, duplicate] = await Promise.all([
      payLine(payload, CHECKER),
      payLine(payload, CHECKER),
    ]);
    expect(first.status).toBe("PAID");
    expect(duplicate.receiptId).toBe(first.receiptId);
    const [receipt] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, first.receiptId));
    expect(receipt.paymentMethod).toBe("CARD");
    expect(receipt.referenceNumber).toBe("AUTH-78");
    expect(receipt.cashBucket).toBeNull();
    expect(await db().select().from(s.receipts)).toHaveLength(1);
    const [consumed] = await db()
      .select()
      .from(s.externalPaymentAttempts)
      .where(eq(s.externalPaymentAttempts.id, attempt.attemptId));
    expect(Number(consumed.invoiceId)).toBe(90);
    expect(Number(consumed.receiptId)).toBe(first.receiptId);
    expect(consumed.consumedAt).toBeTruthy();
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
    }, ACTOR,
        ),
      ),
    ).rejects.toThrow(/مرجع الحوالة/);
    expect((await db().select().from(s.digitalWallets))[0].currentBalance).toBe("1000.00",
    );
    await noMoneyTrail();
  });

  it("الإيداع بالتحويل يخضع للقاعدة نفسها — بلا مرجع يُرفض، وبمرجعه يُحفَظ", async () => {
    await seedWallet();
    await expect(withTx((tx) => deposit(tx, {
      walletId: 1, amount: "200.00", paymentMethod: "TRANSFER", clientRequestId: "d-no-ref-0001",
    }, ACTOR,
        ),
      ),
    ).rejects.toThrow(/مرجع الحوالة/);

    const res = await withTx((tx) => deposit(tx, {
      walletId: 1, amount: "200.00", paymentMethod: "TRANSFER",
      referenceNumber: "BANK-DEP-7788", clientRequestId: "d-with-ref-0001",
    }, ACTOR,
      ),
    );
    expect(res.receiptId).toBeGreaterThan(0);
    const [receipt] = await db().select().from(s.receipts).where(eq(s.receipts.id, res.receiptId));
    expect(receipt.referenceNumber).toBe("BANK-DEP-7788");
    expect(receipt.cashBucket).toBeNull();
  });

  it("بمرجع الحوالة: يُسحَب ويُحفَظ المرجع البنكيّ لا المعرّف الداخليّ", async () => {
    await seedWallet();
    const res = await withTx((tx) => withdraw(tx, {
      walletId: 1, amount: "100.00", paymentMethod: "TRANSFER",
      referenceNumber: "BANK-TRX-5150", clientRequestId: "w-with-ref-0001",
    }, ACTOR,
      ),
    );
    expect(res.balanceAfter).toBe("900.00");
    const [receipt] = await db().select().from(s.receipts);
    expect(receipt.referenceNumber).toBe("BANK-TRX-5150");
    expect(receipt.referenceNumber).not.toBe("w-with-ref-0001");
    expect(receipt.cashBucket).toBeNull();
  });
});
